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

import { configure, type LogRecord, reset } from "@logtape/logtape";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { exists } from "@std/fs";
import { join, relative } from "@std/path";
import {
  appendRunIndexLines,
  compactRunIndex,
  countYamlRunFiles,
  deleteRunIndex,
  dropRunIndexEntries,
  fingerprintMatches,
  getIndexPath,
  INDEX_COMPACTION_FLOOR_BYTES,
  INDEX_SCHEMA_VERSION,
  indexQueueGeneration,
  isIndexStale,
  needsCompaction,
  readRunIndex,
  readRunIndexHeader,
  removeRunIndexes,
  removeRunIndexFiles,
  removeStaleRunIndexes,
  RUNS_INDEX_FILENAME,
  RUNS_INDEX_LOCK_FILENAME,
  statRecord,
  withIndexQueue,
  type WorkflowRunIndex,
  writeRunIndex,
} from "./workflow_run_index.ts";

async function withIndexWarnings<T>(
  run: () => Promise<T>,
): Promise<{ result: T; warnings: string[] }> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      {
        category: ["workflow-runs", "index"],
        lowestLevel: "warning",
        sinks: ["capture"],
      },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
  });
  try {
    const result = await run();
    return {
      result,
      warnings: records.map((r) =>
        r.message.map((part) => String(part)).join("")
      ),
    };
  } finally {
    await reset();
  }
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

const SAMPLE_INDEX: WorkflowRunIndex = {
  "run-1": {
    status: "succeeded",
    workflowId: "wf-1",
    workflowName: "test-workflow",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    tags: { env: "prod" },
    inputs: { branch: "main" },
  },
  "run-2": {
    status: "suspended",
    workflowId: "wf-1",
    workflowName: "test-workflow",
    startedAt: "2026-01-02T00:00:00.000Z",
    tags: {},
    inputs: {},
  },
};

Deno.test("getIndexPath: joins directory with index filename", () => {
  assertEquals(
    getIndexPath("/some/dir"),
    join("/some/dir", RUNS_INDEX_FILENAME),
  );
});

Deno.test("writeRunIndex and readRunIndex: roundtrip", async () => {
  await withTempDir(async (dir) => {
    await writeRunIndex(dir, SAMPLE_INDEX);
    const loaded = await readRunIndex(dir);
    assertEquals(loaded?.entries, SAMPLE_INDEX);
    assertEquals(loaded?.version, INDEX_SCHEMA_VERSION);
  });
});

Deno.test("readRunIndex: returns null for missing file", async () => {
  await withTempDir(async (dir) => {
    const result = await readRunIndex(dir);
    assertEquals(result, null);
  });
});

Deno.test("readRunIndex: a file that is not a v5 index reads as version 0 with no entries", async () => {
  await withTempDir(async (dir) => {
    for (const content of ["not valid json{{{", "[]", "[]\n", "{}\n"]) {
      await Deno.writeTextFile(getIndexPath(dir), content);
      assertEquals(await readRunIndex(dir), { entries: {}, version: 0 });
    }
  });
});

Deno.test("deleteRunIndex: removes existing index file", async () => {
  await withTempDir(async (dir) => {
    await writeRunIndex(dir, SAMPLE_INDEX);
    await deleteRunIndex(dir);
    const result = await readRunIndex(dir);
    assertEquals(result, null);
  });
});

Deno.test("deleteRunIndex: no error for missing file", async () => {
  await withTempDir(async (dir) => {
    await deleteRunIndex(dir);
  });
});

Deno.test("countYamlRunFiles: counts only matching files", () => {
  const entries: Deno.DirEntry[] = [
    {
      name: "workflow-run-abc.yaml",
      isFile: true,
      isDirectory: false,
      isSymlink: false,
    },
    {
      name: "workflow-run-def.yaml",
      isFile: true,
      isDirectory: false,
      isSymlink: false,
    },
    {
      name: "workflow-run-abc.log",
      isFile: true,
      isDirectory: false,
      isSymlink: false,
    },
    {
      name: ".runs-index.json",
      isFile: true,
      isDirectory: false,
      isSymlink: false,
    },
    {
      name: "other-file.yaml",
      isFile: true,
      isDirectory: false,
      isSymlink: false,
    },
    {
      name: "workflow-run-ghi",
      isFile: false,
      isDirectory: true,
      isSymlink: false,
    },
  ];
  assertEquals(countYamlRunFiles(entries), 2);
});

