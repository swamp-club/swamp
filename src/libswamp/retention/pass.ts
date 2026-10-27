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
import type {
  RetentionKind,
  RetentionPolicy,
} from "../../domain/retention/retention_policy.ts";
import type {
  RetentionWatermark,
  RetentionWatermarkRepository,
} from "../../domain/retention/retention_watermark.ts";
import { withSpan } from "../../infrastructure/tracing/mod.ts";
import {
  type DiagnosticPhaseHandle,
  observeDiagnosticPhase,
  startDiagnosticPhase,
  withDiagnosticArea,
} from "../../domain/diagnostics/diagnostic_phase.ts";

const logger = getLogger(["swamp", "retention"]);

/** Items a collector removes per batch unless told otherwise. */
export const DEFAULT_RETENTION_BATCH_SIZE = 100;

/** What one batch of a collector removed. */
export interface RetentionBatchResult {
  deleted: number;
  bytesReclaimed: number;
  /** True when the collector stopped at the limit and has more to remove. */
  more: boolean;
  /**
   * True when the collector skipped items it failed to remove: the kind's
   * cutoff is then not fully applied, though the pass moves on.
   */
  incomplete?: boolean;
}

/**
 * Removes the items of one kind older than a cutoff, at most `limit` per
 * call. Collectors run in the order given, which matters: a run must go
 * before the data whose `workflow` lifetime it bounds.
 */
export interface RetentionCollector {
  kind: RetentionKind;
  collectBatch(cutoff: Date, limit: number): Promise<RetentionBatchResult>;
}

/**
 * Runs one output-retention batch as the `retention_batch` phase
 * (design/enablers/serve-phase-telemetry.md). Its `batch_commit` phase
 * covers what `runBatch` does once the collector settles: ending the unit of
 * work (the v2 push or the v3 commit) and releasing the gate.
 */
function observeOutputBatch(
  runBatch: RetentionPassDeps["runBatch"],
  collect: () => Promise<RetentionBatchResult>,
  batchSize: number,
): Promise<RetentionBatchResult> {
  return observeDiagnosticPhase("retention_batch", {
    "swamp.diagnostic.batch_size": batchSize,
  }, async (phase) => {
    let commit: DiagnosticPhaseHandle | undefined;
    // A unit whose collector threw is abandoned, which still pushes: the
    // commit then ends ok unless runBatch rejects with an error of its own.
    let collectError: unknown;
    let batch: RetentionBatchResult;
    try {
      batch = await runBatch(async () => {
        // A runBatch that runs fn again ends the last attempt's commit here,
        // before the retry's stages start, so stages never overlap.
        commit?.end();
        commit = undefined;
        collectError = undefined;
        try {
          return await collect();
        } catch (error) {
          collectError = error;
          throw error;
        } finally {
          commit = startDiagnosticPhase("batch_commit", {
            "swamp.diagnostic.disposition": collectError === undefined
              ? "commit"
              : "abandon",
          });
        }
      });
    } catch (error) {
      if (error === collectError) commit?.end();
      else commit?.fail(error);
      throw error;
    }
    commit?.end();
    phase.tally.add("deleted", batch.deleted);
    phase.tally.add("bytes_reclaimed", batch.bytesReclaimed);
    phase.attributes({ "swamp.diagnostic.more": batch.more });
    return batch;
  });
}

export interface RetentionPassDeps {
  collectors: readonly RetentionCollector[];
  watermarks: RetentionWatermarkRepository;
  /**
   * Runs one batch with whatever it needs around it: the sync gate, a unit
   * of work, the push of what it removed. Called once per batch so a
   * long pass never holds them for long.
   */
  runBatch<T>(fn: () => Promise<T>): Promise<T>;
  /** Runs once after the batches, e.g. v3 history compaction. */
  afterPass?(result: RetentionPassResult): Promise<void>;
  /** The pass's clock: cutoffs are taken from it, and the budget measured. */
  now(): Date;
}

export interface RetentionPassOptions {
  policy: RetentionPolicy;
  batchSize?: number;
  /** Stop starting new batches after this long; the next pass continues. */
  budgetMs?: number;
  /** Stop at the next batch boundary (shutdown). */
  isStopping?: () => boolean;
  /**
   * Called between batches; returns true to stop for now because the
   * process is busy. The next pass picks up where this one stopped.
   */
  shouldBackOff?: () => boolean;
  /**
   * Log the per-kind summary at debug rather than info. The CLI's
   * end-of-command pass sets it, so a command's own output is not followed
   * by retention lines; serve leaves it off.
   */
  quiet?: boolean;
}

export interface RetentionKindResult {
  kind: RetentionKind;
  cutoff: string;
  retention: string;
  deleted: number;
  bytesReclaimed: number;
  complete: boolean;
}

export interface RetentionPassResult {
  startedAt: string;
  kinds: RetentionKindResult[];
  /** True when every kind finished; false when the pass stopped early. */
  complete: boolean;
  /** Why the pass stopped early, when it did. */
  stoppedBy?: "budget" | "stopping" | "busy";
}

