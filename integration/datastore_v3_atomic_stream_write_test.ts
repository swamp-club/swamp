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
 * The read model's durable file writer (swamp-club#3239) on a real temp
 * directory.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { writeFileDurably } from "../src/infrastructure/datastore_v3/atomic_stream_write.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-durable-write-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const signal = () => AbortSignal.timeout(10_000);

Deno.test("writeFileDurably: writes bytes and streams, creating the directory", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "a", "b", "raw");
    await writeFileDurably(path, new Uint8Array([1, 2, 3]), signal());
    assertEquals(await Deno.readFile(path), new Uint8Array([1, 2, 3]));
    await writeFileDurably(
      path,
      ReadableStream.from([new Uint8Array([4]), new Uint8Array([5, 6])]),
      signal(),
    );
    assertEquals(await Deno.readFile(path), new Uint8Array([4, 5, 6]));
    assertEquals([...Deno.readDirSync(join(dir, "a", "b"))].length, 1);
  });
});

Deno.test("writeFileDurably: cancels a stream it never read when the directory cannot be made", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "file"), "x");
    let cancelled = false;
    const content = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    await assertRejects(() =>
      writeFileDurably(join(dir, "file", "raw"), content, signal())
    );
    assert(cancelled, "the unread stream was not cancelled");
  });
});

Deno.test("writeFileDurably: a stream that fails part-way leaves the old file and no temp file", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "raw");
    await Deno.writeTextFile(path, "old");
    let sent = false;
    const content = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) throw new Error("source failed");
        sent = true;
        controller.enqueue(new Uint8Array([1, 2]));
      },
    });
    await assertRejects(
      () => writeFileDurably(path, content, signal()),
      Error,
      "source failed",
    );
    assertEquals(await Deno.readTextFile(path), "old");
    assertEquals([...Deno.readDirSync(dir)].map((e) => e.name), ["raw"]);
  });
});