Deno.test("isIndexStale: detects count mismatch", () => {
  const current = { entries: SAMPLE_INDEX, version: INDEX_SCHEMA_VERSION };
  assertEquals(isIndexStale(current, 2), false);
  assertEquals(isIndexStale(current, 3), true);
  assertEquals(isIndexStale(current, 1), true);
  assertEquals(isIndexStale(current, 0), true);
});

Deno.test("isIndexStale: empty index matches zero files", () => {
  assertEquals(
    isIndexStale({ entries: {}, version: INDEX_SCHEMA_VERSION }, 0),
    false,
  );
});

Deno.test("isIndexStale: outdated version is stale even with correct count", () => {
  const outdated = { entries: SAMPLE_INDEX, version: INDEX_SCHEMA_VERSION - 1 };
  assertEquals(isIndexStale(outdated, 2), true);
});

Deno.test("readRunIndex: an unversioned legacy index reads as stale", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(getIndexPath(dir), JSON.stringify(SAMPLE_INDEX));
    assertEquals(await readRunIndex(dir), { entries: {}, version: 0 });
  });
});

Deno.test("readRunIndex: a legacy JSON index of any size is reported stale without reading its body", async () => {
  await withTempDir(async (dir) => {
    const inputs = { intent: "x".repeat(1024 * 1024) };
    const entries = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`run-${i}`, {
        ...SAMPLE_INDEX["run-1"],
        inputs,
      }]),
    );
    await Deno.writeTextFile(
      getIndexPath(dir),
      JSON.stringify({ version: INDEX_SCHEMA_VERSION - 1, entries }),
    );
    const original = Deno.readFile;
    let bodyReads = 0;
    Deno.readFile = ((...args: Parameters<typeof original>) => {
      bodyReads++;
      return original(...args);
    }) as typeof original;
    try {
      assertEquals(await readRunIndex(dir), { entries: {}, version: 0 });
      assertEquals(await readRunIndexHeader(dir), {
        version: 0,
        compactedBytes: 0,
      });
    } finally {
      Deno.readFile = original;
    }
    assertEquals(bodyReads, 0);
  });
});

Deno.test("readRunIndex: reads current schema version", async () => {
  await withTempDir(async (dir) => {
    await writeRunIndex(dir, SAMPLE_INDEX);
    const result = await readRunIndex(dir);
    assertEquals(result?.entries, SAMPLE_INDEX);
    assertEquals(result?.version, INDEX_SCHEMA_VERSION);
  });
});

Deno.test("withIndexQueue: runs queued functions for one directory one at a time, in order", async () => {
  await withTempDir(async (dir) => {
    const events: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = withIndexQueue(dir, async () => {
      events.push("first:start");
      await held;
      events.push("first:end");
    });
    const second = withIndexQueue(dir, () => {
      events.push("second");
      return Promise.resolve("done");
    });
    release();

    assertEquals(await second, "done");
    await first;
    assertEquals(events, ["first:start", "first:end", "second"]);
  });
});

Deno.test("withIndexQueue: a failed function rejects its caller and does not hold up the next", async () => {
  await withTempDir(async (dir) => {
    const failed = withIndexQueue(
      dir,
      () => Promise.reject(new Error("index write failed")),
    );
    const next = withIndexQueue(dir, () => Promise.resolve("ran"));

    await assertRejects(() => failed, Error, "index write failed");
    assertEquals(await next, "ran");
  });
});

Deno.test("withIndexQueue: a compaction waits for another holder of the index lock, so a line it appends is kept", async () => {
  await withTempDir(async (dir) => {
    await writeRunIndex(dir, { "run-1": SAMPLE_INDEX["run-1"] });
    // A second open of the lock file contends as another process would.
    const other = await Deno.open(join(dir, RUNS_INDEX_LOCK_FILENAME), {
      read: true,
      write: true,
      create: true,
    });
    let compacted: Promise<void> | undefined;
    let started = false;
    try {
      await other.lock(true);
      compacted = withIndexQueue(dir, async () => {
        started = true;
        await compactRunIndex(dir);
      });
      const appended = await appendRunIndexLines(
        dir,
        [{ id: "run-2", entry: SAMPLE_INDEX["run-2"] }],
        { create: false },
      );
      assertEquals(appended.kind, "appended");
      assertEquals(started, false);
    } finally {
      other.close();
    }
    await compacted;

    assertEquals(started, true);
    const result = await readRunIndex(dir);
    assertEquals(result?.entries, SAMPLE_INDEX);
  });
});

