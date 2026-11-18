// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { assertCompletes, assertErrors } from "../testing.ts";
import {
  hostedWorkspaceCreate,
  type HostedWorkspaceCreateEvent,
} from "./create.ts";
import type { HostedWorkspaceProvisionSpec } from "./deps.ts";
import {
  ALICE,
  ctx,
  entries,
  hostFolder,
  OAUTH_ACCESS,
} from "./hosted_workspace_test_helpers.ts";

Deno.test("hostedWorkspaceCreate: sets the repo up, records the creator and renames it into place", async () => {
  await using host = await hostFolder();
  let spec: HostedWorkspaceProvisionSpec | undefined;
  const deps = host.deps({
    provisioner: {
      async provision(dir, given) {
        spec = given;
        assert(dir.includes(".edge-dns.creating-"), dir);
        await Deno.writeTextFile(join(dir, ".swamp.yaml"), "");
      },
    },
  });
  await assertCompletes<HostedWorkspaceCreateEvent>(
    hostedWorkspaceCreate(ctx, deps, {
      name: "edge-dns",
      caller: ALICE,
      access: OAUTH_ACCESS,
    }),
    {
      kind: "completed",
      data: {
        name: "edge-dns",
        address: "https://host.example/w/edge-dns",
        wanted: "suspended",
      },
    },
  );
  assertEquals(spec?.admin, "alice");
  assertEquals(spec?.adminSubject, "sub-alice");
  assertEquals(await entries(host.dir), ["edge-dns", "edge-dns.wanted.yaml"]);
  const wanted = parseYaml(
    await Deno.readTextFile(join(host.dir, "edge-dns.wanted.yaml")),
  ) as Record<string, unknown>;
  assertEquals(wanted.wanted, "suspended");
  assertEquals(wanted.creator, "user:sub-alice");
  assertEquals(typeof wanted.changedAt, "string");
});

Deno.test("hostedWorkspaceCreate: token mode names the caller's principal; none mode names no admin", async () => {
  for (
    const [mode, admin] of [["token", "user:alice"], ["none", null]] as const
  ) {
    await using host = await hostFolder();
    let spec: HostedWorkspaceProvisionSpec | undefined;
    const deps = host.deps({
      provisioner: {
        async provision(dir, given) {
          spec = given;
          await Deno.writeTextFile(join(dir, ".swamp.yaml"), "");
        },
      },
    });
    const events = hostedWorkspaceCreate(ctx, deps, {
      name: "edge-dns",
      caller: { principal: "user:alice", username: null },
      access: { ...OAUTH_ACCESS, mode, oauthProvider: null },
    });
    await assertCompletes<HostedWorkspaceCreateEvent>(events, {
      kind: "completed",
      data: {
        name: "edge-dns",
        address: "https://host.example/w/edge-dns",
        wanted: "suspended",
      },
    });
    assertEquals(spec?.admin, admin);
    assertEquals(spec?.adminSubject, null);
  }
});

Deno.test("hostedWorkspaceCreate: refuses an invalid name, and an oauth caller without a plain username, touching nothing", async () => {
  await using host = await hostFolder();
  await assertErrors<HostedWorkspaceCreateEvent>(
    hostedWorkspaceCreate(ctx, host.deps(), {
      name: "Bad_Name",
      caller: ALICE,
      access: OAUTH_ACCESS,
    }),
    "user_error",
  );
  for (const username of [null, "", "group:ops"]) {
    await assertErrors<HostedWorkspaceCreateEvent>(
      hostedWorkspaceCreate(ctx, host.deps(), {
        name: "edge-dns",
        caller: { ...ALICE, username },
        access: OAUTH_ACCESS,
      }),
      "username_unknown",
    );
  }
  for (const username of ["ops", null]) {
    await assertErrors<HostedWorkspaceCreateEvent>(
      hostedWorkspaceCreate(ctx, host.deps(), {
        name: "edge-dns",
        caller: { principal: "collective:ops", username },
        access: OAUTH_ACCESS,
      }),
      "not_a_user",
    );
  }
  assertEquals(await entries(host.dir), []);
});

