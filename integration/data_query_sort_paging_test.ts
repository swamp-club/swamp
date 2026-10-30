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
 * Sorted, keyset-paged `data.query` through the serve handler that the local
 * dashboard shares (swamp-club#4177): pages run newest first by a tag across
 * bounded pages without skipping or repeating a row when data is written
 * between them, a tags-only list reads no body, and read access is applied
 * before the limit, so neither a page nor a cursor reaches a row the viewer
 * may not read.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { Data } from "../src/domain/data/data.ts";
import type { Definition } from "../src/domain/definitions/definition.ts";
import { encodeQueryCursor } from "../src/domain/data/query_sort.ts";
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

const PREDICATE = 'tags.type == "paged-session"';
const NEWEST_FIRST = { field: "tags.startedAt", direction: "desc" } as const;

/** Saves a session-like item and returns its content path. */
async function saveSession(
  repo: ServeRepo,
  model: Definition,
  name: string,
  startedAt?: string,
): Promise<string> {
  const data = Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: {
      type: "paged-session",
      modelName: model.name,
      ...(startedAt === undefined ? {} : { startedAt }),
    },
    ownerDefinition: {
      ownerType: "model-method",
      ownerRef: `${repo.modelType.normalized}:${model.id}`,
    },
  });
  await repo.repoContext.unifiedDataRepo.save(
    repo.modelType,
    model.id,
    data,
    new TextEncoder().encode(JSON.stringify({ name })),
  );
  return repo.repoContext.unifiedDataRepo.getContentPath(
    repo.modelType,
    model.id,
    name,
    data.version,
  );
}

interface Page {
  names: string[];
  nextCursor?: string;
  limited: boolean;
}

async function page(
  ctx: ReturnType<typeof createServeCtx>,
  payload: Record<string, unknown>,
): Promise<Page> {
  const frames = await sendRequest(ctx, {
    type: "data.query",
    id: crypto.randomUUID(),
    payload: { predicate: PREDICATE, select: "name", ...payload },
  });
  assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
  const frame = frames.find((f) => f.type === "data.query") as
    | {
      payload: {
        data: {
          projected: { values: string[] };
          nextCursor?: string;
          limited: boolean;
        };
      };
    }
    | undefined;
  assert(frame, JSON.stringify(frames));
  const { projected, nextCursor, limited } = frame.payload.data;
  return { names: projected.values, nextCursor, limited };
}

const ALLOW_DATA = grant({
  actions: ["read"],
  resource: { kind: "data", pattern: "*" },
});

const day = (n: number) =>
  `2026-10-${String(n).padStart(2, "0")}T00:00:00.000Z`;

Deno.test("data.query sort paging: newest first across bounded pages, a write between pages neither skips nor repeats a row", async () => {
  await withServeRepo(async (repo) => {
    const model = await saveModel(repo, "sessions");
    for (let i = 1; i <= 5; i++) {
      await saveSession(repo, model, `s${i}`, day(i));
    }
    await saveSession(repo, model, "untagged");
    const ctx = createServeCtx(repo, [ALLOW_DATA]);

    const first = await page(ctx, { sort: NEWEST_FIRST, limit: 2 });
    assertEquals(first.names, ["s5", "s4"]);
    assert(first.nextCursor);
    // One write above the cursor, one below it.
    await saveSession(repo, model, "newer", day(20));
    await saveSession(repo, model, "older", day(2).replace("T00", "T01"));

    const second = await page(ctx, {
      sort: NEWEST_FIRST,
      limit: 2,
      cursor: first.nextCursor,
    });
    assertEquals(second.names, ["s3", "older"]);
    const third = await page(ctx, {
      sort: NEWEST_FIRST,
      limit: 2,
      cursor: second.nextCursor,
    });
    assertEquals(third.names, ["s2", "s1"]);
    const last = await page(ctx, {
      sort: NEWEST_FIRST,
      limit: 2,
      cursor: third.nextCursor,
    });
    // A session without the tag sorts as the empty string: last.
    assertEquals(last.names, ["untagged"]);
    assertEquals(last.nextCursor, undefined);
    assertEquals(last.limited, false);

    const byCreated = await page(ctx, {
      sort: { field: "createdAt", direction: "desc" },
      limit: 2,
    });
    assertEquals(byCreated.names, ["older", "newer"]);
  });
});

Deno.test("data.query sort paging: a tags-only sorted list reads no record body", async () => {
  await withServeRepo(async (repo) => {
    const model = await saveModel(repo, "sessions");
    const bodies = [
      await saveSession(repo, model, "a", day(1)),
      await saveSession(repo, model, "b", day(2)),
      await saveSession(repo, model, "c", day(3)),
    ];
    // A query that read a body would now fail rather than return it.
    for (const body of bodies) {
      await Deno.remove(body);
      await Deno.mkdir(body);
    }
    const ctx = createServeCtx(repo, [ALLOW_DATA]);

    const first = await page(ctx, {
      select: "tags.startedAt",
      sort: NEWEST_FIRST,
      limit: 2,
    });
    assertEquals(first.names, [day(3), day(2)]);
    const second = await page(ctx, {
      select: "tags.startedAt",
      sort: NEWEST_FIRST,
      limit: 2,
      cursor: first.nextCursor,
    });
    assertEquals(second.names, [day(1)]);
  });
});

Deno.test("data.query sort paging: read access applies before the limit, and a forged cursor reaches no unreadable row", async () => {
  await withServeRepo(async (repo) => {
    const hidden = await saveModel(repo, "hidden-sessions");
    const shared = await saveModel(repo, "shared-sessions");
    for (let i = 1; i <= 6; i++) {
      await saveSession(repo, i % 2 ? hidden : shared, `s${i}`, day(i));
    }
    const ctx = createServeCtx(repo, [
      grant({
        actions: ["read"],
        resource: { kind: "data", pattern: "shared-*" },
      }),
    ]);

    const first = await page(ctx, { sort: NEWEST_FIRST, limit: 2 });
    assertEquals(first.names, ["s6", "s4"]);
    const second = await page(ctx, {
      sort: NEWEST_FIRST,
      limit: 2,
      cursor: first.nextCursor,
    });
    assertEquals(second.names, ["s2"]);
    assertEquals(second.nextCursor, undefined);

    // A cursor built by hand at a hidden row only moves the start.
    const forged = encodeQueryCursor(NEWEST_FIRST, {
      key: day(5),
      id: ["", repo.modelType.normalized, hidden.id, "s5", 1],
    });
    const after = await page(ctx, { sort: NEWEST_FIRST, cursor: forged });
    assertEquals(after.names, ["s4", "s2"]);
  });
});

Deno.test("data.query sort paging: a cursor for another sort or without one is refused", async () => {
  await withServeRepo(async (repo) => {
    const model = await saveModel(repo, "sessions");
    await saveSession(repo, model, "a", day(1));
    await saveSession(repo, model, "b", day(2));
    const ctx = createServeCtx(repo, [ALLOW_DATA]);
    const { nextCursor } = await page(ctx, { sort: NEWEST_FIRST, limit: 1 });

    for (
      const payload of [
        { cursor: nextCursor },
        {
          sort: { field: "tags.startedAt", direction: "asc" },
          cursor: nextCursor,
        },
      ]
    ) {
      const frames = await sendRequest(ctx, {
        type: "data.query",
        id: crypto.randomUUID(),
        payload: { predicate: PREDICATE, ...payload },
      });
      const error = errorFrame(frames);
      assert(error, JSON.stringify(frames));
      assertStringIncludes(JSON.stringify(error), "cursor");
    }
  });
});
