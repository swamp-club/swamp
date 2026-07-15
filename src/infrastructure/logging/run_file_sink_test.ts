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

import {
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { RunFileSink } from "./run_file_sink.ts";
import { SecretRedactor } from "../../domain/secrets/mod.ts";
import { join } from "@std/path";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "run-file-sink-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
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

    const handle = await sink.register(
      ["model", "method", "run", "my-model"],
      logPath,
    );

    const sinkFn = sink.sink;
    sinkFn(
      makeRecord(
        ["model", "method", "run", "my-model", "execute"],
        "hello world",
      ),
    );

    const content = await Deno.readTextFile(logPath);
    assertStringIncludes(content, "hello world");

    sink.unregister(handle);
  });
});

Deno.test("RunFileSink writes lines with an RFC3339 timestamp", async () => {
  await withTempDir(async (dir) => {
    const sink = new RunFileSink();
    const logPath = join(dir, "test.log");

    const handle = await sink.register(
      ["model", "method", "run", "my-model"],
      logPath,
    );

    const sinkFn = sink.sink;
    sinkFn(
      makeRecord(
        ["model", "method", "run", "my-model", "execute"],
        "hello world",
      ),
    );

    const content = await Deno.readTextFile(logPath);
    // Persisted run-file lines share the console text format: a full
    // ISO-8601 UTC timestamp with a `Z`, followed by a bracketed level.
    assertMatch(
      content,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[INF\] /m,
    );

    sink.unregister(handle);
  });
});

Deno.test("RunFileSink ignores records that don't match any prefix", async () => {
  await withTempDir(async (dir) => {
    const sink = new RunFileSink();
    const logPath = join(dir, "test.log");

    const handle = await sink.register(
      ["model", "method", "run", "my-model"],
      logPath,
    );

    const sinkFn = sink.sink;
    sinkFn(makeRecord(["workflow", "run", "wf1"], "should not appear"));

    const content = await Deno.readTextFile(logPath);
    assertEquals(content, "");

    sink.unregister(handle);
  });
});

Deno.test("RunFileSink writes to all matching prefixes", async () => {
  await withTempDir(async (dir) => {
    const sink = new RunFileSink();
    const broadPath = join(dir, "broad.log");
    const specificPath = join(dir, "specific.log");

    const broadHandle = await sink.register(
      ["model", "method", "run"],
      broadPath,
    );
    const specificHandle = await sink.register(
      ["model", "method", "run", "my-model"],
      specificPath,
    );

    const sinkFn = sink.sink;
    sinkFn(
      makeRecord(["model", "method", "run", "my-model", "execute"], "specific"),
    );
    sinkFn(makeRecord(["model", "method", "run", "other-model"], "broad"));

    const specificContent = await Deno.readTextFile(specificPath);
    assertStringIncludes(specificContent, "specific");

    // "specific" record also matches the broad prefix
    const broadContent = await Deno.readTextFile(broadPath);
    assertStringIncludes(broadContent, "broad");
    assertStringIncludes(broadContent, "specific");

    sink.unregister(broadHandle);
    sink.unregister(specificHandle);
  });
});

Deno.test("RunFileSink unregister closes file and stops writing", async () => {
  await withTempDir(async (dir) => {
    const sink = new RunFileSink();
    const logPath = join(dir, "test.log");

    const handle = await sink.register(
      ["model", "method", "run", "my-model"],
      logPath,
    );

    const sinkFn = sink.sink;
    sinkFn(makeRecord(["model", "method", "run", "my-model"], "before"));

    sink.unregister(handle);

    // After unregister, records should not be written
    sinkFn(makeRecord(["model", "method", "run", "my-model"], "after"));

    const content = await Deno.readTextFile(logPath);
    assertStringIncludes(content, "before");
    assertEquals(content.includes("after"), false);
  });
});

Deno.test("RunFileSink creates parent directories", async () => {
  await withTempDir(async (dir) => {
    const sink = new RunFileSink();
    const logPath = join(dir, "nested", "deep", "test.log");

    const handle = await sink.register(["workflow", "run"], logPath);

    const sinkFn = sink.sink;
    sinkFn(makeRecord(["workflow", "run", "wf1"], "nested dir test"));

    const content = await Deno.readTextFile(logPath);
    assertStringIncludes(content, "nested dir test");

    sink.unregister(handle);
  });
});

Deno.test("RunFileSink empty prefix matches all categories", async () => {
  await withTempDir(async (dir) => {
    const sink = new RunFileSink();
    const logPath = join(dir, "all.log");

    const handle = await sink.register([], logPath);

    const sinkFn = sink.sink;
    sinkFn(makeRecord(["workflow", "run", "wf1"], "workflow log"));
    sinkFn(
      makeRecord(
        ["model", "method", "run", "my-model", "execute"],
        "model log",
      ),
    );
    sinkFn(makeRecord(["something", "else"], "other log"));

    const content = await Deno.readTextFile(logPath);
    assertStringIncludes(content, "workflow log");
    assertStringIncludes(content, "model log");
    assertStringIncludes(content, "other log");

    sink.unregister(handle);
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

    // Files should be empty since no records matched after dispose
    const contentA = await Deno.readTextFile(join(dir, "a.log"));
    assertEquals(contentA, "");
  });
});

// Regression: issue #718. Concurrent runs (forEach children, parent+child) all
// register under the same catch-all `[]` prefix. Each registration must get its
// own writer keyed by a unique handle so one run can never close another run's
// open file descriptor ("Bad resource ID").

