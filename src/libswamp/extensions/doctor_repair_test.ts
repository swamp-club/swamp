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

import { assertEquals, assertFalse } from "@std/assert";
import { join } from "@std/path";
import { repairExtensions } from "./doctor_repair.ts";
import type { DoctorAggregateReport } from "./doctor_aggregate.ts";

function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  return (async () => {
    const dir = await Deno.makeTempDir({ prefix: "swamp-repair-test-" });
    try {
      await fn(dir);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  })();
}

function makeEmptyReport(
  overrides?: Partial<DoctorAggregateReport>,
): DoctorAggregateReport {
  return {
    aggregates: [],
    sourceDetails: [],
    catalogOrphans: [],
    bundleOrphans: [],
    totalSources: 0,
    healthySources: 0,
    orphanRowCount: 0,
    orphanBundleFileCount: 0,
    ...overrides,
  };
}

Deno.test("repairExtensions: dry-run does not call deleteBySourcePaths", async () => {
  let deleteCalled = false;
  const report = makeEmptyReport({
    sourceDetails: [
      {
        sourcePath: "/fake/tombstoned.ts",
        stateTag: "Tombstoned",
        fingerprint: "",
        bundlePath: "",
        kind: "model",
      },
    ],
  });

  const result = await repairExtensions({
    aggregateReport: report,
    deleteBySourcePaths: () => {
      deleteCalled = true;
      return 0;
    },
    apply: false,
  });

  assertEquals(result.mode, "dry-run");
  assertEquals(result.prunedRowCount, 1);
  assertFalse(deleteCalled);
});

Deno.test("repairExtensions: apply calls deleteBySourcePaths", async () => {
  const deleted: string[] = [];
  const report = makeEmptyReport({
    sourceDetails: [
      {
        sourcePath: "/fake/tombstoned.ts",
        stateTag: "Tombstoned",
        fingerprint: "",
        bundlePath: "",
        kind: "model",
      },
    ],
  });

  const result = await repairExtensions({
    aggregateReport: report,
    deleteBySourcePaths: (paths) => {
      deleted.push(...paths);
      return paths.length;
    },
    apply: true,
  });

  assertEquals(result.mode, "applied");
  assertEquals(deleted.length, 1);
  assertEquals(deleted[0], "/fake/tombstoned.ts");
});

Deno.test("repairExtensions: never touches Indexed rows", async () => {
  const deleted: string[] = [];
  const report = makeEmptyReport({
    sourceDetails: [
      {
        sourcePath: "/fake/indexed.ts",
        stateTag: "Indexed",
        fingerprint: "abc",
        bundlePath: "/fake/bundle.js",
        kind: "model",
      },
    ],
  });

  const result = await repairExtensions({
    aggregateReport: report,
    deleteBySourcePaths: (paths) => {
      deleted.push(...paths);
      return paths.length;
    },
    apply: true,
  });

  assertEquals(result.prunedRowCount, 0);
  assertEquals(deleted.length, 0);
});

Deno.test("repairExtensions: never touches Bundled rows", async () => {
  const deleted: string[] = [];
  const report = makeEmptyReport({
    sourceDetails: [
      {
        sourcePath: "/fake/bundled.ts",
        stateTag: "Bundled",
        fingerprint: "abc",
        bundlePath: "/fake/bundle.js",
        kind: "model",
      },
    ],
  });

  const result = await repairExtensions({
    aggregateReport: report,
    deleteBySourcePaths: (paths) => {
      deleted.push(...paths);
      return paths.length;
    },
    apply: true,
  });

  assertEquals(result.prunedRowCount, 0);
  assertEquals(deleted.length, 0);
});

Deno.test("repairExtensions: evicts orphan bundle files on apply", async () => {
  await withTempDir(async (dir) => {
    const orphanPath = join(dir, "orphan.js");
    await Deno.writeTextFile(orphanPath, "// orphan");

    const report = makeEmptyReport({
      bundleOrphans: [
        {
          absolutePath: orphanPath,
          repoRelativePath: ".swamp/bundles/ns/orphan.js",
          bundleDir: "bundles",
        },
      ],
      orphanBundleFileCount: 1,
    });

    const result = await repairExtensions({
      aggregateReport: report,
      deleteBySourcePaths: () => 0,
      apply: true,
    });

    assertEquals(result.evictedFileCount, 1);

    // Verify the file was actually deleted.
    let exists = true;
    try {
      await Deno.stat(orphanPath);
    } catch {
      exists = false;
    }
    assertFalse(exists);
  });
});

Deno.test("repairExtensions: dry-run does not evict bundle files", async () => {
  await withTempDir(async (dir) => {
    const orphanPath = join(dir, "orphan.js");
    await Deno.writeTextFile(orphanPath, "// orphan");

    const report = makeEmptyReport({
      bundleOrphans: [
        {
          absolutePath: orphanPath,
          repoRelativePath: ".swamp/bundles/ns/orphan.js",
          bundleDir: "bundles",
        },
      ],
      orphanBundleFileCount: 1,
    });

    const result = await repairExtensions({
      aggregateReport: report,
      deleteBySourcePaths: () => 0,
      apply: false,
    });

    assertEquals(result.mode, "dry-run");
    assertEquals(result.evictedFileCount, 1);

    // File should still exist.
    const stat = await Deno.stat(orphanPath);
    assertEquals(stat.isFile, true);
  });
});

Deno.test("repairExtensions: idempotent — clean state yields zero operations", async () => {
  const report = makeEmptyReport();

  const result = await repairExtensions({
    aggregateReport: report,
    deleteBySourcePaths: () => 0,
    apply: true,
  });

  assertEquals(result.operations.length, 0);
  assertEquals(result.prunedRowCount, 0);
  assertEquals(result.evictedFileCount, 0);
});