/**
 * Runs one retention pass: for each kind with a retention, removes items
 * older than its cutoff in batches, then records one watermark per kind
 * (swamp-club#3473). A collector error ends that kind's pass, is logged and
 * leaves its watermark incomplete; the other kinds still run.
 */
export async function runRetentionPass(
  deps: RetentionPassDeps,
  options: RetentionPassOptions,
): Promise<RetentionPassResult> {
  const now = deps.now();
  const batchSize = options.batchSize ?? DEFAULT_RETENTION_BATCH_SIZE;
  const result: RetentionPassResult = {
    startedAt: now.toISOString(),
    kinds: [],
    complete: true,
  };

  const started = new Set<RetentionKind>();
  const shouldStop = (): RetentionPassResult["stoppedBy"] => {
    if (options.isStopping?.()) return "stopping";
    if (
      options.budgetMs !== undefined &&
      deps.now().getTime() - now.getTime() >= options.budgetMs
    ) return "budget";
    if (options.shouldBackOff?.()) return "busy";
    return undefined;
  };

  return await withSpan(
    "swamp.retention.pass",
    { "retention.kinds": deps.collectors.map((c) => c.kind).join(",") },
    async (span) => {
      for (const collector of deps.collectors) {
        const cutoff = options.policy.cutoff(collector.kind, now);
        const retention = options.policy.durationFor(collector.kind);
        if (!cutoff || !retention) continue;
        const kindResult: RetentionKindResult = {
          kind: collector.kind,
          cutoff: cutoff.toISOString(),
          retention,
          deleted: 0,
          bytesReclaimed: 0,
          complete: false,
        };
        result.kinds.push(kindResult);
        if (result.stoppedBy) continue;

        let skipped = false;
        try {
          while (true) {
            const stop = shouldStop();
            if (stop) {
              result.stoppedBy = stop;
              break;
            }
            // Only a kind a batch ran for replaces its watermark.
            started.add(collector.kind);
            const batch = await withSpan(
              "swamp.retention.batch",
              { "retention.kind": collector.kind },
              async (batchSpan) => {
                const collect = () => collector.collectBatch(cutoff, batchSize);
                // Output retention exports its phases, the gate wait in
                // runBatch included; other kinds export none yet.
                const batch = collector.kind === "outputs"
                  ? await withDiagnosticArea(
                    "output_retention",
                    () => observeOutputBatch(deps.runBatch, collect, batchSize),
                  )
                  : await deps.runBatch(collect);
                batchSpan.setAttributes({
                  "retention.deleted": batch.deleted,
                  "retention.bytes_reclaimed": batch.bytesReclaimed,
                  "retention.more": batch.more,
                });
                return batch;
              },
            );
            kindResult.deleted += batch.deleted;
            kindResult.bytesReclaimed += batch.bytesReclaimed;
            if (batch.incomplete) skipped = true;
            if (!batch.more) {
              kindResult.complete = !skipped;
              break;
            }
          }
        } catch (error) {
          logger.warn`Retention of ${collector.kind} stopped: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }

      result.complete = result.kinds.every((k) => k.complete);
      span.setAttribute("retention.complete", result.complete);

      for (const kind of result.kinds) {
        // A kind the pass never reached keeps its previous watermark: its
        // cutoff has not been applied yet.
        if (!started.has(kind.kind)) continue;
        const watermark: RetentionWatermark = {
          kind: kind.kind,
          cutoff: kind.cutoff,
          retention: kind.retention,
          lastPassAt: now.toISOString(),
          complete: kind.complete,
          deleted: kind.deleted,
          bytesReclaimed: kind.bytesReclaimed,
        };
        try {
          await deps.watermarks.put(watermark);
        } catch (error) {
          logger
            .warn`Could not record the retention watermark for ${kind.kind}: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }

      // Shutdown waits for a pass: it starts no compaction or sweep then.
      if (deps.afterPass && result.stoppedBy !== "stopping") {
        try {
          await deps.afterPass(result);
        } catch (error) {
          logger.warn`Retention follow-up work failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }

      for (const kind of result.kinds) {
        // Interpolated strings render quoted, so the two endings are two
        // messages rather than one template with an optional suffix.
        if (options.quiet && kind.complete) {
          logger
            .debug`Retention ${kind.kind} (${kind.retention}): removed ${kind.deleted} items older than ${kind.cutoff}`;
        } else if (options.quiet) {
          logger
            .debug`Retention ${kind.kind} (${kind.retention}): removed ${kind.deleted} items older than ${kind.cutoff}; more remain for the next pass`;
        } else if (kind.complete) {
          logger
            .info`Retention ${kind.kind} (${kind.retention}): removed ${kind.deleted} items older than ${kind.cutoff}`;
        } else {
          logger
            .info`Retention ${kind.kind} (${kind.retention}): removed ${kind.deleted} items older than ${kind.cutoff}; more remain for the next pass`;
        }
      }
      return result;
    },
  );
}
