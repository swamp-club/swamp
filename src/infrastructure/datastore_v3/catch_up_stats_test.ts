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
import { CatchUpStats } from "./catch_up_stats.ts";

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let next = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next === chunks.length) controller.close();
      else controller.enqueue(chunks[next++]);
    },
  }, { highWaterMark: 0 });
}

Deno.test("CatchUpStats.count: counts each chunk and its bytes, passing them on unchanged", async () => {
  const stats = new CatchUpStats();
  const read = await Array.fromAsync(
    stats.count(streamOf(new Uint8Array(3), new Uint8Array([1, 2]))),
  );
  assertEquals(read, [new Uint8Array(3), new Uint8Array([1, 2])]);
  assertEquals(stats.chunksFetched, 2);
  assertEquals(stats.chunkBytes, 5);
});

Deno.test("CatchUpStats.count: an error from the storage reaches the reader, uncounted", async () => {
  const stats = new CatchUpStats();
  const failing = new ReadableStream<Uint8Array>({
    pull() {
      throw new Error("chunk missing");
    },
  });
  let message = "";
  try {
    await Array.fromAsync(stats.count(failing));
  } catch (error) {
    message = (error as Error).message;
  }
  assertEquals(message, "chunk missing");
  assertEquals(stats.chunksFetched, 0);
});

Deno.test("CatchUpStats.noteWritten: content a later write or removal replaces counts as superseded", () => {
  const stats = new CatchUpStats();
  stats.noteWritten("ns", "a", 100);
  stats.noteWritten("ns", "b", 7);
  stats.noteWritten("other", "a", 50);
  assertEquals(stats.supersededBytes, 0);
  stats.noteWritten("ns", "a", 30);
  assertEquals(stats.supersededBytes, 100);
  stats.noteRemoved("ns", "a");
  assertEquals(stats.supersededBytes, 130);
  stats.noteRemoved("ns", "missing");
  assertEquals(stats.supersededBytes, 130);
  assertEquals(stats.filesWritten, 4);
});

Deno.test("CatchUpStats.attributes: write time excludes the fetches inside it", () => {
  const stats = new CatchUpStats();
  stats.contentMs = 10.4;
  stats.fetchMs = 4.2;
  const attributes = stats.attributes();
  assertEquals(attributes["swamp.datastore.v3.fetch_ms"], 4);
  assertEquals(attributes["swamp.datastore.v3.write_ms"], 6);
});
