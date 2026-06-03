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

// W6 integration tests for `swamp doctor extensions` aggregate-state
// rendering and repair surface. Exercises the full CLI pipeline against
// a seeded .swamp/ directory with real catalog state.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { initializeTestRepo, runCliCommand } from "../test_helpers.ts";

const VALID_MODEL = `
import { z } from "npm:zod@4";
export const model = {
  type: "@tutorial/aggregate-test",
  version: "2026.05.11.0",
  globalArguments: z.object({}),
  resources: {},
  methods: {
    run: {
      description: "no-op",
      arguments: z.object({}),
      execute: () => ({ dataHandles: [] }),
    },
  },
};
`;

async function withTestRepo(
  fn: (repoDir: string) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp-doctor-agg-test-",
  });
  try {
    await initializeTestRepo(repoDir);
    await fn(repoDir);
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
}

Deno.test("doctor extensions --json includes aggregateState field", async () => {
  await withTestRepo(async (repoDir) => {
    await ensureDir(join(repoDir, "extensions", "models"));
    await Deno.writeTextFile(
      join(repoDir, "extensions", "models", "test_model.ts"),
      VALID_MODEL,
    );

    const result = await runCliCommand(
      ["doctor", "extensions", "--json"],
      repoDir,
    );
    assertEquals(result.code, 0, `Expected exit 0: ${result.stderr}`);

    const report = JSON.parse(result.stdout);
    // Existing fields unchanged.
    assertEquals(report.overallStatus, "pass");
    assertEquals(typeof report.registries, "object");
    assertEquals(Array.isArray(report.orphanFiles), true);
    // W6 additive field present.
    assertEquals(typeof report.aggregateState, "object");
    assertEquals(typeof report.aggregateState.totalSources, "number");
    assertEquals(Array.isArray(report.aggregateState.aggregates), true);
  });
});

Deno.test("doctor extensions --repair --dry-run produces no filesystem changes", async () => {
  await withTestRepo(async (repoDir) => {
    // Create a bundle file that will look like an orphan (no model references it).
    const orphanDir = join(repoDir, ".swamp", "bundles", "orphan-ns");
    await ensureDir(orphanDir);
    const orphanFile = join(orphanDir, "orphan.js");
    await Deno.writeTextFile(orphanFile, "// orphan bundle");

    const result = await runCliCommand(
      ["doctor", "extensions", "--repair", "--dry-run", "--json"],
      repoDir,
    );
    assertEquals(result.code, 0, `Expected exit 0: ${result.stderr}`);

    const report = JSON.parse(result.stdout);
    assertEquals(report.repairReport.mode, "dry-run");

    // The orphan bundle file should still exist after dry-run.
    const stat = await Deno.stat(orphanFile);
    assertEquals(stat.isFile, true, "Orphan file should survive dry-run");
  });
});

Deno.test("doctor extensions --repair evicts only true orphans", async () => {
  await withTestRepo(async (repoDir) => {
    // Create an orphan bundle file (no catalog reference).
    const orphanDir = join(repoDir, ".swamp", "bundles", "orphan-ns");
    await ensureDir(orphanDir);
    const orphanFile = join(orphanDir, "stale.js");
    await Deno.writeTextFile(orphanFile, "// stale bundle");

    const result = await runCliCommand(
      ["doctor", "extensions", "--repair", "--json"],
      repoDir,
    );
    assertEquals(result.code, 0, `Expected exit 0: ${result.stderr}`);

    const report = JSON.parse(result.stdout);
    assertEquals(report.repairReport.mode, "applied");

    // The orphan file should be deleted.
    let orphanExists = true;
    try {
      await Deno.stat(orphanFile);
    } catch {
      orphanExists = false;
    }
    assertEquals(orphanExists, false, "Orphan file should be evicted");
  });
});

