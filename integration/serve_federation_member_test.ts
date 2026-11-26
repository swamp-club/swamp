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

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { collect } from "../src/libswamp/testing.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
import {
  createRepositoryContext,
  type RepositoryContext,
} from "../src/infrastructure/persistence/repository_factory.ts";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { FEDERATION_GATE_VARIABLE } from "../src/domain/serve/federation_gate.ts";
import { registerFederationModelTypes } from "../src/domain/models/serve/federation_model_types.ts";
import {
  SERVE_MEMBER_DATA_NAME,
  SERVE_MEMBER_MODEL_TYPE,
} from "../src/domain/models/serve/serve_member_names.ts";
import type { HubLink } from "../src/domain/serve/hub_link.ts";
import { FederationHub } from "../src/serve/federation/federation_hub.ts";
import {
  repoMemberMethodRunner,
  repoMemberRecords,
} from "../src/serve/federation/member_record_store.ts";
import { handleFederationRequest } from "../src/serve/federation/hub_routes.ts";
import { HubLinkStore } from "../src/serve/federation/hub_link_store.ts";
import { resetRateLimitState } from "../src/serve/rate_limiter.ts";
import { startProcessHost } from "./process_host.ts";
import {
  type MemberHostMessage,
  type MemberHostRequest,
  startMemberHost,
} from "./serve_federation_member_host.ts";
import { captureLogs } from "./remote_secrets_baseline_harness.ts";
import "../src/domain/models/models.ts";

await initializeLogging({});

const VERSION = "20261126.120000.0";
const GATE_ON = (name: string) =>
  name === FEDERATION_GATE_VARIABLE ? "1" : undefined;
const FAST = 0.05;

async function removeDir(dir: string): Promise<void> {
  if (Deno.build.os === "windows") {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  } else {
    await Deno.remove(dir, { recursive: true });
  }
}

async function initRepo(prefix: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix });
  const events = await collect(
    repoInit(createLibSwampContext(), createRepoInitDeps(VERSION), {
      path: dir,
      force: false,
      version: VERSION,
      tools: [],
    }),
  );
  assertEquals(events.some((event) => event.kind === "error"), false);
  return dir;
}

interface HubUnderTest extends AsyncDisposable {
  readonly hub: FederationHub;
  readonly repoContext: RepositoryContext;
  readonly url: string;
  stop(): Promise<void>;
  restart(): void;
}

async function startHub(): Promise<HubUnderTest> {
  assert(await registerFederationModelTypes(GATE_ON));
  const repoDir = await initRepo("swamp-federation-member-hub-");
  const repoContext = createRepositoryContext({ repoDir });
  const hub = new FederationHub({
    store: new FileSystemControlPlaneStore(swampPath(repoDir)),
    hubName: "central",
    members: repoMemberRecords(repoContext),
    runMemberMethod: repoMemberMethodRunner({ repoDir, repoContext }),
  });
  const listen = (port: number) =>
    Deno.serve(
      { port, hostname: "127.0.0.1", onListen: () => {} },
      async (req, info) =>
        await handleFederationRequest(req, {
          hub,
          clientAddress: info.remoteAddr.hostname,
        }) ?? new Response("Not found", { status: 404 }),
    );
  let server: Deno.HttpServer<Deno.NetAddr> | undefined = listen(0);
  const port = server.addr.port;
  return {
    hub,
    repoContext,
    url: `http://127.0.0.1:${port}`,
    async stop() {
      await server?.shutdown();
      server = undefined;
    },
    restart() {
      server = listen(port);
    },
    async [Symbol.asyncDispose]() {
      await server?.shutdown();
      await hub.settled();
      repoContext.catalogStore.close();
      await removeDir(repoDir);
    },
  };
}

interface MemberRepo extends AsyncDisposable {
  readonly dir: string;
  configure(
    options: { hubUrl: string; token?: string; extra?: string },
  ): Promise<void>;
  link(): Promise<HubLink>;
  links(): HubLinkStore;
}

async function memberRepo(): Promise<MemberRepo> {
  const dir = await initRepo("swamp-federation-member-");
  const links = () =>
    new HubLinkStore(new FileSystemControlPlaneStore(swampPath(dir)));
  return {
    dir,
    async configure({ hubUrl, token, extra }) {
      const tokenFile = join(dir, "join-token.txt");
      if (token !== undefined) await Deno.writeTextFile(tokenFile, token);
      else await Deno.remove(tokenFile).catch(() => {});
      await Deno.writeTextFile(
        join(dir, ".swamp", "serve.yaml"),
        [
          "version: 2",
          "federation:",
          `  hub: ${hubUrl}`,
          ...(token !== undefined ? ["  join-token-file: join-token.txt"] : []),
          ...(extra !== undefined ? [extra] : []),
          "",
        ].join("\n"),
      );
    },
    link: () => links().readLink(),
    links,
    async [Symbol.asyncDispose]() {
      await removeDir(dir);
    },
  };
}

