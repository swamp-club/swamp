// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { RunFileSink } from "./run_file_sink.ts";
import { join } from "@std/path";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "run-file-sink-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function makeRecord(
  category: string[],
  message: string,
  level: "info" | "warning" | "error" = "info",
) {
  return {
    category,
    level,
    message: [message],
    rawMessage: message,
    timestamp: Date.now(),
    properties: {},
  };
}

Deno.test("RunFileSink writes log records to registered file", async () => {
  await withTempDir(async (dir) => {
    const sink = new RunFileSink();
    const logPath = join(dir, "test.log");

    await sink.register(["model", "method", "run", "my-model"], logPath);

    const sinkFn = sink.sink;
    sinkFn(
      makeRecord(
        ["model", "method", "run", "my-model", "execute"],
        "hello world",
      ),
    );

    // Allow async write to complete
    await new Promise((r) => setTimeout(r, 50));

    const content = await Deno.readTextFile(logPath);
    assertStringIncludes(content, "hello world");

    sink.unregister(["model", "method", "run", "my-model"]);
  });
});

Deno.test("RunFileSink ignores records that don't match any prefix", async () => {
  await withTempDir(async (dir) => {
    const sink = new RunFileSink();
    const logPath = join(dir, "test.log");

    await sink.register(["model", "method", "run", "my-model"], logPath);

    const sinkFn = sink.sink;
    sinkFn(makeRecord(["workflow", "run", "wf1"], "should not appear"));

    await new Promise((r) => setTimeout(r, 50));

    const content = await Deno.readTextFile(logPath);
    assertEquals(content, "");

    sink.unregister(["model", "method", "run", "my-model"]);
  });
});

Deno.test("RunFileSink writes to all matching prefixes", async () => {
  await withTempDir(async (dir) => {
    const sink = new RunFileSink();
    const broadPath = join(dir, "broad.log");
    const specificPath = join(dir, "specific.log");

    await sink.register(["model", "method", "run"], broadPath);
    await sink.register(["model", "method", "run", "my-model"], specificPath);

    const sinkFn = sink.sink;
    sinkFn(
      makeRecord(["model", "method", "run", "my-model", "execute"], "specific"),
    );
    sinkFn(makeRecord(["model", "method", "run", "other-model"], "broad"));

    await new Promise((r) => setTimeout(r, 50));

    const specificContent = await Deno.readTextFile(specificPath);
    assertStringIncludes(specificContent, "specific");

    // "specific" record also matches the broad prefix
    const broadContent = await Deno.readTextFile(broadPath);
    assertStringIncludes(broadContent, "broad");
    assertStringIncludes(broadContent, "specific");

    sink.unregister(["model", "method", "run"]);
    sink.unregister(["model", "method", "run", "my-model"]);
  });
});

Deno.test("RunFileSink unregister closes file and stops writing", async () => {
  await withTempDir(async (dir) => {
    const sink = new RunFileSink();
    const logPath = join(dir, "test.log");

    await sink.register(["model", "method", "run", "my-model"], logPath);

    const sinkFn = sink.sink;
    sinkFn(makeRecord(["model", "method", "run", "my-model"], "before"));
    await new Promise((r) => setTimeout(r, 50));

    sink.unregister(["model", "method", "run", "my-model"]);

    // After unregister, records should not be written
    sinkFn(makeRecord(["model", "method", "run", "my-model"], "after"));
    await new Promise((r) => setTimeout(r, 50));

    const content = await Deno.readTextFile(logPath);
    assertStringIncludes(content, "before");
    assertEquals(content.includes("after"), false);
  });
});

Deno.test("RunFileSink creates parent directories", async () => {
  await withTempDir(async (dir) => {
    const sink = new RunFileSink();
    const logPath = join(dir, "nested", "deep", "test.log");

    await sink.register(["workflow", "run"], logPath);

    const sinkFn = sink.sink;
    sinkFn(makeRecord(["workflow", "run", "wf1"], "nested dir test"));
    await new Promise((r) => setTimeout(r, 50));

    const content = await Deno.readTextFile(logPath);
    assertStringIncludes(content, "nested dir test");

    sink.unregister(["workflow", "run"]);
  });
});

Deno.test("RunFileSink empty prefix matches all categories", async () => {
  await withTempDir(async (dir) => {
    const sink = new RunFileSink();
    const logPath = join(dir, "all.log");

    await sink.register([], logPath);

    const sinkFn = sink.sink;
    sinkFn(makeRecord(["workflow", "run", "wf1"], "workflow log"));
    sinkFn(
      makeRecord(
        ["model", "method", "run", "my-model", "execute"],
        "model log",
      ),
    );
    sinkFn(makeRecord(["something", "else"], "other log"));

    await new Promise((r) => setTimeout(r, 50));

    const content = await Deno.readTextFile(logPath);
    assertStringIncludes(content, "workflow log");
    assertStringIncludes(content, "model log");
    assertStringIncludes(content, "other log");

    sink.unregister([]);
  });
});

Deno.test("RunFileSink dispose closes all writers", async () => {
  await withTempDir(async (dir) => {
    const sink = new RunFileSink();

    await sink.register(["a"], join(dir, "a.log"));
    await sink.register(["b"], join(dir, "b.log"));

    await sink.dispose();

    // After dispose, writing should silently fail (no match)
    const sinkFn = sink.sink;
    sinkFn(makeRecord(["a"], "should not write"));
    await new Promise((r) => setTimeout(r, 50));

    // Files should be empty since no records matched after dispose
    const contentA = await Deno.readTextFile(join(dir, "a.log"));
    assertEquals(contentA, "");
  });
});
