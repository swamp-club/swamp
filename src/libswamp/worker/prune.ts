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
import { withUnitOfWork } from "../unit_of_work.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import {
  bindGeneratorToDiagnosticArea,
  type DiagnosticPhaseHandle,
  type DiagnosticResult,
  observeDiagnosticPhase,
  withGeneratorDiagnosticPhase,
} from "../../domain/diagnostics/diagnostic_phase.ts";
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
  /**
   * The caller's cancellation, observed only: each diagnostic phase records
   * whether it had been seen by the time the phase ended. The prune does not
   * stop on it.
   */
  signal?: AbortSignal;
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

/** Why a worker is kept, or undefined when it may be pruned. */
function pruneSkipReason(
  worker: PrunableWorker,
  gracePeriodMs: number,
  nowMs: number,
): "not_disconnected" | "no_disconnect_time" | "within_grace" | undefined {
  if (worker.status !== "disconnected") return "not_disconnected";
  if (!worker.disconnectedAt) return "no_disconnect_time";
  const disconnectedMs = Date.parse(worker.disconnectedAt);
  return (nowMs - disconnectedMs) >= gracePeriodMs ? undefined : "within_grace";
}

/**
 * Prunes stale disconnected workers and their enrollment-token bindings.
 *
 * Exported as the worker_delete diagnostic area
 * (design/enablers/serve-phase-telemetry.md): every stage is a phase under
 * prune_pass, and each worker's swamp.model.delete nests under delete_loop.
 */
export async function* workerPrune(
  ctx: LibSwampContext,
  deps: WorkerPruneDeps,
  input: WorkerPruneInput,
): AsyncGenerator<WorkerPruneEvent> {
  yield* withUnitOfWork(ctx, () =>
    withGeneratorSpan(
      "swamp.worker.prune",
      {
        "prune.grace_period_ms": input.gracePeriodMs,
        "prune.dry_run": input.dryRun,
      },
      bindGeneratorToDiagnosticArea(
        "worker_delete",
        withGeneratorDiagnosticPhase(
          "prune_pass",
          {},
          (pass) => pruneStages(deps, input, pass),
        ),
        input.signal,
      ),
    ));
}

