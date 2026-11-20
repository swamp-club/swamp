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
import { basename, dirname, join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { assertCompletes, assertErrors, collect } from "../testing.ts";
import {
  hostedWorkspaceCreate,
  type HostedWorkspaceCreateEvent,
} from "./create.ts";
import type { HostedWorkspace } from "../../domain/serve/hosted_workspace.ts";
import type {
  HostedWorkspaceDeps,
  HostedWorkspaceProvisionSpec,
} from "./deps.ts";
import {
  ALICE,
  ctx,
  entries,
  hostFolder,
  markerProvisioner,
  type NoFolderHost,
  noFolderHost,
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

Deno.test("hostedWorkspaceCreate: a name the registry holds is taken, wherever its folder is", async () => {
  await using host = await hostFolder();
  await host.store.registry.update((registry) => {
    registry.register({
      name: "mine",
      path: join(host.dir, "..", "projects", "mine"),
      createdAt: "2026-11-17T10:00:00.000Z",
    });
  });
  await assertErrors<HostedWorkspaceCreateEvent>(
    hostedWorkspaceCreate(ctx, host.deps(), {
      name: "mine",
      caller: ALICE,
      access: OAUTH_ACCESS,
    }),
    "already_exists",
  );
  assertEquals(await entries(host.dir), []);
});

Deno.test("hostedWorkspaceCreate: an entry left for workspaces/<name> by a folder removed while the host was stopped does not hold the name", async () => {
  await using host = await hostFolder();
  const spot = join(await Deno.realPath(host.dir), "alpha");
  await host.store.registry.update((registry) => {
    registry.register({
      name: "alpha",
      path: spot,
      createdAt: "2026-11-17T10:00:00.000Z",
    });
  });
  await assertCompletes<HostedWorkspaceCreateEvent>(
    hostedWorkspaceCreate(ctx, host.deps(), {
      name: "alpha",
      caller: ALICE,
      access: OAUTH_ACCESS,
    }),
    {
      kind: "completed",
      data: {
        name: "alpha",
        address: "https://host.example/w/alpha",
        wanted: "suspended",
      },
    },
  );
  assertEquals(
    (await host.store.registry.load())?.list().map((e) => [e.name, e.path]),
    [["alpha", spot]],
  );
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

Deno.test("hostedWorkspaceCreate: registers the workspace it made at its real path, as an import would", async () => {
  await using host = await hostFolder();
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
  const entry = (await host.store.registry.load())?.get("edge-dns");
  assertEquals(entry?.path, await Deno.realPath(join(host.dir, "edge-dns")));
  assertEquals(entry?.origin, "imported");
  assertEquals(entry?.trustedAt, undefined);
});

Deno.test("hostedWorkspaceCreate: a registry it cannot write still completes the create, and a failed create registers nothing", async () => {
  await using host = await hostFolder();
  const deps = host.deps({
    workspaceStore: {
      ...host.store,
      registry: {
        load: () => host.store.registry.load(),
        update: () => Promise.reject(new Error("lock timed out")),
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
  assertEquals(await entries(host.dir), ["edge-dns", "edge-dns.wanted.yaml"]);

  await assertErrors<HostedWorkspaceCreateEvent>(
    hostedWorkspaceCreate(
      ctx,
      host.deps({
        provisioner: { provision: () => Promise.reject(new Error("no")) },
      }),
      { name: "other", caller: ALICE, access: OAUTH_ACCESS },
    ),
    "provision_failed",
  );
  assertEquals(await host.store.registry.load(), null);
});

Deno.test("hostedWorkspaceCreate: with no host folder, sets up in a hidden folder, writes the wanted file with its folder, registers, then renames into place", async () => {
  await using host = await noFolderHost();
  const base = host.deps();
  const steps: string[] = [];
  // the location exists once create has made it
  const realTarget = async () =>
    join(await Deno.realPath(host.location), "edge-dns");
  const deps = host.deps({
    provisioner: {
      async provision(dir, spec, signal) {
        assertEquals(dirname(dir), await Deno.realPath(host.location));
        assert(basename(dir).startsWith(".edge-dns.creating-"), dir);
        steps.push("set up");
        await markerProvisioner.provision(dir, spec, signal);
      },
    },
    repository: {
      findByName: (n) => base.repository.findByName(n),
      remove: (n) => base.repository.remove(n),
      async save(workspace: HostedWorkspace) {
        assertEquals(workspace.folder, await realTarget());
        steps.push("wanted file");
        await base.repository.save(workspace);
      },
    },
    workspaceStore: {
      ...host.store,
      registry: {
        load: () => host.store.registry.load(),
        async update(fn) {
          const result = await host.store.registry.update(fn);
          if ((await host.store.registry.load())?.get("edge-dns")) {
            steps.push("registered");
          }
          return result;
        },
      },
    },
    rename: async (from, to) => {
      assertEquals(to, await realTarget());
      steps.push("renamed");
      await Deno.rename(from, to);
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
  assertEquals(steps, ["set up", "wanted file", "registered", "renamed"]);
  assertEquals(await entries(host.location), ["edge-dns"]);
  const wanted = parseYaml(
    await Deno.readTextFile(join(host.dir, "edge-dns.wanted.yaml")),
  ) as Record<string, unknown>;
  assertEquals(wanted.creator, ALICE.principal);
  assertEquals(wanted.wanted, "suspended");
  assertEquals(wanted.folder, await realTarget());
  const entry = (await host.store.registry.load())?.get("edge-dns");
  assertEquals(entry?.path, await realTarget());
  assertEquals(entry?.origin, "created");
  assertEquals(entry?.trustedAt, undefined);
});

Deno.test("hostedWorkspaceCreate: with no host folder and workspaces.dir set, the repo goes there", async () => {
  await using host = await noFolderHost();
  const chosen = join(host.root, "projects");
  await Deno.mkdir(chosen);
  host.configured = await Deno.realPath(chosen);
  await collect(
    hostedWorkspaceCreate(ctx, host.deps(), {
      name: "edge-dns",
      caller: ALICE,
      access: OAUTH_ACCESS,
    }),
  );
  assertEquals(await entries(chosen), ["edge-dns"]);
  assertEquals(
    (await host.store.registry.load())?.get("edge-dns")?.path,
    join(host.configured, "edge-dns"),
  );
});

Deno.test("hostedWorkspaceCreate: with no host folder, a failure at each step leaves no folder, no wanted file and no entry", async () => {
  const fail = () => Promise.reject(new Error("stopped"));
  const failures: Record<
    string,
    (host: NoFolderHost) => Partial<HostedWorkspaceDeps>
  > = {
    "set-up": () => ({ provisioner: { provision: fail } }),
    "wanted file": (host) => {
      const base = host.deps();
      return {
        repository: {
          findByName: (n) => base.repository.findByName(n),
          remove: (n) => base.repository.remove(n),
          save: fail,
        },
      };
    },
    "rename": () => ({ rename: fail }),
  };
  for (const [step, overrides] of Object.entries(failures)) {
    await using host = await noFolderHost();
    const events = await collect(
      hostedWorkspaceCreate(ctx, host.deps(overrides(host)), {
        name: "edge-dns",
        caller: ALICE,
        access: OAUTH_ACCESS,
      }),
    );
    assertEquals(events.map((e) => e.kind), ["error"], step);
    const error = events[0];
    assert(error.kind === "error");
    assert(!error.error.message.includes(host.root), `${step}: no host path`);
    assertEquals(await entries(host.location), [], step);
    assertEquals(await entries(host.dir), [], step);
    assertEquals(
      (await host.store.registry.load())?.get("edge-dns"),
      undefined,
      step,
    );
  }
});

Deno.test("hostedWorkspaceCreate: with no host folder, a name or folder already taken is refused naming no host path, touching nothing", async () => {
  await using host = await noFolderHost();
  const elsewhere = join(host.root, "projects", "taken");
  await Deno.mkdir(elsewhere, { recursive: true });
  await host.store.registry.update((registry) => {
    registry.register({
      name: "taken",
      path: elsewhere,
      createdAt: "2026-11-17T10:00:00.000Z",
      origin: "imported",
    });
  });
  // a repo in the location that no entry names
  await Deno.mkdir(join(host.location, "loose"), { recursive: true });
  await Deno.writeTextFile(join(host.location, "loose", ".swamp.yaml"), "");
  for (const name of ["taken", "loose"]) {
    const events = await collect(
      hostedWorkspaceCreate(ctx, host.deps(), {
        name,
        caller: ALICE,
        access: OAUTH_ACCESS,
      }),
    );
    const error = events.find((e) => e.kind === "error");
    assert(error?.kind === "error", name);
    assertEquals(error.error.code, "already_exists");
    assert(!error.error.message.includes(host.root), `${name}: no host path`);
  }
  assertEquals(await entries(host.location), ["loose"]);
  assertEquals(await entries(join(host.location, "loose")), [".swamp.yaml"]);
  assertEquals(await entries(host.dir), []);
});

Deno.test("hostedWorkspaceCreate: with no host folder and no workspace location, create fails as a host error, making nothing", async () => {
  await using host = await noFolderHost();
  const events = await collect(
    hostedWorkspaceCreate(ctx, host.deps({ placement: null }), {
      name: "edge-dns",
      caller: ALICE,
      access: OAUTH_ACCESS,
    }),
  );
  const error = events.find((e) => e.kind === "error");
  assertEquals(error?.kind === "error" ? error.error.code : null, "host_error");
  assertEquals(await entries(host.dir), []);
});
