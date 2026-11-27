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
import { FileSystemControlPlaneStore } from "../../infrastructure/persistence/fs_control_plane_store.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import { FEDERATION_GATE_VARIABLE } from "../../domain/serve/federation_gate.ts";
import { HubLink } from "../../domain/serve/hub_link.ts";
import { MemberCredential } from "../../domain/serve/member_credential.ts";
import { ControlPlaneVaultProvider } from "../../domain/vaults/control_plane_vault_provider.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../../libswamp/repo/init.ts";
import { collect } from "../../libswamp/testing.ts";
import { HubLinkStore } from "../../serve/federation/hub_link_store.ts";
import { MemberCredentialVault } from "../../serve/federation/member_credential_vault.ts";
import { serveHubCommand } from "./serve_hub.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

const VERSION = "20261126.120000.0";
const HUB = "https://hub.example.com";
const MEMBER_YAML = `version: 2\nfederation:\n  hub: ${HUB}\n`;

async function withRepo(
  serveYaml: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-serve-hub-" });
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

async function run(
  gate: string | undefined,
  args: string[],
): Promise<string[]> {
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
          .command("hub", serveHubCommand)
          .parse(["hub", ...args, "--json"]),
    );
  } finally {
    console.log = originalLog;
  }
  return logs;
}

interface Member {
  readonly links: HubLinkStore;
  readonly credentials: MemberCredentialVault;
  readonly credential: MemberCredential;
}

// what a serve that joined leaves in its control-plane store
async function joined(dir: string): Promise<Member> {
  const store = new FileSystemControlPlaneStore(swampPath(dir));
  const links = new HubLinkStore(store);
  const credential = MemberCredential.issue(crypto.randomUUID());
  await links.writeLink(
    HubLink.unjoined().beginJoin(HUB, crypto.randomUUID()).received({
      memberId: credential.memberId,
      memberName: "edge",
      hubName: "central",
      joinedAt: "2026-11-26T12:00:00.000Z",
    }).joined(),
  );
  const provider = new ControlPlaneVaultProvider(store, { migrate: false });
  await provider.initialize();
  const credentials = new MemberCredentialVault(provider);
  await credentials.store(credential);
  return { links, credentials, credential };
}

function instance(aliveAt: string, stoppedAt: string | null) {
  return {
    instanceId: crypto.randomUUID(),
    startedAt: aliveAt,
    aliveAt,
    lastAttemptAt: aliveAt,
    lastSuccessAt: aliveAt,
    result: "ok" as const,
    consecutiveFailures: 0,
    nextAttemptAt: null,
    stoppedAt,
  };
}

Deno.test("serveHubCommand: shows the link, takes --server, and has a forget subcommand", () => {
  assert(serveHubCommand.getOption("server"));
  assertEquals(serveHubCommand.getCommands().map((c) => c.getName()), [
    "forget",
  ]);
  assertEquals(
    serveHubCommand.getCommand("forget")!.getOption("server"),
    undefined,
  );
});

Deno.test("serve hub: local mode refuses unless the gate is on and serve.yaml is a version 2 member", async () => {
  await withRepo(MEMBER_YAML, async (dir) => {
    await assertRejects(
      () => run(undefined, ["--repo-dir", dir]),
      Error,
      "not a federation member",
    );
  });
  await withRepo("version: 2\nfederation:\n  role: hub\n", async (dir) => {
    await assertRejects(
      () => run("1", ["--repo-dir", dir]),
      Error,
      "not a federation member",
    );
  });
});

Deno.test("serve hub: local mode reports the link and instances, and no credential", async () => {
  await withRepo(MEMBER_YAML, async (dir) => {
    const member = await joined(dir);
    await member.links.writeInstance(
      instance(new Date().toISOString(), null),
    );
    const logs = await run("1", ["--repo-dir", dir]);
    const output = logs.join("\n");
    const { link } = JSON.parse(logs.at(-1)!);
    assertEquals(link.state, "joined");
    assertEquals(link.hubUrl, HUB);
    assertEquals(link.configuredHubUrl, HUB);
    assertEquals(link.memberName, "edge");
    assertEquals(link.instances.length, 1);
    assert(!output.includes("swfm1."));
    assert(!output.includes(member.credential.toWire().split(".")[2]));
  });
});

Deno.test("serve hub forget: a non-member's refusal does not point at --server, which forget lacks", async () => {
  await withRepo("version: 2\nfederation:\n  role: hub\n", async (dir) => {
    const error = await assertRejects(
      () => run("1", ["forget", "-y", "--repo-dir", dir]),
      Error,
      "not a federation member",
    );
    assert(!error.message.includes("--server"));
  });
});

Deno.test("serve hub forget: needs --yes in JSON mode", async () => {
  await withRepo(MEMBER_YAML, async (dir) => {
    await joined(dir);
    await assertRejects(
      () => run("1", ["forget", "--repo-dir", dir]),
      Error,
      "--yes",
    );
  });
});

Deno.test("serve hub forget: refused while a serve on the link is running", async () => {
  await withRepo(MEMBER_YAML, async (dir) => {
    const member = await joined(dir);
    await member.links.writeInstance(
      instance(new Date().toISOString(), null),
    );
    await assertRejects(
      () => run("1", ["forget", "--yes", "--repo-dir", dir]),
      Error,
      "checked in within the last",
    );
    assertEquals((await member.links.readLink()).state, "joined");
    assert((await member.credentials.read()) !== undefined);
  });
});

Deno.test("serve hub forget: clears the link and the credential once serve stopped", async () => {
  await withRepo(MEMBER_YAML, async (dir) => {
    const member = await joined(dir);
    const now = new Date().toISOString();
    await member.links.writeInstance(instance(now, now));
    const logs = await run("1", ["forget", "--yes", "--repo-dir", dir]);
    assertEquals(JSON.parse(logs.at(-1)!), {
      forgot: true,
      hubUrl: HUB,
      memberName: "edge",
    });
    assertEquals((await member.links.readLink()).state, "unjoined");
    assertEquals(await member.links.listInstances(), []);
    assertEquals(await member.credentials.read(), undefined);
  });
});
