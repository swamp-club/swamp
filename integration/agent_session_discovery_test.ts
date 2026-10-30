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

/**
 * The agent session discovery contract (swamp-club#4154): a session written
 * through the resource writer with the output spec's tags is listed by the
 * dashboard's existing `data.query` with AGENT_SESSION_QUERY_PREDICATE, and a
 * viewer without read on the owning behavior sees none of it, filtered before
 * the limit. No dedicated query filter exists for sessions.
 */

import { assert, assertEquals } from "@std/assert";
import { z } from "zod";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { createResourceWriter } from "../src/domain/models/data_writer.ts";
import type { ResourceOutputSpec } from "../src/domain/models/model.ts";
import type { Definition } from "../src/domain/definitions/definition.ts";
import {
  AGENT_SESSION_QUERY_PREDICATE,
  AGENT_SESSION_TYPE_TAG,
  AGENT_SESSION_USER_ID_TAG,
  agentSessionDataName,
} from "../src/domain/agent_sessions/session_record.ts";
import {
  createServeCtx,
  errorFrame,
  grant,
  saveData,
  saveModel,
  sendRequest,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

const SESSION_SPEC: Record<string, ResourceOutputSpec> = {
  session: {
    schema: z.record(z.string(), z.unknown()),
    lifetime: "infinite",
    garbageCollection: 1,
    tags: { type: AGENT_SESSION_TYPE_TAG },
  },
};

async function writeSession(
  repo: ServeRepo,
  owner: Definition,
  sessionId: string,
  userId: string,
): Promise<void> {
  const { writeResource } = createResourceWriter(
    repo.repoContext.unifiedDataRepo,
    repo.modelType,
    owner.id,
    SESSION_SPEC,
    undefined,
    undefined,
    undefined,
    undefined,
    owner.name,
  );
  await writeResource(
    "session",
    agentSessionDataName("claude-code", sessionId),
    { schemaVersion: 1, id: sessionId, swampUserId: userId },
    { tags: { [AGENT_SESSION_USER_ID_TAG]: userId } },
  );
}

interface QueryReply {
  results: Array<{ name: string; tags: Record<string, string> }>;
  total: number;
  limited: boolean;
}

async function query(
  ctx: ReturnType<typeof createServeCtx>,
  limit?: number,
): Promise<QueryReply> {
  const frames = await sendRequest(ctx, {
    type: "data.query",
    id: crypto.randomUUID(),
    payload: {
      predicate: AGENT_SESSION_QUERY_PREDICATE,
      ...(limit === undefined ? {} : { limit }),
    },
  });
  assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
  const frame = frames.find((f) => f.type === "data.query") as
    | { payload: { data: QueryReply } }
    | undefined;
  assert(frame, JSON.stringify(frames));
  return frame.payload.data;
}

const ALLOW_DATA = grant({
  actions: ["read"],
  resource: { kind: "data", pattern: "*" },
});

Deno.test("agent session discovery: data.query lists sessions by the type tag the output spec sets", async () => {
  await withServeRepo(async (repo) => {
    const importer = await saveModel(repo, "agent-sessions");
    await writeSession(repo, importer, "session-a", "user-a");
    await writeSession(repo, importer, "session-b", "user-b");
    // Ordinary data beside the sessions is not listed.
    await saveData(repo, importer, "state");

    const found = await query(createServeCtx(repo, [ALLOW_DATA]));
    assertEquals(
      found.results.map((r) => r.name).sort(),
      [
        agentSessionDataName("claude-code", "session-a"),
        agentSessionDataName("claude-code", "session-b"),
      ],
    );
    for (const record of found.results) {
      // The spec's tag replaced the writer's own `type: resource`.
      assertEquals(record.tags.type, AGENT_SESSION_TYPE_TAG);
      assert(record.tags[AGENT_SESSION_USER_ID_TAG]);
    }
  });
});

Deno.test("agent session discovery: a viewer without read on the owning behavior gets no sessions, before the limit", async () => {
  await withServeRepo(async (repo) => {
    const hidden = await saveModel(repo, "hidden-sessions");
    const shared = await saveModel(repo, "shared-sessions");
    await writeSession(repo, hidden, "session-hidden", "user-a");
    await writeSession(repo, shared, "session-shared", "user-b");

    const ctx = createServeCtx(repo, [
      grant({
        actions: ["read"],
        resource: { kind: "data", pattern: "shared-*" },
      }),
    ]);
    const all = await query(ctx);
    assertEquals(
      all.results.map((r) => r.name),
      [agentSessionDataName("claude-code", "session-shared")],
    );
    // A page of one still finds the readable session, whatever sorts first.
    const page = await query(ctx, 1);
    assertEquals(page.total, 1);
    assertEquals(
      page.results.map((r) => r.name),
      [agentSessionDataName("claude-code", "session-shared")],
    );
  });
});
