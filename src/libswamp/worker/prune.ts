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

/**
 * Prune stale worker records and their enrollment-token bindings (see
 * design/enablers/remote-execution.md, "Worker state is swamp data").
 *
 * Ephemeral worker fleets (e.g. Kubernetes pods) accumulate disconnected
 * worker records and stale token bindings that are never reaped because
 * both resources declare `lifetime: "infinite"`. This service identifies
 * workers that have been disconnected past a configurable grace period,
 * deletes them via the shared `modelDelete` path, and prunes the
 * corresponding bindings from their enrollment tokens.
 */

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import type { ModelMethodRunEvent } from "../models/run.ts";
import type { ModelDeleteEvent } from "../models/delete.ts";

/** A worker record eligible for pruning consideration. */
export interface PrunableWorker {
  readonly name: string;
  readonly definitionName: string;
  readonly status: string;
  readonly tokenName: string;
  readonly disconnectedAt: string | undefined;
}

/** An enrollment token with its bindings. */
export interface PrunableToken {
  readonly name: string;
  readonly bindings: ReadonlyArray<{ machineId: string }>;
}

/** Result of a prune operation. */
export interface WorkerPruneResult {
  readonly workersDeleted: number;
  readonly workersFailed: number;
  readonly bindingsPruned: number;
  readonly tokensCleaned: number;
}

export type WorkerPruneEvent =
  | { kind: "previewing"; workers: PrunableWorker[]; dryRun: boolean }
  | { kind: "deleting_worker"; name: string }
  | { kind: "worker_deleted"; name: string }
  | {
    kind: "worker_delete_failed";
    name: string;
    error: string;
  }
  | {
    kind: "pruning_bindings";
    tokenName: string;
    machineIds: string[];
  }
  | { kind: "bindings_pruned"; tokenName: string; count: number }
  | {
    kind: "bindings_prune_failed";
    tokenName: string;
    error: string;
  }
  | { kind: "completed"; result: WorkerPruneResult }
  | { kind: "error"; error: SwampError };

export interface WorkerPruneInput {
  gracePeriodMs: number;
  dryRun: boolean;
}

/** Dependencies for the worker prune operation. */
export interface WorkerPruneDeps {
  listWorkers(): Promise<PrunableWorker[]>;
  listTokens(): Promise<PrunableToken[]>;
  deleteWorker(
    definitionName: string,
  ): AsyncIterable<ModelDeleteEvent>;
  pruneBindings(
    tokenName: string,
    machineIds: string[],
  ): AsyncIterable<ModelMethodRunEvent>;
  /**
   * Given a token and the set of remaining worker names for that token,
   * returns the machineIds of bindings that should be pruned. This is
   * the serve-side hook that uses fleetMemberSuffix to match bindings
   * to workers. Returns null to skip binding cleanup (CLI fallback).
   */
  resolveStaleBindings?(
    token: PrunableToken,
    remainingWorkerNames: string[],
  ): Promise<string[] | null>;
  now?: () => number;
}

function isPrunable(
  worker: PrunableWorker,
  gracePeriodMs: number,
  nowMs: number,
): boolean {
  if (worker.status !== "disconnected") return false;
  if (!worker.disconnectedAt) return false;
  const disconnectedMs = Date.parse(worker.disconnectedAt);
  return (nowMs - disconnectedMs) >= gracePeriodMs;
}

/**
 * Prunes stale disconnected workers and their enrollment-token bindings.
 */
export async function* workerPrune(
  _ctx: LibSwampContext,
  deps: WorkerPruneDeps,
  input: WorkerPruneInput,
): AsyncGenerator<WorkerPruneEvent> {
  yield* withGeneratorSpan(
    "swamp.worker.prune",
    {
      "prune.grace_period_ms": input.gracePeriodMs,
      "prune.dry_run": input.dryRun,
    },
    (async function* () {
      const nowMs = (deps.now ?? Date.now)();

      let allWorkers: PrunableWorker[];
      try {
        allWorkers = await deps.listWorkers();
      } catch (error) {
        yield {
          kind: "error" as const,
          error: {
            code: "worker_prune_list_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        };
        return;
      }

      const prunable = allWorkers.filter((w) =>
        isPrunable(w, input.gracePeriodMs, nowMs)
      );

      yield {
        kind: "previewing" as const,
        workers: prunable,
        dryRun: input.dryRun,
      };

      if (input.dryRun || prunable.length === 0) {
        yield {
          kind: "completed" as const,
          result: {
            workersDeleted: 0,
            workersFailed: 0,
            bindingsPruned: 0,
            tokensCleaned: 0,
          },
        };
        return;
      }

      let workersDeleted = 0;
      let workersFailed = 0;
      const affectedTokens = new Set<string>();

      for (const worker of prunable) {
        yield { kind: "deleting_worker" as const, name: worker.name };
        try {
          let deleteCompleted = false;
          for await (const event of deps.deleteWorker(worker.definitionName)) {
            if (event.kind === "completed") deleteCompleted = true;
            if (event.kind === "error") {
              throw new Error(event.error.message);
            }
          }
          if (!deleteCompleted) {
            throw new Error("delete stream ended without completing");
          }
          workersDeleted++;
          yield { kind: "worker_deleted" as const, name: worker.name };
          affectedTokens.add(worker.tokenName);
        } catch (error) {
          workersFailed++;
          yield {
            kind: "worker_delete_failed" as const,
            name: worker.name,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      let bindingsPruned = 0;
      let tokensCleaned = 0;

      if (affectedTokens.size > 0 && deps.resolveStaleBindings) {
        let tokens: PrunableToken[];
        try {
          tokens = await deps.listTokens();
        } catch {
          tokens = [];
        }

        const tokensByName = new Map(tokens.map((t) => [t.name, t]));

        let remainingWorkers: PrunableWorker[];
        try {
          remainingWorkers = await deps.listWorkers();
        } catch {
          remainingWorkers = [];
        }

        for (const tokenName of affectedTokens) {
          const token = tokensByName.get(tokenName);
          if (!token || token.bindings.length === 0) continue;

          const remainingNames = remainingWorkers
            .filter((w) => w.tokenName === tokenName)
            .map((w) => w.name);

          const staleIds = await deps.resolveStaleBindings(
            token,
            remainingNames,
          );
          if (!staleIds || staleIds.length === 0) continue;

          yield {
            kind: "pruning_bindings" as const,
            tokenName,
            machineIds: staleIds,
          };

          try {
            let pruneCompleted = false;
            for await (
              const event of deps.pruneBindings(tokenName, staleIds)
            ) {
              if (event.kind === "completed") pruneCompleted = true;
              if (event.kind === "error") {
                throw new Error(event.error.message);
              }
            }
            if (pruneCompleted) {
              bindingsPruned += staleIds.length;
              tokensCleaned++;
              yield {
                kind: "bindings_pruned" as const,
                tokenName,
                count: staleIds.length,
              };
            }
          } catch (error) {
            yield {
              kind: "bindings_prune_failed" as const,
              tokenName,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }
      }

      yield {
        kind: "completed" as const,
        result: {
          workersDeleted,
          workersFailed,
          bindingsPruned,
          tokensCleaned,
        },
      };
    })(),
  );
}