Deno.test({
  name:
    "withIndexQueue: a waiter whose lock file its holder removed locks a new one",
  // Windows may keep a removed file's name until every handle on it closes
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, RUNS_INDEX_LOCK_FILENAME);
      const other = await Deno.open(lockPath, {
        read: true,
        write: true,
        create: true,
      });
      let queued: Promise<boolean> | undefined;
      try {
        await other.lock(true);
        queued = withIndexQueue(dir, async () => {
          const named = await Deno.stat(lockPath);
          return named.isFile;
        });
        await removeRunIndexFiles(dir);
      } finally {
        other.close();
      }

      assertEquals(await queued, true);
    });
  },
});

Deno.test("removeRunIndexFiles: removes the index and its lock file, and is a no-op where neither exists", async () => {
  await withTempDir(async (dir) => {
    await withIndexQueue(dir, () => writeRunIndex(dir, SAMPLE_INDEX));
    assertEquals(await exists(join(dir, RUNS_INDEX_LOCK_FILENAME)), true);

    await withIndexQueue(dir, () => removeRunIndexFiles(dir));

    assertEquals(await exists(getIndexPath(dir)), false);
    assertEquals(await exists(join(dir, RUNS_INDEX_LOCK_FILENAME)), false);
    await removeRunIndexFiles(join(dir, "absent"));
  });
});

Deno.test("withIndexQueue: runs the function unlocked, without a warning, where the lock file cannot be made", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "not-a-directory");
    await Deno.writeTextFile(file, "");

    const { result, warnings } = await withIndexWarnings(() =>
      withIndexQueue(join(file, "runs"), () => Promise.resolve("ran"))
    );

    assertEquals(result, "ran");
    assertEquals(warnings, []);
  });
});

Deno.test("withIndexQueue: runs the function unlocked, without a warning, where the runs directory is a file", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "runs");
    await Deno.writeTextFile(file, "");

    const { result, warnings } = await withIndexWarnings(() =>
      withIndexQueue(file, () => Promise.resolve("ran"))
    );

    assertEquals(result, "ran");
    assertEquals(warnings, []);
  });
});

Deno.test("withIndexQueue: warns when it runs the function unlocked for any other reason", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(join(dir, RUNS_INDEX_LOCK_FILENAME));

    const { result, warnings } = await withIndexWarnings(() =>
      withIndexQueue(dir, () => Promise.resolve("ran"))
    );

    assertEquals(result, "ran");
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0], "without its lock");
  });
});

Deno.test({
  name:
    "withIndexQueue: a lock file it cannot write is still locked through a read handle",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const lockPath = join(dir, RUNS_INDEX_LOCK_FILENAME);
      await Deno.writeTextFile(lockPath, "");
      await Deno.chmod(lockPath, 0o444);

      const lockedByQueue = await withIndexQueue(dir, async () => {
        // A second handle contends as another process would.
        const probe = await Deno.open(lockPath, { read: true });
        try {
          return !await probe.tryLock(true);
        } finally {
          probe.close();
        }
      });

      assertEquals(lockedByQueue, true);
    });
  },
});

Deno.test("indexQueueGeneration: identifies the queue tail across equivalent paths and clears it after failure", async () => {
  await withTempDir(async (dir) => {
    const alias = relative(Deno.cwd(), dir);
    const release = Promise.withResolvers<void>();
    const first = withIndexQueue(dir, () => release.promise);
    const generation = indexQueueGeneration(dir);
    assertEquals(indexQueueGeneration(alias), generation);
    const second = withIndexQueue(
      alias,
      () => Promise.reject(new Error("failed")),
    );
    assertEquals(indexQueueGeneration(dir) === generation, false);
    const rejected = assertRejects(() => second, Error, "failed");
    release.resolve();
    await Promise.all([first, rejected]);
    assertEquals(indexQueueGeneration(dir), undefined);
  });
});

Deno.test("statRecord: fingerprints a file, and is null for one that is gone", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "workflow-run-x.yaml");
    await Deno.writeTextFile(path, "status: running\n");

    const fingerprint = await statRecord(path);

    const info = await Deno.stat(path);
    assertEquals(fingerprint?.size, info.size);
    assertEquals(fingerprint?.mtimeMs, info.mtime?.getTime());
    assertEquals(fingerprint?.ino, info.ino ?? undefined);
    assertEquals(await statRecord(join(dir, "missing.yaml")), null);
  });
});