interface MemberProcess extends AsyncDisposable {
  readonly instanceId: string;
  readonly built: boolean;
  stop(): Promise<void>;
}

async function startMember(
  dir: string,
  options: { gate?: boolean } = {},
): Promise<MemberProcess> {
  const messages: MemberHostMessage[] = [];
  const host = startProcessHost<MemberHostRequest, MemberHostMessage>(
    "member",
    startMemberHost,
    (message) => messages.push(message),
  );
  host.postMessage({
    kind: "start",
    repoDir: dir,
    gate: options.gate ?? true,
    maxIntervalSeconds: FAST,
  });
  await waitFor(() => messages.length > 0, "the member to start");
  const started = messages[0];
  if (started.kind !== "started") {
    host.terminate();
    throw new Error(`member failed to start: ${JSON.stringify(started)}`);
  }
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    host.postMessage({ kind: "stop" });
    await waitFor(
      () => messages.some((m) => m.kind === "stopped" || m.kind === "failed"),
      "the member to stop",
    );
    host.terminate();
  };
  return {
    instanceId: started.instanceId,
    built: started.built,
    stop,
    [Symbol.asyncDispose]: stop,
  };
}

async function memberNamed(h: HubUnderTest, name: string) {
  return (await h.hub.listMembers()).find((m) =>
    m.name === name && !m.isRemoved
  );
}

async function memberVersions(
  repoContext: RepositoryContext,
  name: string,
): Promise<number[]> {
  const definition = await repoContext.definitionRepo.findByName(
    SERVE_MEMBER_MODEL_TYPE,
    name,
  );
  assert(definition !== null, `no definition for ${name}`);
  return await repoContext.unifiedDataRepo.listVersions(
    SERVE_MEMBER_MODEL_TYPE,
    definition.id,
    SERVE_MEMBER_DATA_NAME,
  );
}

async function seenBy(h: HubUnderTest, instanceId: string): Promise<boolean> {
  return (await memberNamed(h, "edge"))?.instanceIds().includes(instanceId) ??
    false;
}

Deno.test("federation member: joins with its token, checks in at once, and is listed on the hub with one instance", async () => {
  resetRateLimitState();
  await using h = await startHub();
  await using repo = await memberRepo();
  const { plaintext } = await h.hub.createToken("edge");
  await repo.configure({ hubUrl: h.url, token: plaintext });
  await using member = await startMember(repo.dir);
  assert(member.built);
  await waitFor(
    () => seenBy(h, member.instanceId),
    "the member's first check-in",
  );
  const listed = (await memberNamed(h, "edge"))!;
  assertEquals(listed.instanceIds(), [member.instanceId]);
  const link = await repo.link();
  assertEquals(link.state, "joined");
  assertEquals(link.memberId, listed.memberId);
  assertEquals(link.hubName, "central");
  assertEquals(
    (await h.hub.listTokens()).find((t) => t.memberName === "edge")?.state,
    "used",
  );
});

Deno.test("federation member: a fingerprint change makes one new record version on the hub", async () => {
  resetRateLimitState();
  await using h = await startHub();
  await using repo = await memberRepo();
  const { plaintext } = await h.hub.createToken("edge");
  await repo.configure({ hubUrl: h.url, token: plaintext });
  const first = await startMember(repo.dir);
  await waitFor(() => seenBy(h, first.instanceId), "a check-in");
  await first.stop();
  const before = await memberVersions(h.repoContext, "edge");
  await repo.configure({ hubUrl: h.url, extra: "max-concurrent-runs: 3" });
  await using second = await startMember(repo.dir);
  await waitFor(() => seenBy(h, second.instanceId), "the restarted check-in");
  const after = await memberVersions(h.repoContext, "edge");
  assertEquals(after.length, before.length + 1);
});

Deno.test("federation member: two instances on one control-plane store join once and are two instances of one member", async () => {
  resetRateLimitState();
  await using h = await startHub();
  await using repo = await memberRepo();
  const { plaintext } = await h.hub.createToken("edge");
  await repo.configure({ hubUrl: h.url, token: plaintext });
  await using a = await startMember(repo.dir);
  await using b = await startMember(repo.dir);
  await waitFor(
    async () => await seenBy(h, a.instanceId) && await seenBy(h, b.instanceId),
    "both instances checking in",
  );
  const members = (await h.hub.listMembers()).filter((m) => m.name === "edge");
  assertEquals(members.length, 1);
  assertEquals(
    members[0].instanceIds(),
    [a.instanceId, b.instanceId].sort(),
  );
});

