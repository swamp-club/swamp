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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { Command } from "@cliffy/command";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { withMockedEnv } from "../../infrastructure/persistence/path_test_helpers.ts";
import { FEDERATION_GATE_VARIABLE } from "../../domain/serve/federation_gate.ts";
import { UserError } from "../../domain/errors.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../../libswamp/repo/init.ts";
import { collect } from "../../libswamp/testing.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import { serveMemberCommand } from "./serve_member.ts";
import { withLocalHubForMember } from "./serve_member_local.ts";
import { sampleFingerprint } from "../../domain/serve/federation_test_helpers.ts";
import { InstanceId } from "../../domain/serve/instance_id.ts";
import { MemberCredential } from "../../domain/serve/member_credential.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

const VERSION = "20261126.120000.0";
const HUB_YAML = "version: 2\nfederation:\n  role: hub\n  name: central\n";

async function withRepo(
  serveYaml: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-serve-member-" });
  try {
    const events = await collect(
      repoInit(createLibSwampContext(), createRepoInitDeps(VERSION), {
        path: dir,
        force: false,
        version: VERSION,
        tools: [],
      }),
    );
    assertEquals(events.some((event) => event.kind === "error"), false);
    await Deno.writeTextFile(join(dir, ".swamp", "serve.yaml"), serveYaml);
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function runJson(
  gate: string | undefined,
  args: string[],
): Promise<unknown> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    await withMockedEnv(
      { [FEDERATION_GATE_VARIABLE]: gate },
      () =>
        new Command()
          .throwErrors()
          .globalOption("--json", "JSON output")
          .command("member", serveMemberCommand)
          .parse(["member", ...args, "--json"]),
    );
  } finally {
    console.log = originalLog;
  }
  return JSON.parse(logs[logs.length - 1]);
}

Deno.test("serveMemberCommand: lists, gets and removes members, and manages join tokens", () => {
  assertEquals(
    serveMemberCommand.getCommands().map((c) => c.getName()),
    ["list", "get", "remove", "token"],
  );
  const token = serveMemberCommand.getCommand("token")!;
  assertEquals(
    token.getCommands().map((c) => c.getName()),
    ["create", "list", "revoke"],
  );
  for (const command of [...serveMemberCommand.getCommands(), token]) {
    for (const sub of [command, ...command.getCommands()]) {
      if (sub.getName() === "token") continue;
      assert(sub.getOption("server"), `${sub.getName()} takes --server`);
    }
  }
});

Deno.test("serve member: local mode refuses unless the gate is on and serve.yaml is a version 2 hub", async () => {
  await withRepo(HUB_YAML, async (dir) => {
    await assertRejects(
      () => runJson(undefined, ["token", "list", "--repo-dir", dir]),
      UserError,
      "not a federation hub",
    );
  });
  await withRepo("port: 9090\n", async (dir) => {
    await assertRejects(
      () => runJson("1", ["list", "--repo-dir", dir]),
      UserError,
      "not a federation hub",
    );
  });
});

Deno.test("serve member: local mode refuses a v2 custom datastore, whose control plane serve keeps remotely", async () => {
  const type = `test-member-store-${crypto.randomUUID()}`;
  datastoreTypeRegistry.register({
    type,
    name: "Test member store",
    description: "A custom datastore for the local member refusal",
    isBuiltIn: false,
    createProvider: () => ({
      createLock: () => ({}),
      createVerifier: () => ({}),
      resolveDatastorePath: (repoDir: string) => repoDir,
    }),
  } as never);
  try {
    await withRepo(HUB_YAML, async (dir) => {
      const path = join(dir, ".swamp.yaml");
      const existing = await Deno.readTextFile(path);
      await Deno.writeTextFile(
        path,
        `${existing.trimEnd()}\ndatastore:\n  type: '${type}'\n  config:\n    bucket: b\n`,
      );
      for (
        const args of [
          ["token", "create", "edge-1"],
          ["token", "list"],
          ["token", "revoke", "edge-1"],
          ["list"],
          ["get", "edge-1"],
          ["remove", "edge-1"],
        ]
      ) {
        await assertRejects(
          () => runJson("1", [...args, "--repo-dir", dir]),
          UserError,
          "shared control-plane store. Pass --server",
          args.join(" "),
        );
      }
    });
  } finally {
    datastoreTypeRegistry.invalidateType(type);
  }
});

