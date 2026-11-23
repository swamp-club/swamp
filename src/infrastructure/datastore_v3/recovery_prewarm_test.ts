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
import { join } from "@std/path";
import {
  PREWARM_MEMORY_FRACTION,
  prewarmForRecovery,
} from "./recovery_prewarm.ts";
import { findSpan, withCapturedSpans } from "../tracing/span_test_helpers.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-prewarm-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function file(dir: string, name: string, size: number): Promise<string> {
  const path = join(dir, name);
  await Deno.writeFile(path, new Uint8Array(size));
  return path;
}

/** memory that leaves a budget of exactly `budget` bytes */
function memoryFor(budget: number): () => number {
  return () => budget / PREWARM_MEMORY_FRACTION;
}

Deno.test("prewarmForRecovery: reads every file whole when the budget allows", async () => {
  await withTempDir(async (dir) => {
    const paths = [await file(dir, "a", 3000), await file(dir, "b", 2000)];
    const report = await prewarmForRecovery({
      paths,
      availableMemory: memoryFor(10_000),
      chunkBytes: 512,
    });
    assertEquals(report, {
      bytesRead: 5000,
      files: 2,
      budget: 10_000,
      capped: false,
      timedOut: false,
    });
  });
});

Deno.test("prewarmForRecovery: reads files in the order given and stops at the budget, partway through a file", async () => {
  await withTempDir(async (dir) => {
    const paths = [
      await file(dir, "first", 3000),
      await file(dir, "second", 3000),
      await file(dir, "third", 3000),
    ];
    const report = await prewarmForRecovery({
      paths,
      availableMemory: memoryFor(4000),
      chunkBytes: 512,
    });
    assertEquals(report.bytesRead, 4000);
    assertEquals(report.files, 2);
    assertEquals(report.capped, true);
  });
});

Deno.test("prewarmForRecovery: a budget spent exactly at a file's end opens no further file", async () => {
  await withTempDir(async (dir) => {
    const paths = [await file(dir, "a", 2048), await file(dir, "b", 2048)];
    const report = await prewarmForRecovery({
      paths,
      availableMemory: memoryFor(2048),
      chunkBytes: 512,
    });
    assertEquals(report.bytesRead, 2048);
    assertEquals(report.files, 1);
    assertEquals(report.capped, true);
  });
});

Deno.test("prewarmForRecovery: reads nothing when the host's free memory cannot be read", async () => {
  await withTempDir(async (dir) => {
    const report = await prewarmForRecovery({
      paths: [await file(dir, "a", 3000)],
      availableMemory: () => undefined,
    });
    assertEquals(report, {
      bytesRead: 0,
      files: 0,
      budget: 0,
      capped: false,
      timedOut: false,
    });
  });
});

Deno.test("prewarmForRecovery: stops at the deadline", async () => {
  await withTempDir(async (dir) => {
    let clock = 0;
    const report = await prewarmForRecovery({
      paths: [await file(dir, "a", 4096)],
      availableMemory: memoryFor(1_000_000),
      chunkBytes: 1024,
      deadlineMs: 2,
      // each look at the clock is one tick: the deadline passes after two chunks
      now: () => clock++,
    });
    assertEquals(report.timedOut, true);
    assertEquals(report.bytesRead, 1024);
  });
});

Deno.test("prewarmForRecovery: stops once the recovery's signal is aborted", async () => {
  await withTempDir(async (dir) => {
    const controller = new AbortController();
    controller.abort();
    const report = await prewarmForRecovery({
      paths: [await file(dir, "a", 4096)],
      availableMemory: memoryFor(1_000_000),
      signal: controller.signal,
    });
    assertEquals(report.bytesRead, 0);
  });
});

Deno.test("prewarmForRecovery: skips a missing file and carries on with the next", async () => {
  await withTempDir(async (dir) => {
    const report = await prewarmForRecovery({
      paths: [join(dir, "absent"), await file(dir, "present", 1000)],
      availableMemory: memoryFor(1_000_000),
    });
    assertEquals(report.bytesRead, 1000);
    assertEquals(report.files, 1);
  });
});

Deno.test("prewarmForRecovery: a file that cannot be read is skipped, never thrown", async () => {
  await withTempDir(async (dir) => {
    const report = await prewarmForRecovery({
      // a directory opens on POSIX but fails to read, and fails to open on Windows
      paths: [dir, await file(dir, "after", 500)],
      availableMemory: memoryFor(1_000_000),
    });
    assertEquals(report.bytesRead, 500);
  });
});

Deno.test("prewarmForRecovery: a file that grows while it is read is read only to its size when opened", async () => {
  await withTempDir(async (dir) => {
    const path = await file(dir, "growing", 2048);
    let grown = false;
    let clock = 0;
    const report = await prewarmForRecovery({
      paths: [path],
      availableMemory: memoryFor(1_000_000),
      chunkBytes: 1024,
      now: () => {
        // after the file is open and sized, before its first chunk is read
        if (!grown && clock > 0) {
          grown = true;
          Deno.writeFileSync(path, new Uint8Array(4096), { append: true });
        }
        return clock++;
      },
    });
    assertEquals(grown, true);
    assertEquals(report.bytesRead, 2048);
  });
});

Deno.test("prewarmForRecovery: records its read, file count, budget and why it stopped on its span", async () => {
  await withTempDir(async (dir) => {
    const paths = [await file(dir, "a", 3000)];
    await withCapturedSpans(async (spans) => {
      await prewarmForRecovery({
        paths,
        availableMemory: memoryFor(2000),
        chunkBytes: 512,
      });
      const span = findSpan(spans, "swamp.datastore.v3.recover.prewarm");
      const attr = (name: string) =>
        span.attributes[`swamp.datastore.v3.recover.prewarm.${name}`];
      assertEquals(attr("bytes_read"), 2000);
      assertEquals(attr("files"), 1);
      assertEquals(attr("budget"), 2000);
      assertEquals(attr("capped"), true);
      assertEquals(attr("timed_out"), false);
    });
  });
});
