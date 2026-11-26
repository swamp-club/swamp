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
import { registerFederationModelTypes } from "../src/domain/serve/federation_model_types.ts";
import { sampleFingerprintProps } from "../src/domain/serve/federation_test_helpers.ts";
import {
  SERVE_MEMBER_DATA_NAME,
  SERVE_MEMBER_MODEL_TYPE,
} from "../src/domain/models/serve/serve_member_names.ts";
import {
  OFFLINE_AFTER_MS,
  STALE_AFTER_MS,
} from "../src/domain/serve/serve_member.ts";
import { FederationHub } from "../src/serve/federation/federation_hub.ts";
import {
  repoMemberMethodRunner,
  repoMemberRecords,
} from "../src/serve/federation/member_record_store.ts";
import {
  FEDERATION_CHECK_IN_PATH,
  FEDERATION_JOIN_PATH,
  handleFederationRequest,
} from "../src/serve/federation/hub_routes.ts";
import { resetRateLimitState } from "../src/serve/rate_limiter.ts";
import { staticImportClosure } from "./arch_fitness_helpers.ts";
import "../src/domain/models/models.ts";

await initializeLogging({});

const VERSION = "20261126.120000.0";
const GATE_ON = (name: string) =>
  name === FEDERATION_GATE_VARIABLE ? "1" : undefined;

interface HubUnderTest extends AsyncDisposable {
  readonly hub: FederationHub;
  readonly repoContext: RepositoryContext;
  readonly url: string;
  readonly clock: { now: number };
}

async function startHub(): Promise<HubUnderTest> {
  assert(await registerFederationModelTypes(GATE_ON));
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-federation-hub-" });
  const removeRepo = async () => {
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  };
  let repoContext: RepositoryContext | undefined;
  try {
    const initEvents = await collect(
      repoInit(createLibSwampContext(), createRepoInitDeps(VERSION), {
        path: repoDir,
        force: false,
        version: VERSION,
        tools: [],
      }),
    );
    assertEquals(initEvents.some((event) => event.kind === "error"), false);
    const context = createRepositoryContext({ repoDir });
    repoContext = context;
    const clock = { now: Date.now() };
    const hub = new FederationHub({
      store: new FileSystemControlPlaneStore(swampPath(repoDir)),
      hubName: "central",
      members: repoMemberRecords(context),
      runMemberMethod: repoMemberMethodRunner({
        repoDir,
        repoContext: context,
      }),
      now: () => clock.now,
    });
    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      async (req, info) =>
        await handleFederationRequest(req, {
          hub,
          clientAddress: info.remoteAddr.hostname,
        }) ?? new Response("Not found", { status: 404 }),
    );
    return {
      hub,
      repoContext: context,
      url: `http://127.0.0.1:${server.addr.port}`,
      clock,
      async [Symbol.asyncDispose]() {
        await server.shutdown();
        await hub.settled();
        context.catalogStore.close();
        await removeRepo();
      },
    };
  } catch (error) {
    repoContext?.catalogStore.close();
    await removeRepo();
    throw error;
  }
}

/** what a member serve sends; it holds its credential once it has joined */
class FakeMember {
  credential: string | undefined;
  readonly instanceId = crypto.randomUUID();

  constructor(readonly hubUrl: string) {}

  async join(joinToken: string): Promise<Response> {
    const response = await fetch(`${this.hubUrl}${FEDERATION_JOIN_PATH}`, {
      method: "POST",
      body: JSON.stringify({
        protocolVersion: 1,
        capabilities: [],
        fingerprint: sampleFingerprintProps(),
        joinToken,
      }),
    });
    if (response.status === 200) {
      this.credential = (await response.clone().json()).credential;
    }
    return response;
  }

  async checkIn(): Promise<Response> {
    return await fetch(`${this.hubUrl}${FEDERATION_CHECK_IN_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.credential}` },
      body: JSON.stringify({
        protocolVersion: 1,
        capabilities: [],
        fingerprint: sampleFingerprintProps(),
        instanceId: this.instanceId,
      }),
    });
  }
}

