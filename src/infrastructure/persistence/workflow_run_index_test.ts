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

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  countYamlRunFiles,
  deleteRunIndex,
  fingerprintMatches,
  getIndexPath,
  INDEX_SCHEMA_VERSION,
  isIndexStale,
  readRunIndex,
  RUNS_INDEX_FILENAME,
  statRecord,
  withIndexQueue,
  type WorkflowRunIndex,
  writeRunIndex,
} from "./workflow_run_index.ts";

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

Deno.test("readRunIndex: returns null for corrupt JSON", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(getIndexPath(dir), "not valid json{{{");
    const result = await readRunIndex(dir);
    assertEquals(result, null);
  });
});

Deno.test("readRunIndex: returns null for JSON array", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(getIndexPath(dir), "[]");
    const result = await readRunIndex(dir);
    assertEquals(result, null);
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

Deno.test("readRunIndex: returns version 0 for unversioned legacy format", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      getIndexPath(dir),
      JSON.stringify(SAMPLE_INDEX),
    );
    const result = await readRunIndex(dir);
    assertEquals(result?.entries, SAMPLE_INDEX);
    assertEquals(result?.version, 0);
  });
});

Deno.test("readRunIndex: preserves entries from outdated schema version", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      getIndexPath(dir),
      JSON.stringify({
        version: INDEX_SCHEMA_VERSION - 1,
        entries: SAMPLE_INDEX,
      }),
    );
    const result = await readRunIndex(dir);
    assertEquals(result?.entries, SAMPLE_INDEX);
    assertEquals(result?.version, INDEX_SCHEMA_VERSION - 1);
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
  const dir = `/queue-test-${crypto.randomUUID()}`;
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

Deno.test("withIndexQueue: a failed function rejects its caller and does not hold up the next", async () => {
  const dir = `/queue-test-${crypto.randomUUID()}`;

  const failed = withIndexQueue(
    dir,
    () => Promise.reject(new Error("index write failed")),
  );
  const next = withIndexQueue(dir, () => Promise.resolve("ran"));

  await assertRejects(() => failed, Error, "index write failed");
  assertEquals(await next, "ran");
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
