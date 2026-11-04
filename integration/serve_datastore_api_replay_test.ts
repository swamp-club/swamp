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

import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import {
  countFeedReads,
  type FeedReads,
  save,
  seedHistory,
  withServer,
  writer,
} from "./serve_datastore_api_harness.ts";

async function readsForOneWriteAfter(history: number): Promise<FeedReads> {
  let reads: FeedReads = { commits: -1, fromStart: -1 };
  await withServer(writer(), async (server) => {
    await seedHistory(server, history);
    // a write before the measured one: what it leaves behind is what the
    // next write pays for
    const first = await save(server, "alice-token", 1, history);
    assertEquals(first.status, 200, JSON.stringify(first.json));
    reads = await countFeedReads(server.v3.commitStore, async () => {
      const measured = await save(server, "alice-token", 2, history + 1);
      assertEquals(measured.status, 200, JSON.stringify(measured.json));
    });
  });
  return reads;
}

Deno.test({
  name:
    "datastore API: a write's catch-up reads only the new commit, however long the history (swamp-club#4387)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const short = await readsForOneWriteAfter(10);
    const long = await readsForOneWriteAfter(1_000);
    assertEquals(short, { commits: 1, fromStart: 0 });
    assertEquals(long, short);
  },
});