Deno.test("fingerprintMatches: only an object with every field equal matches", () => {
  const current = { mtimeMs: 10, size: 20, ctimeMs: 30, ino: 40 };

  assertEquals(fingerprintMatches({ ...current }, current), true);
  for (
    const stored of [
      undefined,
      null,
      "junk",
      42,
      { ...current, mtimeMs: 11 },
      { ...current, size: 21 },
      { ...current, ctimeMs: 31 },
      { ...current, ino: 41 },
      { mtimeMs: 10, size: 20 },
      { ...current, mtimeMs: "10" },
    ]
  ) {
    assertEquals(fingerprintMatches(stored, current), false, String(stored));
  }
  // A platform without ctime or inode leaves both out on either side.
  assertEquals(
    fingerprintMatches({ mtimeMs: 10, size: 20 }, { mtimeMs: 10, size: 20 }),
    true,
  );
});

Deno.test("removeRunIndexes: removes each workflow's run index and nothing else, and a missing root or index is no failure (swamp-club#3802)", async () => {
  await withTempDir(async (dir) => {
    await removeRunIndexes(join(dir, "missing"));
    const root = join(dir, "workflow-runs");
    await Deno.mkdir(join(root, "wf-a"), { recursive: true });
    await writeRunIndex(join(root, "wf-a"), SAMPLE_INDEX);
    await Deno.mkdir(join(root, "wf-b"), { recursive: true });
    await Deno.writeTextFile(join(root, "wf-a", "workflow-run-1.yaml"), "x");
    await Deno.writeTextFile(join(root, "stray-file"), "x");
    await removeRunIndexes(root);
    assertEquals(await readRunIndex(join(root, "wf-a")), null);
    assertEquals(
      await Deno.readTextFile(join(root, "wf-a", "workflow-run-1.yaml")),
      "x",
    );
    assertEquals(await Deno.readTextFile(join(root, "stray-file")), "x");
  });
});

Deno.test("removeStaleRunIndexes: removes the checkout's run indexes, and a removal that fails is warned about, never thrown (swamp-club#3802)", async () => {
  await withTempDir(async (repo) => {
    const runs = join(repo, ".swamp", "workflow-runs");
    await Deno.mkdir(join(runs, "wf-a"), { recursive: true });
    await writeRunIndex(join(runs, "wf-a"), SAMPLE_INDEX);
    await removeStaleRunIndexes(repo);
    assertEquals(await readRunIndex(join(runs, "wf-a")), null);
  });
  await withTempDir(async (repo) => {
    await Deno.mkdir(join(repo, ".swamp"), { recursive: true });
    await Deno.writeTextFile(join(repo, ".swamp", "workflow-runs"), "x");
    await removeStaleRunIndexes(repo);
  });
});

Deno.test("dropRunIndexEntries: drops the entries of the run records named, keeps the rest, and leaves an absent or other-version index (swamp-club#3985)", async () => {
  await withTempDir(async (repo) => {
    const runs = join(repo, ".swamp", "workflow-runs");
    const entry = SAMPLE_INDEX["run-1"];
    await Deno.mkdir(join(runs, "wf-a"), { recursive: true });
    await writeRunIndex(join(runs, "wf-a"), {
      "run-1": entry,
      "run-2": entry,
    });
    await Deno.mkdir(join(runs, "wf-b"), { recursive: true });
    await writeRunIndex(join(runs, "wf-b"), { "run-1": entry });
    await Deno.mkdir(join(runs, "wf-old"), { recursive: true });
    const oldIndex = JSON.stringify({ version: 1, entries: { "run-1": {} } });
    await Deno.writeTextFile(getIndexPath(join(runs, "wf-old")), oldIndex);

    await dropRunIndexEntries(repo, [
      "workflow-runs/wf-a/workflow-run-run-1.yaml",
      "workflow-runs/wf-b/workflow-run-run-1.log",
      "data/wf-b/workflow-run-run-1.yaml",
      "workflow-runs/wf-b/x/workflow-run-run-1.yaml",
      "workflow-runs/wf-old/workflow-run-run-1.yaml",
      "workflow-runs/wf-none/workflow-run-run-1.yaml",
    ]);

    assertEquals((await readRunIndex(join(runs, "wf-a")))?.entries, {
      "run-2": entry,
    });
    assertEquals((await readRunIndex(join(runs, "wf-b")))?.entries, {
      "run-1": entry,
    });
    assertEquals(
      await Deno.readTextFile(getIndexPath(join(runs, "wf-old"))),
      oldIndex,
    );
    assertEquals(await readRunIndex(join(runs, "wf-none")), null);
    assertEquals(await exists(join(runs, "wf-none")), false);
  });
});

