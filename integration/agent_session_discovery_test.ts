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
 * The agent session discovery contract (swamp-club#4154, swamp-club#4178): a
 * session written through the resource writer with the output spec's `type`
 * tag and the list tags from agentSessionTags is listed by the dashboard's
 * existing `data.query`. Top-level sessions and one session's children each
 * come from one predicate over tags, so neither query loads a record body,
 * and a viewer without read on the owning behavior sees none of it, filtered
 * before the limit. No dedicated query filter exists for sessions.
 */

import { assert, assertEquals } from "@std/assert";
import { z } from "zod";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { createResourceWriter } from "../src/domain/models/data_writer.ts";
import type { ResourceOutputSpec } from "../src/domain/models/model.ts";
import type { Definition } from "../src/domain/definitions/definition.ts";
import {
  AGENT_SESSION_LIST_SELECT,
  AGENT_SESSION_PARENT_TAG,
  AGENT_SESSION_QUERY_PREDICATE,
  AGENT_SESSION_SUMMARY_TAG,
  AGENT_SESSION_TOP_LEVEL_PREDICATE,
  AGENT_SESSION_TYPE_TAG,
  AGENT_SESSION_USER_ID_TAG,
  agentSessionChildId,
  agentSessionChildrenPredicate,
  agentSessionDataName,
  type AgentSessionRecord,
  agentSessionTags,
  readAgentSessionSummary,
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

function sessionRecord(
  sessionId: string,
  userId: string,
  parentSessionId?: string,
): AgentSessionRecord {
  return {
    schemaVersion: 2,
    id: sessionId,
    repo: "demo-repo",
    harness: "claude-code",
    model: "claude-opus-5-5",
    startedAt: "2026-10-29T15:58:12.000Z",
    invocation: "interactive",
    swampUserId: userId,
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    importerVersion: "0.1.0",
    turns: [{
      n: 1,
      start: 0,
      end: 900,
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      calls: [{
        id: "call-1",
        tool: "Bash",
        toolKind: "shell",
        start: 100,
        end: 800,
        ok: true,
        text: "swamp behavior type search",
        label: "swamp",
        category: "swamp",
        rule: "runs swamp",
      }],
    }],
    findings: [],
  };
}

async function writeSession(
  repo: ServeRepo,
  owner: Definition,
  sessionId: string,
  userId: string,
  parentSessionId?: string,
): Promise<string> {
  const record = sessionRecord(sessionId, userId, parentSessionId);
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
  const name = agentSessionDataName("claude-code", sessionId);
  const handle = await writeResource(
    "session",
    name,
    record,
    {
      tags: {
        ...agentSessionTags(record),
        [AGENT_SESSION_USER_ID_TAG]: userId,
      },
    },
  );
  return repo.repoContext.unifiedDataRepo.getContentPath(
    repo.modelType,
    owner.id,
    name,
    handle.version,
  );
}

/**
 * Replaces a session's stored body with a directory, so any query that reads
 * the body fails instead of quietly returning it.
 */
async function makeBodyUnreadable(contentPath: string): Promise<void> {
  await Deno.remove(contentPath);
  await Deno.mkdir(contentPath);
}

interface QueryReply {
  results: Array<{
    name: string;
    tags: Record<string, string>;
  }>;
  total: number;
  limited: boolean;
}

async function query(
  ctx: ReturnType<typeof createServeCtx>,
  limit?: number,
  predicate = AGENT_SESSION_QUERY_PREDICATE,
): Promise<QueryReply> {
  const frames = await sendRequest(ctx, {
    type: "data.query",
    id: crypto.randomUUID(),
    payload: {
      predicate,
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
    const all = await query(ctx, undefined, AGENT_SESSION_TOP_LEVEL_PREDICATE);
    assertEquals(
      all.results.map((r) => r.name),
      [agentSessionDataName("claude-code", "session-shared")],
    );
    // A page of one still finds the readable session, whatever sorts first.
    const page = await query(ctx, 1, AGENT_SESSION_TOP_LEVEL_PREDICATE);
    assertEquals(page.total, 1);
    assertEquals(
      page.results.map((r) => r.name),
      [agentSessionDataName("claude-code", "session-shared")],
    );
  });
});

interface ListRow {
  name: string;
  tags: Record<string, string>;
}

async function list(
  ctx: ReturnType<typeof createServeCtx>,
  predicate: string,
): Promise<ListRow[]> {
  const frames = await sendRequest(ctx, {
    type: "data.query",
    id: crypto.randomUUID(),
    payload: { predicate, select: AGENT_SESSION_LIST_SELECT },
  });
  assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
  const frame = frames.find((f) => f.type === "data.query") as
    | { payload: { data: { projected: { rows: ListRow[] } } } }
    | undefined;
  assert(frame, JSON.stringify(frames));
  return frame.payload.data.projected.rows;
}

Deno.test("agent session discovery: top-level sessions and one session's children are listed from tags alone", async () => {
  await withServeRepo(async (repo) => {
    const importer = await saveModel(repo, "agent-sessions");
    const childA = agentSessionChildId("parent-a", "a1b2c3");
    const childB = agentSessionChildId("parent-b", "d4e5f6");
    const bodies = [
      await writeSession(repo, importer, "parent-a", "user-a"),
      await writeSession(repo, importer, "parent-b", "user-a"),
      await writeSession(repo, importer, childA, "user-a", "parent-a"),
      await writeSession(repo, importer, childB, "user-a", "parent-b"),
    ];
    const ctx = createServeCtx(repo, [ALLOW_DATA]);
    // A query that read a body would now fail rather than return it.
    for (const body of bodies) await makeBodyUnreadable(body);

    const topLevel = await list(ctx, AGENT_SESSION_TOP_LEVEL_PREDICATE);
    assertEquals(
      topLevel.map((r) => r.name).sort(),
      [
        agentSessionDataName("claude-code", "parent-a"),
        agentSessionDataName("claude-code", "parent-b"),
      ],
    );

    const children = await list(ctx, agentSessionChildrenPredicate("parent-a"));
    assertEquals(
      children.map((r) => r.name),
      [agentSessionDataName("claude-code", childA)],
    );
    assertEquals(children[0].tags[AGENT_SESSION_PARENT_TAG], "parent-a");

    for (const row of [...topLevel, ...children]) {
      const summary = readAgentSessionSummary(
        row.tags[AGENT_SESSION_SUMMARY_TAG],
      );
      assertEquals(summary?.calls, 1);
    }
  });
});

Deno.test("agent session discovery: a list without the select reads the bodies it returns", async () => {
  await withServeRepo(async (repo) => {
    const importer = await saveModel(repo, "agent-sessions");
    await makeBodyUnreadable(
      await writeSession(repo, importer, "parent-a", "user-a"),
    );
    const frames = await sendRequest(createServeCtx(repo, [ALLOW_DATA]), {
      type: "data.query",
      id: crypto.randomUUID(),
      payload: { predicate: AGENT_SESSION_TOP_LEVEL_PREDICATE },
    });
    // The unreadable body shows the query read it: the select above is what
    // keeps the list off the bodies.
    assert(errorFrame(frames), JSON.stringify(frames));
  });
});
