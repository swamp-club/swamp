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
 * - Bundle files not referenced by any catalog row.
 * - Pulled extensions with BundleBuildFailed or ValidationFailed sources
 *   (re-pulled from registry to restore pre-built bundles).
 *
 * NEVER touches Indexed, Bundled, or OrphanedBundleOnly rows.
 * OrphanedBundleOnly is excluded because those rows still reference a
 * live bundle file — pruning the row would strand the file as an orphan
 * on the next run, breaking idempotence.
 */
export async function repairExtensions(
  deps: RepairDeps,
): Promise<RepairReport> {
  const operations: RepairOperation[] = [];
  const report = deps.aggregateReport;

  // Phase 1: Identify cleanup-eligible catalog rows.
  // Only Tombstoned rows are pruned. OrphanedBundleOnly is deliberately
  // excluded — those rows still reference a bundle file on disk, and
  // pruning the row would strand the file as an orphan on the NEXT run,
  // breaking idempotence. OrphanedBundleOnly cleanup is deferred to a
  // follow-up workstream that can handle row + file atomically.
  const rowsToPrune: string[] = [];
  for (const detail of report.sourceDetails) {
    if (detail.stateTag === "Tombstoned") {
      rowsToPrune.push(detail.sourcePath);
      operations.push({
        kind: "catalog-row-pruned",
        path: detail.sourcePath,
        reason: `Tombstoned row — no longer active`,
      });
    }
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

  let actualPruned = rowsToPrune.length;
  let actualEvicted = filesToEvict.length;
  let actualRepulled = extensionsToRepull.size;

  if (deps.apply) {
    if (rowsToPrune.length > 0) {
      actualPruned = deps.deleteBySourcePaths(rowsToPrune);
      logger.info`Pruned ${actualPruned} catalog row(s)`;
    }
    actualEvicted = 0;
    for (const file of filesToEvict) {
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