Deno.test("dropRunIndexEntries: an index it cannot read is warned about and skipped, and the other workflows are still changed", async () => {
  await withTempDir(async (repo) => {
    const runs = join(repo, ".swamp", "workflow-runs");
    const entry = SAMPLE_INDEX["run-1"];
    await Deno.mkdir(getIndexPath(join(runs, "wf-bad")), { recursive: true });
    await Deno.mkdir(join(runs, "wf-good"), { recursive: true });
    await writeRunIndex(join(runs, "wf-good"), {
      "run-1": entry,
      "run-2": entry,
    });

    const { warnings } = await withIndexWarnings(() =>
      dropRunIndexEntries(repo, [
        "workflow-runs/wf-bad/workflow-run-run-1.yaml",
        "workflow-runs/wf-good/workflow-run-run-1.yaml",
      ])
    );

    assertEquals((await readRunIndex(join(runs, "wf-good")))?.entries, {
      "run-2": entry,
    });
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0], "wf-bad");
  });
});

Deno.test("appendRunIndexLines: the last line for a run wins and a removal line drops it", async () => {
  await withTempDir(async (dir) => {
    await writeRunIndex(dir, SAMPLE_INDEX);
    const succeeded = { ...SAMPLE_INDEX["run-2"], status: "succeeded" };
    const result = await appendRunIndexLines(dir, [
      { id: "run-2", entry: succeeded },
      { id: "run-1", removed: true },
      { id: "run-3", entry: SAMPLE_INDEX["run-1"] },
    ], { create: false });

    assertEquals(result.kind, "appended");
    assertEquals((await readRunIndex(dir))?.entries, {
      "run-2": succeeded,
      "run-3": SAMPLE_INDEX["run-1"],
    });
  });
});

Deno.test("appendRunIndexLines: adds to the file without rewriting it", async () => {
  await withTempDir(async (dir) => {
    await writeRunIndex(dir, SAMPLE_INDEX);
    const before = await Deno.readTextFile(getIndexPath(dir));
    const line = { id: "run-3", entry: SAMPLE_INDEX["run-1"] };
    await appendRunIndexLines(dir, [line], { create: false });

    assertEquals(
      await Deno.readTextFile(getIndexPath(dir)),
      `${before}${JSON.stringify(line)}\n`,
    );
  });
});

Deno.test("appendRunIndexLines: creates a missing index only when asked, and leaves a legacy one for the caller", async () => {
  await withTempDir(async (dir) => {
    const line = { id: "run-1", entry: SAMPLE_INDEX["run-1"] };
    assertEquals(
      await appendRunIndexLines(dir, [line], { create: false }),
      { kind: "absent" },
    );
    assertEquals(await readRunIndex(dir), null);

    const created = await appendRunIndexLines(dir, [line], { create: true });
    assertEquals(created.kind, "appended");
    assertEquals((await readRunIndex(dir))?.entries, {
      "run-1": SAMPLE_INDEX["run-1"],
    });

    const legacy = JSON.stringify({ version: 4, entries: SAMPLE_INDEX });
    await Deno.writeTextFile(getIndexPath(dir), legacy);
    assertEquals(
      await appendRunIndexLines(dir, [line], { create: true }),
      { kind: "stale" },
    );
    assertEquals(await Deno.readTextFile(getIndexPath(dir)), legacy);
  });
});

Deno.test("readRunIndex: a torn line marks the index damaged, which makes it stale", async () => {
  await withTempDir(async (dir) => {
    await writeRunIndex(dir, SAMPLE_INDEX);
    await Deno.writeTextFile(getIndexPath(dir), '{"id":"run-1","ent', {
      append: true,
    });

    const result = await readRunIndex(dir);

    assertEquals(result?.entries, SAMPLE_INDEX);
    assertEquals(result?.damaged, true);
    assertEquals(isIndexStale(result!, 2), true);
  });
});

