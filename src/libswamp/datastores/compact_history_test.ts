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
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import {
  datastoreHistoryCompact,
  type DatastoreHistoryCompactEvent,
  type DatastoreHistoryCompaction,
} from "./compact_history.ts";

Deno.test("datastoreHistoryCompact: a v2 datastore has no history to compact", async () => {
  const events = await collect<DatastoreHistoryCompactEvent>(
    datastoreHistoryCompact(createLibSwampContext(), {}),
  );
  assertEquals(events, [{ kind: "completed", data: { applies: false } }]);
});

Deno.test("datastoreHistoryCompact: a v3 datastore compacts once, with the context's signal, and reports the outcome", async () => {
  const outcome: DatastoreHistoryCompaction = {
    outcome: "timed_out",
    budgetMs: 60_000,
    compacted: 250,
    batches: 1,
    released: 0,
    partitions: 3,
    compactedThrough: 250,
  };
  const ctx = createLibSwampContext();
  const signals: AbortSignal[] = [];
  const events = await collect<DatastoreHistoryCompactEvent>(
    datastoreHistoryCompact(ctx, {
      compact: (signal) => {
        signals.push(signal);
        return Promise.resolve(outcome);
      },
    }),
  );
  assertEquals(signals, [ctx.signal]);
  assertEquals(events, [
    { kind: "compacting" },
    { kind: "completed", data: { applies: true, ...outcome } },
  ]);
});