Deno.test({
  name:
    "serve member token: on a gated hub, local create prints the token once, list shows it unused, revoke ends it",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withRepo(HUB_YAML, async (dir) => {
      const created = await runJson("1", [
        "token",
        "create",
        "edge-1",
        "--duration",
        "2h",
        "--repo-dir",
        dir,
      ]) as { token: Record<string, unknown>; joinToken: string };
      assert(created.joinToken.startsWith("edge-1."));
      assertEquals(
        Date.parse(created.token.expiresAt as string) -
          Date.parse(created.token.createdAt as string),
        2 * 60 * 60 * 1000,
      );

      const listed = await runJson("1", [
        "token",
        "list",
        "--repo-dir",
        dir,
      ]) as { tokens: Array<Record<string, unknown>> };
      assertEquals(listed.tokens.map((t) => [t.memberName, t.state]), [
        ["edge-1", "unused"],
      ]);
      assertEquals(JSON.stringify(listed).includes(created.joinToken), false);

      const revoked = await runJson("1", [
        "token",
        "revoke",
        "edge-1",
        "--repo-dir",
        dir,
      ]) as { token: Record<string, unknown> };
      assertEquals(revoked.token.state, "revoked");

      await assertRejects(
        () =>
          runJson("1", [
            "token",
            "create",
            "central",
            "--repo-dir",
            dir,
          ]),
        UserError,
        "this hub's own name",
      );
      await assertRejects(
        () =>
          runJson("1", [
            "token",
            "create",
            "edge-2",
            "--duration",
            "31d",
            "--repo-dir",
            dir,
          ]),
        UserError,
        "at most 30d",
      );
      assertEquals(
        await runJson("1", ["list", "--repo-dir", dir]),
        { members: [] },
      );
    });
  },
});

Deno.test({
  name:
    "serve member list/get: local mode shows each member's live view from the hub's seen records",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withRepo(HUB_YAML, async (dir) => {
      const instance = InstanceId.create(crypto.randomUUID());
      const runtime = {
        team: { role: "single" as const, nodes: 1 },
        startedAt: "2026-11-26T11:00:00.000Z",
        ready: true,
      };
      await withMockedEnv(
        { [FEDERATION_GATE_VARIABLE]: "1" },
        () =>
          withLocalHubForMember(
            { repoDir: dir, outputMode: "json" },
            "edge-1",
            async (hub) => {
              const { plaintext } = await hub.createToken("edge-1");
              const joined = await hub.join(plaintext, sampleFingerprint());
              if (joined.kind !== "joined") throw new Error(joined.kind);
              const outcome = await hub.checkIn(
                MemberCredential.parse(joined.credential),
                instance,
                sampleFingerprint(runtime),
              );
              assertEquals(outcome.kind, "checked-in");
              await hub.settled();
            },
          ),
      );

      const listed = await runJson("1", ["list", "--repo-dir", dir]) as {
        members: Array<{ name: string; live: Record<string, unknown> }>;
      };
      assertEquals(listed.members.map((m) => m.name), ["edge-1"]);
      const live = listed.members[0].live as {
        lastSeenAt: string;
        instances: Array<Record<string, unknown>>;
      };
      assertEquals(live.instances, [{
        instanceId: instance.value,
        lastSeenAt: live.lastSeenAt,
        runtime,
      }]);

      const got = await runJson("1", ["get", "edge-1", "--repo-dir", dir]) as {
        member: { live: unknown };
      };
      assertEquals(got.member.live, live);
    });
  },
});
