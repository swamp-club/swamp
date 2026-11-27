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
import { sampleFingerprintProps } from "../src/domain/serve/federation_test_helpers.ts";
import {
  SERVE_MEMBER_DATA_NAME,
  SERVE_MEMBER_MODEL_TYPE,
} from "../src/domain/models/serve/serve_member_names.ts";
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
import { type ProcessHost, startProcessHost } from "./process_host.ts";
import "../src/domain/models/models.ts";

await initializeLogging({});

const VERSION = "20261126.120000.0";
const GATE_ON = (name: string) =>
  name === FEDERATION_GATE_VARIABLE ? "1" : undefined;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type NewerHubRequest = { readonly repoDir: string; readonly name: string };
type NewerHubMessage = { readonly ok: true } | { readonly error: string };

/**
 * a newer hub of the same team: it writes the member record through the model,
 * and every federation control-plane record, each with a field this version does not know
 */
const startNewerHub: ProcessHost<NewerHubRequest, NewerHubMessage> = (
  post,
) =>
(request) => {
  rewriteAsNewer(request).then(
    () => post({ ok: true }),
    (error) => post({ error: String(error) }),
  );
};

async function rewriteAsNewer(request: NewerHubRequest): Promise<void> {
  assert(await registerFederationModelTypes(GATE_ON));
  const repoContext = createRepositoryContext({ repoDir: request.repoDir });
  try {
    const member = await repoMemberRecords(repoContext).get(request.name);
    assert(member !== null);
    const record = member.toJSON();
    await repoMemberMethodRunner({
      repoDir: request.repoDir,
      repoContext,
    })(request.name, {
      method: "record",
      inputs: {
        record: {
          ...record,
          status: "stale",
          later: "x",
          fingerprint: { ...record.fingerprint, laterField: true },
          instances: record.instances.map((i) => ({ ...i, later: 1 })),
        } as typeof record,
      },
    });
    const store = new FileSystemControlPlaneStore(swampPath(request.repoDir));
    for (const key of await store.list("federation/")) {
      const bytes = await store.get(key);
      if (bytes === null) continue;
      const value = JSON.parse(decoder.decode(bytes));
      await store.put(
        key,
        encoder.encode(JSON.stringify({ ...value, later: 1 })),
      );
    }
  } finally {
    repoContext.catalogStore.close();
  }
}

async function memberRecord(
  repoContext: RepositoryContext,
  name: string,
): Promise<{ versions: number[]; content: Record<string, unknown> }> {
  const definition = await repoContext.definitionRepo.findByName(
    SERVE_MEMBER_MODEL_TYPE,
    name,
  );
  assert(definition !== null);
  const versions = await repoContext.unifiedDataRepo.listVersions(
    SERVE_MEMBER_MODEL_TYPE,
    definition.id,
    SERVE_MEMBER_DATA_NAME,
  );
  const content = await repoContext.unifiedDataRepo.getContent(
    SERVE_MEMBER_MODEL_TYPE,
    definition.id,
    SERVE_MEMBER_DATA_NAME,
  );
  assert(content !== null);
  return { versions, content: JSON.parse(decoder.decode(content)) };
}

function post(path: string, body: unknown, credential?: string): Request {
  return new Request(`http://hub.test${path}`, {
    method: "POST",
    headers: credential === undefined
      ? {}
      : { authorization: `Bearer ${credential}` },
    body: JSON.stringify(body),
  });
}

Deno.test("federation version skew: records a newer hub wrote are read, swept and rewritten with their fields, and a newer member's fingerprint field is dropped", async () => {
  resetRateLimitState();
  assert(await registerFederationModelTypes(GATE_ON));
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-federation-skew-" });
  let repoContext: RepositoryContext | undefined;
  try {
    const init = await collect(
      repoInit(createLibSwampContext(), createRepoInitDeps(VERSION), {
        path: repoDir,
        force: false,
        version: VERSION,
        tools: [],
      }),
    );
    assertEquals(init.some((event) => event.kind === "error"), false);
    const context = createRepositoryContext({ repoDir });
    repoContext = context;
    const hub = new FederationHub({
      store: new FileSystemControlPlaneStore(swampPath(repoDir)),
      hubName: "central",
      members: repoMemberRecords(context),
      runMemberMethod: repoMemberMethodRunner({
        repoDir,
        repoContext: context,
      }),
    });
    const answer = async (req: Request) => {
      const response = await handleFederationRequest(req, {
        hub,
        clientAddress: "10.0.0.1",
      });
      assert(response !== null);
      return response;
    };
    const instanceId = crypto.randomUUID();
    const checkIn = (credential: string, fingerprint: unknown) =>
      answer(post(FEDERATION_CHECK_IN_PATH, {
        protocolVersion: 1,
        capabilities: [],
        fingerprint,
        instanceId,
      }, credential));

    const { plaintext } = await hub.createToken("edge-1");
    const joined = await answer(post(FEDERATION_JOIN_PATH, {
      protocolVersion: 1,
      capabilities: [],
      fingerprint: sampleFingerprintProps(),
      joinToken: plaintext,
      joinId: crypto.randomUUID(),
    }));
    assertEquals(joined.status, 200);
    const { credential } = await joined.json();
    assertEquals(
      (await checkIn(credential, sampleFingerprintProps())).status,
      200,
    );

    const messages: NewerHubMessage[] = [];
    const newer = startProcessHost<NewerHubRequest, NewerHubMessage>(
      "newer-hub",
      startNewerHub,
      (message) => messages.push(message),
    );
    try {
      newer.postMessage({ repoDir, name: "edge-1" });
      await waitFor(() => messages.length > 0, "the newer hub's rewrite");
    } finally {
      newer.terminate();
    }
    assertEquals(messages[0], { ok: true });
    assertEquals((await memberRecord(context, "edge-1")).content.later, "x");

    const swept = await hub.sweep();
    assertEquals(swept.seenKeysDeleted, 0);
    assertEquals(swept.membersWritten, 1);
    const rewritten = await memberRecord(context, "edge-1");
    assertEquals(rewritten.content.status, "online");
    assertEquals(rewritten.content.later, "x");
    assertEquals(
      (rewritten.content.fingerprint as Record<string, unknown>).laterField,
      true,
    );
    assertEquals(
      (rewritten.content.instances as Record<string, unknown>[])[0].later,
      1,
    );
    const tokens = await hub.listTokens();
    assertEquals(tokens.length, 1);
    assertEquals("later" in tokens[0], false);

    const extra = await checkIn(credential, {
      ...sampleFingerprintProps(),
      newerField: "secret-host.internal",
    });
    assertEquals(extra.status, 200);
    await hub.settled();
    const after = await memberRecord(context, "edge-1");
    assertEquals(after.versions, rewritten.versions);
    const store = new FileSystemControlPlaneStore(swampPath(repoDir));
    let stored = JSON.stringify(after.content);
    for (const key of await store.list("federation/")) {
      stored += decoder.decode((await store.get(key)) ?? new Uint8Array());
    }
    assert(!stored.includes("secret-host"), stored);
  } finally {
    repoContext?.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
});
