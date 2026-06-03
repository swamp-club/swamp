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
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import {
  buildAggregateState,
  enumerateBundleFiles,
} from "./doctor_aggregate.ts";
import { makeExtension } from "../../domain/extensions/extension.ts";
import { makeSource } from "../../domain/extensions/source.ts";
import { makeSourceLocation } from "../../domain/extensions/source_location.ts";
import { makeBundleLocation } from "../../domain/extensions/bundle_location.ts";
import { ROW_STATE_TAGS } from "../../domain/extensions/row_state.ts";
import type { RowState } from "../../domain/extensions/row_state.ts";
import type { Extension } from "../../domain/extensions/extension.ts";

function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  return (async () => {
    const dir = await Deno.makeTempDir({ prefix: "swamp-agg-test-" });
    try {
      await fn(dir);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  })();
}

function makeTestSource(
  repoRoot: string,
  relPath: string,
  state: RowState,
): ReturnType<typeof makeSource> {
  const extRoot = repoRoot;
  const abs = join(repoRoot, relPath);
  return makeSource({
    id: makeSourceLocation(abs, extRoot),
    kind: "model",
    fingerprint: "fp-test",
    state,
    sourceMtime: "2026-01-01T00:00:00.000Z",
  });
}

function makeTestExtension(
  repoRoot: string,
  sources: ReturnType<typeof makeSource>[],
): Extension {
  return makeExtension({
    name: "@local/test",
    version: "0.0.0",
    origin: "local",
    extensionRoot: repoRoot,
    sources,
  });
}

Deno.test("buildAggregateState: counts each RowState tag correctly", async () => {
  await withTempDir(async (dir) => {
    // Create source files for non-terminal states so they aren't catalog orphans.
    const srcPath = join(dir, "extensions", "models", "test.ts");
    await ensureDir(join(dir, "extensions", "models"));
    await Deno.writeTextFile(srcPath, "// test");

    const bundle = makeBundleLocation(
      join(dir, ".swamp", "bundles", "test.js"),
      "fp-test",
    );

    const sources = [
      makeTestSource(dir, "extensions/models/test.ts", {
        tag: "Indexed",
        type: "@test/a",
        bundle,
      }),
    ];

    const ext = makeTestExtension(dir, sources);
    const report = await buildAggregateState({
      extensions: [ext],
      repoDir: dir,
    });

    assertEquals(report.totalSources, 1);
    assertEquals(report.healthySources, 1);
    assertEquals(report.aggregates.length, 1);
    assertEquals(report.aggregates[0].stateDistribution.Indexed, 1);
    assertEquals(report.aggregates[0].stateDistribution.Tombstoned, 0);
  });
});

Deno.test("buildAggregateState: detects catalog orphans when source missing", async () => {
  await withTempDir(async (dir) => {
    const bundle = makeBundleLocation(
      join(dir, ".swamp", "bundles", "missing.js"),
      "fp-test",
    );

    // Source file does NOT exist on disk — this is a catalog orphan.
    const sources = [
      makeTestSource(dir, "extensions/models/missing.ts", {
        tag: "Indexed",
        type: "@test/missing",
        bundle,
      }),
    ];

    const ext = makeTestExtension(dir, sources);
    const report = await buildAggregateState({
      extensions: [ext],
      repoDir: dir,
    });

    assertEquals(report.catalogOrphans.length, 1);
    assertEquals(report.orphanRowCount, 1);
  });
});

Deno.test("enumerateBundleFiles: finds .js files in bundle directories", async () => {
  await withTempDir(async (dir) => {
    // Create a bundle file.
    const bundleDir = join(dir, ".swamp", "bundles", "abc12345");
    await ensureDir(bundleDir);
    await Deno.writeTextFile(join(bundleDir, "model.js"), "// bundle");
    await Deno.writeTextFile(join(bundleDir, "readme.txt"), "not a bundle");

    const files = await enumerateBundleFiles(dir);
    assertEquals(files.length, 1);
    assertEquals(files[0].bundleDir, "bundles");
  });
});

Deno.test("enumerateBundleFiles: handles missing bundle directories gracefully", async () => {
  await withTempDir(async (dir) => {
    // No .swamp directory at all.
    const files = await enumerateBundleFiles(dir);
    assertEquals(files.length, 0);
  });
});

Deno.test("buildAggregateState: detects bundle orphans", async () => {
  await withTempDir(async (dir) => {
    // Create a bundle file that is NOT referenced by any catalog row.
    const bundleDir = join(dir, ".swamp", "bundles", "orphan-ns");
    await ensureDir(bundleDir);
    await Deno.writeTextFile(join(bundleDir, "orphan.js"), "// orphan");

    // Empty extension set — no catalog rows reference anything.
    const report = await buildAggregateState({
      extensions: [],
      repoDir: dir,
    });

    assertEquals(report.bundleOrphans.length, 1);
    assertEquals(report.orphanBundleFileCount, 1);
  });
});

Deno.test("buildAggregateState: all 7 RowState tags counted", async () => {
  await withTempDir(async (dir) => {
    const bundle = makeBundleLocation(
      join(dir, ".swamp", "bundles", "test.js"),
      "fp-test",
    );

    const states: RowState[] = [
      { tag: "Indexed", type: "@test/a", bundle },
      { tag: "Bundled", type: "@test/b", bundle, loadedInProcess: false },
      { tag: "BundleBuildFailed", lastError: "err" },
      { tag: "ValidationFailed", bundle, lastError: "err" },
      { tag: "EntryPointUnreadable", lastError: "err" },
      { tag: "OrphanedBundleOnly", bundle },
      { tag: "Tombstoned", reason: "source-deleted" },
    ];

    const sources = states.map((state, i) =>
      makeTestSource(dir, `extensions/models/s${i}.ts`, state)
    );

    const ext = makeTestExtension(dir, sources);
    const report = await buildAggregateState({
      extensions: [ext],
      repoDir: dir,
    });

    assertEquals(report.totalSources, 7);
    assertEquals(report.healthySources, 1);
    const dist = report.aggregates[0].stateDistribution;
    for (const tag of ROW_STATE_TAGS) {
      assertEquals(dist[tag], 1, `Expected 1 for ${tag}`);
    }
  });
});
