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
  countYamlRunFiles,
  deleteRunIndex,
  getIndexPath,
  isIndexStale,
  readRunIndex,
  RUNS_INDEX_FILENAME,
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
    assertEquals(loaded, SAMPLE_INDEX);
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
  assertEquals(isIndexStale(SAMPLE_INDEX, 2), false);
  assertEquals(isIndexStale(SAMPLE_INDEX, 3), true);
  assertEquals(isIndexStale(SAMPLE_INDEX, 1), true);
  assertEquals(isIndexStale(SAMPLE_INDEX, 0), true);
});

Deno.test("isIndexStale: empty index matches zero files", () => {
  assertEquals(isIndexStale({}, 0), false);
});