Deno.test("hostedWorkspaceCreate: a failed set-up leaves nothing under the name and names no host path", async () => {
  await using host = await hostFolder();
  const deps = host.deps({
    provisioner: {
      async provision(dir) {
        await Deno.writeTextFile(join(dir, "half-done"), "");
        throw new Error(`could not write ${dir}/.swamp.yaml`);
      },
    },
  });
  const error = await assertErrors<HostedWorkspaceCreateEvent>(
    hostedWorkspaceCreate(ctx, deps, {
      name: "edge-dns",
      caller: ALICE,
      access: OAUTH_ACCESS,
    }),
    "provision_failed",
  );
  assertEquals(error.message.includes(host.dir), false);
  assertStringIncludes(String(error.cause?.cause), host.dir);
  assertEquals(await entries(host.dir), []);
});

Deno.test("hostedWorkspaceCreate: a failure after the wanted file is written removes it too", async () => {
  await using host = await hostFolder();
  const base = host.deps();
  // a folder appears at the name while the repo is set up, so the rename fails
  const deps = host.deps({
    provisioner: {
      async provision(dir) {
        await Deno.writeTextFile(join(dir, ".swamp.yaml"), "");
        await Deno.mkdir(join(host.dir, "edge-dns", "inside"), {
          recursive: true,
        });
      },
    },
    repository: base.repository,
  });
  await assertErrors<HostedWorkspaceCreateEvent>(
    hostedWorkspaceCreate(ctx, deps, {
      name: "edge-dns",
      caller: ALICE,
      access: OAUTH_ACCESS,
    }),
    "already_exists",
  );
  assertEquals(await entries(host.dir), ["edge-dns"]);
  assertEquals(await entries(join(host.dir, "edge-dns")), ["inside"]);
});

Deno.test("hostedWorkspaceCreate: a folder, a link or a wanted file makes the name taken", async () => {
  const setups: [string, (dir: string) => Promise<void>][] = [
    ["folder", (dir) => Deno.mkdir(join(dir, "edge-dns"))],
    ["file", (dir) => Deno.writeTextFile(join(dir, "edge-dns"), "")],
    [
      "dangling link",
      (dir) =>
        Deno.symlink(join(dir, "nowhere"), join(dir, "edge-dns"), {
          type: "dir",
        }),
    ],
    [
      "wanted file",
      (dir) =>
        Deno.writeTextFile(
          join(dir, "edge-dns.wanted.yaml"),
          "wanted: suspended\n",
        ),
    ],
    [
      "unreadable wanted file",
      (dir) => Deno.writeTextFile(join(dir, "edge-dns.wanted.yaml"), "{"),
    ],
  ];
  for (const [label, setup] of setups) {
    await using host = await hostFolder();
    await setup(host.dir);
    const before = await entries(host.dir);
    const error = await assertErrors<HostedWorkspaceCreateEvent>(
      hostedWorkspaceCreate(ctx, host.deps(), {
        name: "edge-dns",
        caller: ALICE,
        access: OAUTH_ACCESS,
      }),
      "already_exists",
    );
    assertStringIncludes(error.message, "taken", label);
    assertEquals(await entries(host.dir), before, label);
  }
});

Deno.test("hostedWorkspaceCreate: removes a set-up folder an earlier create left behind", async () => {
  await using host = await hostFolder();
  const leftover = `.edge-dns.creating-${crypto.randomUUID()}`;
  await Deno.mkdir(join(host.dir, leftover));
  const other = `.edge-dns-2.creating-${crypto.randomUUID()}`;
  await Deno.mkdir(join(host.dir, other));
  await assertCompletes<HostedWorkspaceCreateEvent>(
    hostedWorkspaceCreate(ctx, host.deps(), {
      name: "edge-dns",
      caller: ALICE,
      access: OAUTH_ACCESS,
    }),
    {
      kind: "completed",
      data: {
        name: "edge-dns",
        address: "https://host.example/w/edge-dns",
        wanted: "suspended",
      },
    },
  );
  assertEquals(
    await entries(host.dir),
    [other, "edge-dns", "edge-dns.wanted.yaml"].sort(),
  );
});
