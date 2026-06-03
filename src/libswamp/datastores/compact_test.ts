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

import { assertEquals } from "@std/assert";
import {
  datastoreCompact,
  type DatastoreCompactDeps,
  type DatastoreCompactEvent,
} from "./compact.ts";
import { createLibSwampContext } from "../context.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

async function collectEvents(
  gen: AsyncIterable<DatastoreCompactEvent>,
): Promise<DatastoreCompactEvent[]> {
  const events: DatastoreCompactEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function makeDeps(
  overrides: Partial<DatastoreCompactDeps> = {},
): DatastoreCompactDeps {
  return {
    checkpoint: () => ({ walPagesTotal: 10, walPagesCheckpointed: 10 }),
    vacuum: () => true,
    catalogDbSize: () => Promise.resolve(0),
    ...overrides,
  };
}

Deno.test("datastoreCompact: emits checkpointing, vacuuming, completed events", async () => {
  await initializeLogging({});
  const ctx = createLibSwampContext({});
  const events = await collectEvents(datastoreCompact(ctx, makeDeps()));

  const kinds = events.map((e) => e.kind);
  assertEquals(kinds, ["checkpointing", "vacuuming", "completed"]);
});

Deno.test("datastoreCompact: completed event includes WAL page counts", async () => {
  await initializeLogging({});
  const ctx = createLibSwampContext({});
  const deps = makeDeps({
    checkpoint: () => ({ walPagesTotal: 42, walPagesCheckpointed: 40 }),
    catalogDbSize: () => Promise.resolve(0),
  });

  const events = await collectEvents(datastoreCompact(ctx, deps));
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.walPagesTotal, 42);
    assertEquals(completed.data.walPagesCheckpointed, 40);
  }
});

Deno.test("datastoreCompact: reports db bytes reclaimed from before/after size", async () => {
  await initializeLogging({});
  const ctx = createLibSwampContext({});
  let call = 0;
  const deps = makeDeps({
    catalogDbSize: () => {
      call++;
      return Promise.resolve(call === 1 ? 1_000_000 : 600_000);
    },
  });

  const events = await collectEvents(datastoreCompact(ctx, deps));
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.dbBytesReclaimed, 400_000);
  }
});

Deno.test("datastoreCompact: dbBytesReclaimed is 0 when db size does not decrease", async () => {
  await initializeLogging({});
  const ctx = createLibSwampContext({});
  const deps = makeDeps({
    catalogDbSize: () => Promise.resolve(500_000),
  });

  const events = await collectEvents(datastoreCompact(ctx, deps));
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.dbBytesReclaimed, 0);
    assertEquals(completed.data.vacuumSkipped, false);
  }
});

Deno.test("datastoreCompact: reports vacuumSkipped when vacuum returns false", async () => {
  await initializeLogging({});
  const ctx = createLibSwampContext({});
  const deps = makeDeps({
    vacuum: () => false,
  });

  const events = await collectEvents(datastoreCompact(ctx, deps));
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.vacuumSkipped, true);
    assertEquals(completed.data.dbBytesReclaimed, 0);
  }
});