Deno.test("RunFileSink: concurrent same-prefix registrations get independent writers", async () => {
  await withTempDir(async (dir) => {
    const sink = new RunFileSink();
    const pathA = join(dir, "run-a.log");
    const pathB = join(dir, "run-b.log");

    // Two "runs" register under the identical `[]` prefix — the exact collision
    // that previously clobbered a shared map entry.
    const handleA = await sink.register([], pathA);
    const handleB = await sink.register([], pathB);
    assertNotEquals(handleA, handleB);

    const sinkFn = sink.sink;
    sinkFn(makeRecord(["workflow", "run", "wf1"], "shared record"));

    // Both writers survive and capture the record; neither close throws.
    assertStringIncludes(await Deno.readTextFile(pathA), "shared record");
    assertStringIncludes(await Deno.readTextFile(pathB), "shared record");

    sink.unregister(handleA);
    sink.unregister(handleB);
  });
});

Deno.test("RunFileSink: unregistering one writer leaves a same-prefix sibling working", async () => {
  await withTempDir(async (dir) => {
    const sink = new RunFileSink();
    const pathA = join(dir, "run-a.log");
    const pathB = join(dir, "run-b.log");

    const handleA = await sink.register([], pathA);
    const handleB = await sink.register([], pathB);

    const sinkFn = sink.sink;

    // Run A finishes first. Under the old shared-key design this evicted/closed
    // the sibling's fd; now it must only affect A.
    sink.unregister(handleA);
    sinkFn(makeRecord(["workflow", "run", "wf1"], "after-a-unregister"));

    // B is still open and still writing — no "Bad resource ID".
    assertStringIncludes(
      await Deno.readTextFile(pathB),
      "after-a-unregister",
    );
    assertEquals(
      (await Deno.readTextFile(pathA)).includes("after-a-unregister"),
      false,
    );

    sink.unregister(handleB);
  });
});

Deno.test("RunFileSink: unregister is a safe no-op for unknown, undefined, and double calls", async () => {
  await withTempDir(async (dir) => {
    const sink = new RunFileSink();
    const handle = await sink.register([], join(dir, "run.log"));

    // None of these may throw "Bad resource ID".
    sink.unregister(undefined);
    sink.unregister("not-a-real-handle");
    sink.unregister(handle);
    sink.unregister(handle); // double close of the same handle

    // Sink still works for surviving registrations.
    const pathB = join(dir, "run-b.log");
    const handleB = await sink.register([], pathB);
    sink.sink(makeRecord(["workflow", "run", "wf1"], "still works"));
    assertStringIncludes(await Deno.readTextFile(pathB), "still works");
    sink.unregister(handleB);
  });
});

Deno.test("RunFileSink: register is failure-atomic and leaves no state on a rejected path", async () => {
  await withTempDir(async (dir) => {
    const sink = new RunFileSink();

    // A healthy registration that must remain intact after the failure below.
    const goodPath = join(dir, "good.log");
    const goodHandle = await sink.register([], goodPath);

    // A path that escapes the boundary fails in assertSafePath, before any fd
    // is opened or the writer map is mutated.
    const escapingPath = join(dir, "..", "escape.log");
    let threw = false;
    let badHandle: string | undefined;
    try {
      badHandle = await sink.register([], escapingPath, undefined, dir);
    } catch {
      threw = true;
    }
    assertEquals(threw, true);

    // No handle was returned; unregistering the undefined handle is a no-op.
    sink.unregister(badHandle);

    // The good writer is untouched and still works.
    sink.sink(makeRecord(["workflow", "run", "wf1"], "survived"));
    assertStringIncludes(await Deno.readTextFile(goodPath), "survived");

    sink.unregister(goodHandle);
  });
});

Deno.test("RunFileSink: applies the per-writer secret redactor", async () => {
  await withTempDir(async (dir) => {
    const sink = new RunFileSink();
    const logPath = join(dir, "redacted.log");

    const redactor = new SecretRedactor();
    redactor.addSecret("supersecret");
    const handle = await sink.register([], logPath, redactor);

    sink.sink(makeRecord(["workflow", "run", "wf1"], "token=supersecret"));

    const content = await Deno.readTextFile(logPath);
    assertStringIncludes(content, "***");
    assertEquals(content.includes("supersecret"), false);

    sink.unregister(handle);
  });
});

Deno.test("RunFileSink.redactActive: scrubs secrets from active run redactors", async () => {
  await withTempDir(async (dir) => {
    const sink = new RunFileSink();

    const redactor = new SecretRedactor();
    redactor.addSecret("supersecret");
    const handle = await sink.register([], join(dir, "run.log"), redactor);

    assertEquals(
      sink.redactActive("bearer supersecret trailing"),
      "bearer *** trailing",
    );

    sink.unregister(handle);
  });
});

Deno.test("RunFileSink.redactActive: applies the union of every active redactor", async () => {
  await withTempDir(async (dir) => {
    const sink = new RunFileSink();

    const redactorA = new SecretRedactor();
    redactorA.addSecret("alpha-secret");
    const redactorB = new SecretRedactor();
    redactorB.addSecret("beta-secret");

    const handleA = await sink.register([], join(dir, "a.log"), redactorA);
    const handleB = await sink.register([], join(dir, "b.log"), redactorB);

    assertEquals(
      sink.redactActive("alpha-secret and beta-secret"),
      "*** and ***",
    );

    sink.unregister(handleA);
    sink.unregister(handleB);
  });
});

Deno.test("RunFileSink.redactActive: passes text through unchanged when no redactor is active", async () => {
  await withTempDir(async (dir) => {
    const sink = new RunFileSink();

    // No redactor at all.
    assertEquals(sink.redactActive("nothing to redact"), "nothing to redact");

    // A registered writer with no secrets must not alter text either.
    const handle = await sink.register(
      [],
      join(dir, "run.log"),
      new SecretRedactor(),
    );
    assertEquals(sink.redactActive("still untouched"), "still untouched");
    sink.unregister(handle);
  });
});
