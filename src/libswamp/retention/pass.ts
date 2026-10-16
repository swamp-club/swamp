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
  const startedMs = Date.now();
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
      Date.now() - startedMs >= options.budgetMs
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
                const batch = await deps.runBatch(() =>
                  collector.collectBatch(cutoff, batchSize)
                );
                batchSpan.setAttribute("retention.deleted", batch.deleted);
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