Deno.test("readRunIndex: a line that is not a change marks the index damaged", async () => {
  await withTempDir(async (dir) => {
    for (const line of ["[]", '{"entry":{}}', '{"id":"run-1","entry":[]}']) {
      await writeRunIndex(dir, SAMPLE_INDEX);
      await Deno.writeTextFile(getIndexPath(dir), `${line}\n`, {
        append: true,
      });
      assertEquals((await readRunIndex(dir))?.damaged, true);
    }
  });
});

Deno.test("readRunIndex: a run id named __proto__ stays an own entry", async () => {
  await withTempDir(async (dir) => {
    await writeRunIndex(dir, {});
    await appendRunIndexLines(dir, [{
      id: "__proto__",
      entry: SAMPLE_INDEX["run-1"],
    }], { create: false });

    const entries = (await readRunIndex(dir))!.entries;

    assertEquals(Object.hasOwn(entries, "__proto__"), true);
    assertEquals(Object.getPrototypeOf(entries), Object.prototype);
  });
});

Deno.test("readRunIndex: an index larger than one decoded chunk reads every entry", async () => {
  await withTempDir(async (dir) => {
    const entries: WorkflowRunIndex = {};
    for (let i = 0; i < 4000; i++) {
      entries[`run-${i}`] = {
        ...SAMPLE_INDEX["run-1"],
        inputs: { note: `é€${"n".repeat(500)}${i}` },
      };
    }
    await writeRunIndex(dir, entries);
    assertEquals(
      (await Deno.stat(getIndexPath(dir))).size > 2 * 1024 * 1024,
      true,
    );

    assertEquals((await readRunIndex(dir))?.entries, entries);
  });
});

Deno.test("compactRunIndex: rewrites one line per live run and records its size in the header", async () => {
  await withTempDir(async (dir) => {
    await writeRunIndex(dir, SAMPLE_INDEX);
    for (let i = 0; i < 50; i++) {
      await appendRunIndexLines(dir, [{
        id: "run-2",
        entry: {
          ...SAMPLE_INDEX["run-2"],
          stepProgress: { completed: i, total: 50 },
        },
      }], { create: false });
    }
    const before = (await readRunIndex(dir))!.entries;

    await compactRunIndex(dir);

    const text = await Deno.readTextFile(getIndexPath(dir));
    const lines = text.trimEnd().split("\n");
    assertEquals(lines.length, 3);
    const header = await readRunIndexHeader(dir);
    assertEquals(header?.version, INDEX_SCHEMA_VERSION);
    assertEquals(
      header?.compactedBytes,
      new TextEncoder().encode(lines.slice(1).join("\n") + "\n").length,
    );
    assertEquals((await readRunIndex(dir))?.entries, before);
  });
});

Deno.test("compactRunIndex: leaves a damaged index for the repair pass", async () => {
  await withTempDir(async (dir) => {
    await writeRunIndex(dir, SAMPLE_INDEX);
    await Deno.writeTextFile(getIndexPath(dir), "torn", { append: true });
    const before = await Deno.readTextFile(getIndexPath(dir));

    await compactRunIndex(dir);

    assertEquals(await Deno.readTextFile(getIndexPath(dir)), before);
  });
});

Deno.test("needsCompaction: only past the floor and twice the compacted size", () => {
  const floor = INDEX_COMPACTION_FLOOR_BYTES;
  assertEquals(needsCompaction({ size: floor, compactedBytes: 0 }), false);
  assertEquals(needsCompaction({ size: floor + 1, compactedBytes: 0 }), true);
  assertEquals(
    needsCompaction({ size: 3 * floor, compactedBytes: 2 * floor }),
    false,
  );
  assertEquals(
    needsCompaction({ size: 4 * floor + 1, compactedBytes: 2 * floor }),
    true,
  );
});

Deno.test("appendRunIndexLines: a line appended after a torn tail still reads", async () => {
  await withTempDir(async (dir) => {
    await writeRunIndex(dir, {});
    await Deno.writeTextFile(getIndexPath(dir), '{"id":"run-1","ent', {
      append: true,
    });

    await appendRunIndexLines(dir, [{
      id: "run-2",
      entry: SAMPLE_INDEX["run-2"],
    }], { create: false });

    const result = await readRunIndex(dir);
    assertEquals(result?.entries, { "run-2": SAMPLE_INDEX["run-2"] });
    assertEquals(result?.damaged, true);
  });
});