async function status(response: Response): Promise<number> {
  await response.body?.cancel();
  return response.status;
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

Deno.test("federation hub: a member joins and checks in; its token is spent; its record is swamp data versioned only on change", async () => {
  resetRateLimitState();
  await using h = await startHub();
  const { plaintext } = await h.hub.createToken("edge-1");
  const member = new FakeMember(h.url);

  const joined = await member.join(plaintext);
  assertEquals(joined.status, 200);
  const reply = await joined.json();
  assertEquals(reply.memberName, "edge-1");
  assertEquals(reply.hub, "central");
  assertEquals(reply.checkInIntervalSeconds, 30);

  assertEquals(await status(await new FakeMember(h.url).join(plaintext)), 401);

  const checkedIn = await member.checkIn();
  assertEquals(checkedIn.status, 200);
  assertEquals(await checkedIn.json(), {
    hub: "central",
    checkInIntervalSeconds: 30,
    jobs: [],
  });
  assertEquals(await memberVersions(h.repoContext, "edge-1"), [1, 2]);
  assertEquals(await status(await member.checkIn()), 200);
  assertEquals(await memberVersions(h.repoContext, "edge-1"), [1, 2]);

  const records = await h.repoContext.dataQueryService.query(
    `modelType == "${SERVE_MEMBER_MODEL_TYPE.normalized}"`,
    { loadAttributes: true },
  ) as Array<{ attributes?: Record<string, unknown> }>;
  assertEquals(records.length, 1);
  const attributes = records[0].attributes!;
  assertEquals(attributes.name, "edge-1");
  assertEquals(attributes.memberId, reply.memberId);
  assertEquals(attributes.status, "online");
  assertEquals("credentialHash" in attributes, false);
  assert(!JSON.stringify(attributes).includes(reply.credential.split(".")[2]));
});

Deno.test("federation hub: the sweeper marks a silent member stale, then offline; a check-in brings it back", async () => {
  resetRateLimitState();
  await using h = await startHub();
  const { plaintext } = await h.hub.createToken("edge-1");
  const member = new FakeMember(h.url);
  assertEquals(await status(await member.join(plaintext)), 200);
  assertEquals(await status(await member.checkIn()), 200);

  const statusOf = async () => (await h.hub.getMember("edge-1"))!.status;
  h.clock.now += STALE_AFTER_MS;
  await h.hub.sweep();
  assertEquals(await statusOf(), "stale");
  h.clock.now += OFFLINE_AFTER_MS;
  await h.hub.sweep();
  assertEquals(await statusOf(), "offline");
  const versions = await memberVersions(h.repoContext, "edge-1");
  await h.hub.sweep();
  assertEquals(await memberVersions(h.repoContext, "edge-1"), versions);

  assertEquals(await status(await member.checkIn()), 200);
  assertEquals(await statusOf(), "online");
});

Deno.test("federation hub: a removed member's next check-in is refused", async () => {
  resetRateLimitState();
  await using h = await startHub();
  const { plaintext } = await h.hub.createToken("edge-1");
  const member = new FakeMember(h.url);
  assertEquals(await status(await member.join(plaintext)), 200);
  assertEquals(await status(await member.checkIn()), 200);

  const removed = await h.hub.removeMember("edge-1");
  assertEquals(removed.status, "removed");
  assertEquals(await status(await member.checkIn()), 401);
  assertEquals((await h.hub.getMember("edge-1"))!.status, "removed");
});

Deno.test("federation hub: serve's static imports never register the member type", async () => {
  const closure = await staticImportClosure("src/cli/commands/serve.ts");
  assert(closure.has("src/serve/federation/member_record_store.ts"));
  assertEquals(
    closure.has("src/domain/models/serve/serve_member_model.ts"),
    false,
    "importing serve_member_model.ts registers swamp/serve-member; import serve_member_names.ts instead",
  );
});