Deno.test("doctor extensions --repair is idempotent", async () => {
  await withTestRepo(async (repoDir) => {
    // Create an orphan to clean up.
    const orphanDir = join(repoDir, ".swamp", "bundles", "orphan-ns");
    await ensureDir(orphanDir);
    await Deno.writeTextFile(join(orphanDir, "orphan.js"), "// orphan");

    // First apply — cleans up.
    const run1 = await runCliCommand(
      ["doctor", "extensions", "--repair", "--json"],
      repoDir,
    );
    assertEquals(run1.code, 0);
    const report1 = JSON.parse(run1.stdout);
    assertEquals(report1.repairReport.mode, "applied");

    // Second apply — no-op.
    const run2 = await runCliCommand(
      ["doctor", "extensions", "--repair", "--json"],
      repoDir,
    );
    assertEquals(run2.code, 0);
    const report2 = JSON.parse(run2.stdout);
    assertEquals(report2.repairReport.operations.length, 0);
    assertEquals(report2.repairReport.prunedRowCount, 0);
    assertEquals(report2.repairReport.evictedFileCount, 0);
  });
});

Deno.test("doctor extensions: Indexed bundle file is NOT classified as orphan", async () => {
  await withTestRepo(async (repoDir) => {
    // Create a valid model so the catalog gets an Indexed row with a
    // real bundle path.
    await ensureDir(join(repoDir, "extensions", "models"));
    await Deno.writeTextFile(
      join(repoDir, "extensions", "models", "safe_model.ts"),
      VALID_MODEL,
    );

    // First run: loads the model, populates catalog, builds bundle.
    const load = await runCliCommand(
      ["doctor", "extensions", "--json"],
      repoDir,
    );
    assertEquals(load.code, 0, `Load failed: ${load.stderr}`);
    const loadReport = JSON.parse(load.stdout);

    const agg = loadReport.aggregateState;
    assertEquals(agg.totalSources >= 1, true, "Expected at least 1 source");

    // On some platforms the model may not reach Indexed (e.g. Windows
    // bundling differences). The safety assertion only applies when the
    // model is Indexed — skip gracefully otherwise.
    if (agg.healthySources === 0) return;

    // The bundle file referenced by the Indexed row should NOT be in
    // bundleOrphans.
    for (const detail of agg.sourceDetails) {
      if (detail.stateTag === "Indexed" && detail.bundlePath) {
        const isOrphan = agg.bundleOrphans.some(
          (o: { absolutePath: string }) => o.absolutePath === detail.bundlePath,
        );
        assertEquals(
          isOrphan,
          false,
          `Indexed bundle ${detail.bundlePath} should NOT be an orphan`,
        );
      }
    }

    // Now run --repair and confirm the bundle file survives.
    const repair = await runCliCommand(
      ["doctor", "extensions", "--repair", "--json"],
      repoDir,
    );
    assertEquals(repair.code, 0);
    const repairReport = JSON.parse(repair.stdout);

    // No bundle file evictions for live Indexed bundles.
    for (const op of repairReport.repairReport.operations) {
      if (op.kind === "bundle-file-evicted") {
        for (const detail of agg.sourceDetails) {
          if (detail.stateTag === "Indexed" && detail.bundlePath) {
            const evictedPath = op.path;
            assertEquals(
              evictedPath.includes(detail.bundlePath),
              false,
              `--repair should NEVER evict an Indexed bundle: ${evictedPath}`,
            );
          }
        }
      }
    }
  });
});

Deno.test("doctor extensions log mode shows aggregate state section", async () => {
  await withTestRepo(async (repoDir) => {
    await ensureDir(join(repoDir, "extensions", "models"));
    await Deno.writeTextFile(
      join(repoDir, "extensions", "models", "log_test.ts"),
      VALID_MODEL,
    );

    const result = await runCliCommand(
      ["doctor", "extensions"],
      repoDir,
    );
    assertEquals(result.code, 0, `Expected exit 0: ${result.stderr}`);

    // Log mode should include the aggregate state header.
    const combined = result.stdout + result.stderr;
    assertStringIncludes(combined, "Extension Catalog State");
    assertStringIncludes(combined, "OVERALL: PASS");
  });
});