async function* pruneStages(
  deps: WorkerPruneDeps,
  input: WorkerPruneInput,
  pass: DiagnosticPhaseHandle,
): AsyncGenerator<WorkerPruneEvent> {
  const nowMs = (deps.now ?? Date.now)();

  let allWorkers: PrunableWorker[];
  try {
    allWorkers = await observeDiagnosticPhase(
      "worker_listing",
      {},
      async (phase) => {
        const workers = await deps.listWorkers();
        phase.tally.add("workers", workers.length);
        return workers;
      },
    );
  } catch (error) {
    // Reported as an event, not thrown: end the pass as the failure it is.
    pass.end("error");
    yield {
      kind: "error" as const,
      error: {
        code: "worker_prune_list_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
    return;
  }

  const prunable = await observeDiagnosticPhase(
    "eligibility",
    {},
    ({ tally }) => {
      tally.add("considered", allWorkers.length);
      return Promise.resolve(allWorkers.filter((w) => {
        const reason = pruneSkipReason(w, input.gracePeriodMs, nowMs);
        tally.add(reason ? `skipped_${reason}` : "eligible");
        return reason === undefined;
      }));
    },
  );

  yield {
    kind: "previewing" as const,
    workers: prunable,
    dryRun: input.dryRun,
  };

  if (input.dryRun || prunable.length === 0) {
    const result = {
      workersDeleted: 0,
      workersFailed: 0,
      bindingsPruned: 0,
      tokensCleaned: 0,
    };
    recordPass(pass, result, input.dryRun ? "skipped" : "no_change");
    yield { kind: "completed" as const, result };
    return;
  }

  // Sequential: one worker record at a time.
  const deletion = yield* withGeneratorDiagnosticPhase(
    "delete_loop",
    {
      "swamp.diagnostic.sequential": true,
      "swamp.diagnostic.batch_size": prunable.length,
    },
    (phase) => deleteWorkers(deps, prunable, phase),
  );

  // Timed apart from the deletions it follows.
  const cleanup = yield* withGeneratorDiagnosticPhase(
    "binding_cleanup",
    { "swamp.diagnostic.affected_tokens": deletion.affectedTokens.size },
    (phase) => cleanUpBindings(deps, deletion.affectedTokens, phase),
  );

  const result = {
    workersDeleted: deletion.workersDeleted,
    workersFailed: deletion.workersFailed,
    bindingsPruned: cleanup.bindingsPruned,
    tokensCleaned: cleanup.tokensCleaned,
  };
  recordPass(
    pass,
    result,
    deletion.workersFailed > 0 || cleanup.failed > 0 ? "partial" : "completed",
  );
  yield { kind: "completed" as const, result };
}

function recordPass(
  pass: DiagnosticPhaseHandle,
  result: WorkerPruneResult,
  outcome: DiagnosticResult,
): void {
  pass.attributes({
    "swamp.diagnostic.workers_deleted": result.workersDeleted,
    "swamp.diagnostic.workers_failed": result.workersFailed,
    "swamp.diagnostic.bindings_pruned": result.bindingsPruned,
    "swamp.diagnostic.tokens_cleaned": result.tokensCleaned,
  });
  pass.result(outcome);
}

async function* deleteWorkers(
  deps: WorkerPruneDeps,
  prunable: PrunableWorker[],
  phase: DiagnosticPhaseHandle,
): AsyncGenerator<
  WorkerPruneEvent,
  { workersDeleted: number; workersFailed: number; affectedTokens: Set<string> }
> {
  let workersDeleted = 0;
  let workersFailed = 0;
  const affectedTokens = new Set<string>();

  for (const worker of prunable) {
    yield { kind: "deleting_worker" as const, name: worker.name };
    phase.tally.add("attempted");
    try {
      let deleteCompleted = false;
      for await (
        const event of deps.deleteWorker(worker.definitionName)
      ) {
        if (event.kind === "completed") deleteCompleted = true;
        if (event.kind === "error") {
          throw new Error(event.error.message);
        }
      }
      if (!deleteCompleted) {
        throw new Error("delete stream ended without completing");
      }
      workersDeleted++;
      phase.tally.add("deleted");
      yield { kind: "worker_deleted" as const, name: worker.name };
      affectedTokens.add(worker.tokenName);
    } catch (error) {
      workersFailed++;
      phase.tally.add("failed");
      yield {
        kind: "worker_delete_failed" as const,
        name: worker.name,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  phase.result(workersFailed > 0 ? "partial" : "completed");
  return { workersDeleted, workersFailed, affectedTokens };
}

async function* cleanUpBindings(
  deps: WorkerPruneDeps,
  affectedTokens: Set<string>,
  phase: DiagnosticPhaseHandle,
): AsyncGenerator<
  WorkerPruneEvent,
  { bindingsPruned: number; tokensCleaned: number; failed: number }
> {
  const { tally } = phase;
  let bindingsPruned = 0;
  let tokensCleaned = 0;
  let failed = 0;
  const done = (result: DiagnosticResult) => {
    tally.add("bindings_pruned", bindingsPruned);
    tally.add("tokens_cleaned", tokensCleaned);
    tally.add("failed", failed);
    phase.result(result);
    return { bindingsPruned, tokensCleaned, failed };
  };

  if (affectedTokens.size === 0) return done("no_change");
  if (!deps.resolveStaleBindings) return done("skipped");

  let tokens: PrunableToken[];
  try {
    tokens = await tally.measure("token_list", () => deps.listTokens());
  } catch {
    tokens = [];
  }

  const tokensByName = new Map(tokens.map((t) => [t.name, t]));

  let remainingWorkers: PrunableWorker[] | null;
  try {
    remainingWorkers = await tally.measure(
      "worker_relist",
      () => deps.listWorkers(),
    );
  } catch {
    remainingWorkers = null;
  }

  if (remainingWorkers === null) {
    // Cannot determine which bindings are stale without the worker
    // list — skip binding cleanup to avoid over-pruning active bindings.
    return done("skipped");
  }

  for (const tokenName of affectedTokens) {
    const token = tokensByName.get(tokenName);
    if (!token || token.bindings.length === 0) continue;

    const remainingNames = remainingWorkers
      .filter((w) => w.tokenName === tokenName)
      .map((w) => w.name);

    tally.add("tokens_checked");
    const staleIds = await tally.measure(
      "stale_resolve",
      () => deps.resolveStaleBindings!(token, remainingNames),
    );
    if (!staleIds || staleIds.length === 0) continue;

    yield {
      kind: "pruning_bindings" as const,
      tokenName,
      machineIds: staleIds,
    };

    tally.add("attempted");
    try {
      const pruneCompleted = await tally.measure("binding_prune", async () => {
        let completed = false;
        for await (
          const event of deps.pruneBindings(tokenName, staleIds)
        ) {
          if (event.kind === "completed") completed = true;
          if (event.kind === "error") {
            throw new Error(event.error.message);
          }
        }
        return completed;
      });
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
      failed++;
      yield {
        kind: "bindings_prune_failed" as const,
        tokenName,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return done(
    failed > 0 ? "partial" : bindingsPruned > 0 ? "completed" : "no_change",
  );
}