Deno.test("federation member: with the hub stopped it backs off and resumes when the hub returns", async () => {
  resetRateLimitState();
  await using h = await startHub();
  await using repo = await memberRepo();
  const { plaintext } = await h.hub.createToken("edge");
  await repo.configure({ hubUrl: h.url, token: plaintext });
  await using member = await startMember(repo.dir);
  await waitFor(() => seenBy(h, member.instanceId), "a check-in");
  await h.stop();
  await waitFor(async () => {
    const instance = await repo.links().readInstance(member.instanceId);
    return instance?.result === "unreachable" &&
      instance.consecutiveFailures >= 2;
  }, "backing off");
  h.restart();
  await waitFor(
    async () =>
      (await repo.links().readInstance(member.instanceId))?.result === "ok",
    "check-ins resuming",
  );
});

Deno.test("federation member: removed on the hub, its next check-in is refused, it forgets the credential and stops", async () => {
  resetRateLimitState();
  await using h = await startHub();
  await using repo = await memberRepo();
  const { plaintext } = await h.hub.createToken("edge");
  await repo.configure({ hubUrl: h.url, token: plaintext });
  await using member = await startMember(repo.dir);
  await waitFor(() => seenBy(h, member.instanceId), "a check-in");
  await h.hub.removeMember("edge");
  // the link is refused first, then the credential deleted, then the result recorded
  await waitFor(
    async () =>
      (await repo.links().readInstance(member.instanceId))?.result ===
        "refused",
    "the refusal recorded",
  );
  assertEquals((await repo.link()).state, "refused");
  assertEquals(
    await new FileSystemControlPlaneStore(swampPath(repo.dir)).list(
      "token-secrets/values/federation-member-credential",
    ),
    [],
  );
});

Deno.test("federation member: rebuilt on the same store with no token file, it is the same member", async () => {
  resetRateLimitState();
  await using h = await startHub();
  await using repo = await memberRepo();
  const { plaintext } = await h.hub.createToken("edge");
  await repo.configure({ hubUrl: h.url, token: plaintext });
  const first = await startMember(repo.dir);
  await waitFor(() => seenBy(h, first.instanceId), "a check-in");
  const memberId = (await memberNamed(h, "edge"))!.memberId;
  await first.stop();
  await repo.configure({ hubUrl: h.url });
  await using rebuilt = await startMember(repo.dir);
  await waitFor(() => seenBy(h, rebuilt.instanceId), "the rebuilt check-in");
  assertEquals((await memberNamed(h, "edge"))!.memberId, memberId);
});

Deno.test("federation member: a different hub URL from the joined one makes no join and one error", async () => {
  resetRateLimitState();
  await using h = await startHub();
  await using repo = await memberRepo();
  const { plaintext } = await h.hub.createToken("edge");
  await repo.configure({ hubUrl: h.url, token: plaintext });
  const first = await startMember(repo.dir);
  await waitFor(() => seenBy(h, first.instanceId), "a check-in");
  await first.stop();
  const { plaintext: second } = await h.hub.createToken("edge-2");
  await repo.configure({ hubUrl: "http://127.0.0.1:9", token: second });
  let moved: MemberProcess | undefined;
  const logs = await captureLogs(async () => {
    moved = await startMember(repo.dir);
    await waitFor(
      async () => (await repo.link()).state === "mismatched",
      "the link mismatched",
    );
    await moved.stop();
  });
  const errors = logs.filter((log) =>
    log.level === "error" && log.text.includes("already belongs to the hub")
  );
  assertEquals(errors.length, 1);
  assertEquals(
    (await h.hub.listTokens()).find((t) => t.memberName === "edge-2")?.state,
    "unused",
  );
});

Deno.test("federation member: with the gate off, a serve.yaml naming a hub makes no request", async () => {
  resetRateLimitState();
  await using h = await startHub();
  await using repo = await memberRepo();
  const { plaintext } = await h.hub.createToken("edge");
  await repo.configure({ hubUrl: h.url, token: plaintext });
  await using member = await startMember(repo.dir, { gate: false });
  assertEquals(member.built, false);
  assertEquals(await memberNamed(h, "edge"), undefined);
  assertEquals(
    (await h.hub.listTokens()).find((t) => t.memberName === "edge")?.state,
    "unused",
  );
  assertEquals((await repo.link()).state, "unjoined");
});

Deno.test("federation member: no join token or credential reaches a log", async () => {
  resetRateLimitState();
  await using h = await startHub();
  await using repo = await memberRepo();
  const { plaintext } = await h.hub.createToken("edge");
  await repo.configure({ hubUrl: h.url, token: plaintext });
  const logs = await captureLogs(async () => {
    const member = await startMember(repo.dir);
    await waitFor(() => seenBy(h, member.instanceId), "a check-in");
    await h.hub.removeMember("edge");
    await waitFor(
      async () => (await repo.link()).state === "refused",
      "the link refused",
    );
    await member.stop();
  });
  const text = JSON.stringify(logs);
  assert(!text.includes(plaintext.split(".")[1]), "join token secret");
  assert(!text.includes("swfm1."), "member credential");
});
