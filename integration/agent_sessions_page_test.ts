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
 * The agent sessions page's own requests (swamp-club#4155), sent through
 * serve's handlers against sessions written by the real resource writer:
 * the visibility check, the list, a session's subagents and one session's
 * record. A viewer without read on the owning behavior gets none of it, so
 * hiding the page is never what keeps sessions private.
 */

import { assert, assertEquals } from "@std/assert";
import { z } from "zod";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { createResourceWriter } from "../src/domain/models/data_writer.ts";
import type { ResourceOutputSpec } from "../src/domain/models/model.ts";
import type { Definition } from "../src/domain/definitions/definition.ts";
import {
  AGENT_SESSION_TYPE_TAG,
  agentSessionDataName,
  type AgentSessionRecord,
  agentSessionTags,
} from "../src/domain/agent_sessions/session_record.ts";
import {
  appendWindow,
  childrenPayload,
  detailPayload,
  listPayload,
  parseDetailReply,
  parseListReply,
  probePayload,
} from "../packages/dashboard/src/client/agent_sessions.ts";
import { fixtureSessions } from "../packages/dashboard/src/views/agent_sessions/fixtures.ts";
import {
  createServeCtx,
  errorFrame,
  grant,
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

const ALLOW_DATA = grant({
  actions: ["read"],
  resource: { kind: "data", pattern: "*" },
});

async function writeSession(
  repo: ServeRepo,
  owner: Definition,
  record: AgentSessionRecord,
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
    agentSessionDataName(record.harness, record.id),
    record,
    { tags: agentSessionTags(record) },
  );
}

async function ask(
  ctx: ReturnType<typeof createServeCtx>,
  type: string,
  payload: Record<string, unknown>,
): Promise<{ data: unknown; error: unknown }> {
  const frames = await sendRequest(ctx, {
    type,
    id: crypto.randomUUID(),
    payload,
  }) as Array<{ type: string; payload?: { data?: unknown } }>;
  const frame = frames.find((f) => f.type === type);
  return { data: frame?.payload?.data, error: errorFrame(frames) };
}

async function withSessions(
  fn: (repo: ServeRepo) => Promise<void>,
): Promise<void> {
  await withServeRepo(async (repo) => {
    const importer = await saveModel(repo, "agent-sessions");
    for (const session of fixtureSessions()) {
      await writeSession(repo, importer, session);
    }
    await fn(repo);
  });
}

Deno.test("agent sessions page: a reader finds, lists, opens and expands sessions", async () => {
  await withSessions(async (repo) => {
    const ctx = createServeCtx(repo, [ALLOW_DATA]);
    const [edits, long, child, headless] = fixtureSessions();

    const probe = await ask(ctx, "data.query", probePayload());
    assertEquals(probe.error, undefined);
    assertEquals(parseListReply(probe.data).rows.length, 1);

    const list = parseListReply(
      (await ask(ctx, "data.query", listPayload())).data,
    );
    // Top-level only, newest first.
    assertEquals(
      list.rows.map((r) => r.name),
      [headless, long, edits].map((s) => agentSessionDataName(s.harness, s.id)),
    );
    assertEquals(list.rows.map((r) => r.headless), [true, false, false]);
    assert(list.rows.every((r) => r.summary !== undefined));

    const opened = list.rows[1];
    const detail = parseDetailReply(
      (await ask(ctx, "data.get", detailPayload(opened))).data,
    );
    assertEquals(detail.kind === "record" && detail.record.id, long.id);

    const children = parseListReply(
      (await ask(ctx, "data.query", childrenPayload(long.id)!)).data,
    );
    assertEquals(children.rows.map((r) => r.parentSessionId), [long.id]);
    const childReading = parseDetailReply(
      (await ask(ctx, "data.get", detailPayload(children.rows[0]))).data,
    );
    assertEquals(
      childReading.kind === "record" && childReading.record.id,
      child.id,
    );
  });
});

Deno.test("agent sessions page: the list pages newest first by cursor, in serve's order", async () => {
  await withSessions(async (repo) => {
    const ctx = createServeCtx(repo, [ALLOW_DATA]);
    const [edits, long, , headless] = fixtureSessions();
    const names = (rows: readonly { name: string }[]) =>
      rows.map((r) => r.name);
    const newestFirst = [headless, long, edits].map((s) =>
      agentSessionDataName(s.harness, s.id)
    );

    // A window of two: serve sorts it, so it is the newest two, and it
    // hands back a cursor for the rest.
    const firstReply = await ask(ctx, "data.query", {
      ...listPayload(),
      limit: 2,
    });
    assertEquals(firstReply.error, undefined);
    const raw = (firstReply.data as { projected: { rows: { name: string }[] } })
      .projected.rows;
    assertEquals(names(raw), newestFirst.slice(0, 2));
    const first = parseListReply(firstReply.data);
    assert(first.limited);
    assert(first.nextCursor !== undefined);

    const olderReply = await ask(ctx, "data.query", {
      ...listPayload(first.nextCursor),
      limit: 2,
    });
    assertEquals(olderReply.error, undefined);
    const older = parseListReply(olderReply.data);
    assertEquals(names(older.rows), newestFirst.slice(2));
    assertEquals(older.nextCursor, undefined);

    const all = appendWindow(first, older);
    assertEquals(names(all.rows), newestFirst);
    assertEquals(all.nextCursor, undefined);
  });
});

Deno.test("agent sessions page: a viewer without read gets nothing, even by a direct URL", async () => {
  await withSessions(async (repo) => {
    const reader = createServeCtx(repo, [ALLOW_DATA]);
    const [row] = parseListReply(
      (await ask(reader, "data.query", listPayload())).data,
    ).rows;

    const stranger = createServeCtx(repo, []);
    const probe = await ask(stranger, "data.query", probePayload());
    assertEquals(parseListReply(probe.data).rows.length, 0);
    const list = await ask(stranger, "data.query", listPayload());
    assertEquals(parseListReply(list.data).rows.length, 0);
    const opened = await ask(stranger, "data.get", detailPayload(row));
    assert(opened.error, "a direct read is refused");
  });
});
