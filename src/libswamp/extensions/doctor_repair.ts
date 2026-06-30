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

import { getLogger } from "@logtape/logtape";
import type { DoctorAggregateReport } from "./doctor_aggregate.ts";

const logger = getLogger(["swamp", "doctor", "repair"]);

export type RepairOperationKind =
  | "catalog-row-pruned"
  | "unreachable-row-pruned"
  | "bundle-file-evicted"
  | "pulled-extension-repulled";

export interface RepairOperation {
  readonly kind: RepairOperationKind;
  readonly path: string;
  readonly reason: string;
}

export interface RepairReport {
  readonly mode: "dry-run" | "applied";
  readonly operations: readonly RepairOperation[];
  readonly prunedRowCount: number;
  readonly evictedFileCount: number;
  readonly repulledExtensionCount: number;
}

export interface RepairDeps {
  readonly aggregateReport: DoctorAggregateReport;
  readonly deleteBySourcePaths: (paths: readonly string[]) => number;
  readonly repullExtension?: (name: string) => Promise<boolean>;
  readonly apply: boolean;
}

/**
 * Computes and optionally executes repair operations based on the
 * aggregate state report. Handles three categories:
 *
 * - Catalog rows in Tombstoned state (no transitions out; safe to prune).
 * - Catalog rows whose source_path doesn't exist on disk (stale rows
 *   from prior container sessions with a different mount path).
 * - Bundle files not referenced by any catalog row.
 * - Pulled extensions with BundleBuildFailed or ValidationFailed sources
 *   (re-pulled from registry to restore pre-built bundles).
 *
 * OrphanedBundleOnly rows are pruned together with their associated
 * bundle file in a single pass to maintain idempotence.
 */
export async function repairExtensions(
  deps: RepairDeps,
): Promise<RepairReport> {
  const operations: RepairOperation[] = [];
  const report = deps.aggregateReport;

  // Phase 1: Identify cleanup-eligible catalog rows.
  const rowsToPrune: string[] = [];
  const orphanedBundlePaths: string[] = [];
  for (const detail of report.sourceDetails) {
    if (detail.stateTag === "Tombstoned") {
      rowsToPrune.push(detail.sourcePath);
      operations.push({
        kind: "catalog-row-pruned",
        path: detail.sourcePath,
        reason: `Tombstoned row — no longer active`,
      });
    } else if (detail.stateTag === "OrphanedBundleOnly") {
      rowsToPrune.push(detail.sourcePath);
      operations.push({
        kind: "catalog-row-pruned",
        path: detail.sourcePath,
        reason:
          `OrphanedBundleOnly row — source deleted, evicting row and bundle`,
      });
      if (detail.bundlePath) {
        orphanedBundlePaths.push(detail.bundlePath);
        operations.push({
          kind: "bundle-file-evicted",
          path: detail.bundlePath,
          reason: `Bundle for deleted source — no longer needed`,
        });
      }
    }
  }

  // Phase 1b: Identify non-Tombstoned rows whose source_path doesn't
  // exist on disk. These accumulate when the same repo is used from a
  // container with a different mount path (e.g. /workspace vs /Users).
  const unreachableRows: string[] = [];
  for (const orphan of report.catalogOrphans) {
    unreachableRows.push(orphan.sourcePath);
    operations.push({
      kind: "unreachable-row-pruned",
      path: orphan.sourcePath,
      reason:
        `Source path does not exist on disk — stale row from a prior session`,
    });
  }

  // Phase 2: Identify orphaned bundle files.
  const filesToEvict: string[] = [];
  for (const orphan of report.bundleOrphans) {
    filesToEvict.push(orphan.absolutePath);
    operations.push({
      kind: "bundle-file-evicted",
      path: orphan.repoRelativePath,
      reason: `Bundle file not referenced by any catalog row`,
    });
  }

  // Phase 3: Identify pulled extensions with broken bundles.
  const extensionsToRepull = new Set<string>();
  for (const agg of report.aggregates) {
    if (agg.origin !== "pulled") continue;
    const failedCount = (agg.stateDistribution.BundleBuildFailed ?? 0) +
      (agg.stateDistribution.ValidationFailed ?? 0);
    if (failedCount > 0) {
      extensionsToRepull.add(agg.name);
      operations.push({
        kind: "pulled-extension-repulled",
        path: agg.name,
        reason:
          `Pulled extension has ${failedCount} broken bundle(s) — re-pulling from registry`,
      });
    }
  }

  let actualPruned = rowsToPrune.length + unreachableRows.length;
  let actualEvicted = filesToEvict.length + orphanedBundlePaths.length;
  let actualRepulled = extensionsToRepull.size;

  if (deps.apply) {
    const allRowsToPrune = [...rowsToPrune, ...unreachableRows];
    if (allRowsToPrune.length > 0) {
      actualPruned = deps.deleteBySourcePaths(allRowsToPrune);
      logger.info`Pruned ${actualPruned} catalog row(s)`;
    }
    actualEvicted = 0;
    for (const file of [...filesToEvict, ...orphanedBundlePaths]) {
      try {
        await Deno.remove(file);
        actualEvicted++;
        logger.info`Evicted bundle file: ${file}`;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          logger.warn`Failed to evict bundle file ${file}: ${error}`;
        }
      }
    }
    if (deps.repullExtension) {
      actualRepulled = 0;
      for (const name of extensionsToRepull) {
        try {
          const ok = await deps.repullExtension(name);
          if (ok) {
            actualRepulled++;
            logger.info`Re-pulled extension: ${name}`;
          } else {
            logger
              .warn`Failed to re-pull extension ${name} — run 'swamp extension pull ${name} --force' manually`;
          }
        } catch (error) {
          logger
            .warn`Failed to re-pull extension ${name}: ${error}`;
        }
      }
    }
  }

  return {
    mode: deps.apply ? "applied" : "dry-run",
    operations,
    prunedRowCount: actualPruned,
    evictedFileCount: actualEvicted,
    repulledExtensionCount: actualRepulled,
  };
}
