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

import type {
  SignalWaitStore,
  SignalWaitSupport,
} from "../../domain/workflows/signal_wait_store.ts";
import {
  removeWaitRecordsOfRuns,
  sweepWaitRecords,
} from "../../domain/workflows/signal_wait_cleanup.ts";
import {
  type ContinuationClaimStore,
  removeClaimsOfRuns,
} from "../../domain/workflows/continuation_claim.ts";
import type { WorkflowRunRepository } from "../../domain/workflows/repositories.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import {
  DEFAULT_OUTPUT_RETENTION_DAYS,
  DEFAULT_WORKFLOW_RUN_RETENTION_DAYS,
  DefaultRunLifecycleService,
  type RunGcResult,
} from "../../domain/data/run_lifecycle_service.ts";

export { DEFAULT_OUTPUT_RETENTION_DAYS, DEFAULT_WORKFLOW_RUN_RETENTION_DAYS };
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type { LibSwampContext } from "../context.ts";
import { withUnitOfWork } from "../unit_of_work.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import {
  type RetentionConfig,
  RetentionPolicy,
} from "../../domain/retention/retention_policy.ts";

export interface RunGcData {
  workflowRunsDeleted: number;
  workflowRunBytesReclaimed: number;
  outputsDeleted: number;
  outputBytesReclaimed: number;
  /** Per-run evaluated-workflow snapshots removed with their runs or as orphans. */
  evaluatedSnapshotsDeleted: number;
  evaluatedSnapshotBytesReclaimed: number;
  totalBytesReclaimed: number;
  dryRun: boolean;
}

export type RunGcEvent =
  | { kind: "collecting" }
  | { kind: "completed"; data: RunGcData }
  | { kind: "error"; error: SwampError };

export interface RunGcInput {
  dryRun: boolean;
  workflowRunRetentionDays?: number;
  outputRetentionDays?: number;
  /**
   * How long a finished run's evaluated snapshot is kept; unset, a snapshot
   * goes with its run.
   */
  evaluatedSnapshotRetentionDays?: number;
}

/** The `.swamp.yaml` `garbageCollection` block run gc reads. */
export type RunGcGarbageCollectionPolicy = RetentionConfig;

const DAY_MS = 86_400_000;

/**
 * Maps the repository's garbage-collection block to run gc retention, in
 * days. A kind's own key wins over `retention`; a kind with neither is left
 * unset, so run gc uses its built-in default.
 */
export function runGcRetentionFromPolicy(
  policy?: RunGcGarbageCollectionPolicy,
): Pick<
  RunGcInput,
  | "workflowRunRetentionDays"
  | "outputRetentionDays"
  | "evaluatedSnapshotRetentionDays"
> {
  const retention = RetentionPolicy.fromConfig(policy);
  const toDays = (ms: number | undefined): number | undefined =>
    ms === undefined ? undefined : ms / DAY_MS;
  // Only an explicit evaluatedSnapshots removes snapshots ahead of their
  // runs; otherwise they go with them.
  const snapshots = retention.isExplicit("evaluatedSnapshots")
    ? toDays(retention.retentionMs("evaluatedSnapshots"))
    : undefined;
  return {
    workflowRunRetentionDays: toDays(retention.retentionMs("workflowRuns")),
    outputRetentionDays: toDays(retention.retentionMs("outputs")),
    ...(snapshots === undefined
      ? {}
      : { evaluatedSnapshotRetentionDays: snapshots }),
  };
}

/**
 * Builds run gc input from the repository's garbage-collection block. An
 * override (`--older-than`) wins over the configured retention for runs and
 * outputs; it does not apply to snapshots, which then go with their runs.
 */
export function runGcInputFromPolicy(
  dryRun: boolean,
  policy?: RunGcGarbageCollectionPolicy,
  overrideRetentionDays?: number,
): RunGcInput {
  if (overrideRetentionDays === undefined) {
    return { dryRun, ...runGcRetentionFromPolicy(policy) };
  }
  // The override is first in the policy's precedence for runs and outputs.
  return {
    dryRun,
    workflowRunRetentionDays: overrideRetentionDays,
    outputRetentionDays: overrideRetentionDays,
  };
}

export interface RunGcPreview {
  workflowRunsToDelete: number;
  workflowRunBytesReclaimable: number;
  outputsToDelete: number;
  outputBytesReclaimable: number;
  evaluatedSnapshotsToDelete: number;
  evaluatedSnapshotBytesReclaimable: number;
  totalBytesReclaimable: number;
}

export interface RunGcDeps {
  gcAll: (options: {
    workflowRunRetentionDays: number;
    outputRetentionDays: number;
    dryRun: boolean;
    limit?: number;
    snapshotRetentionDays?: number;
  }) => Promise<RunGcResult>;
}

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

/**
 * The IDs of the stored runs that have finished, read from each workflow's
 * run index. An ID any workflow lists with an unfinished status is left out,
 * so a snapshot a running run still needs is never taken for a finished
 * run's.
 */
async function listTerminalRunIds(
  workflowRunRepo: YamlWorkflowRunRepository,
): Promise<ReadonlyMap<string, number | undefined>> {
  const finished = new Map<string, number | undefined>();
  const unfinished = new Set<string>();
  for (const workflowId of await workflowRunRepo.listWorkflowIds()) {
    for (
      const summary of await workflowRunRepo.findAllSummariesFromIndex(
        workflowId,
      )
    ) {
      if (TERMINAL_RUN_STATUSES.has(summary.status)) {
        finished.set(summary.id, summary.completedAt?.getTime());
      } else unfinished.add(summary.id);
    }
  }
  for (const id of unfinished) finished.delete(id);
  return finished;
}

/**
 * Removes the wait records of the runs just deleted, then sweeps the
 * records nothing else removed.
 */
function waitRecordCollector(
  store: SignalWaitStore,
  runRepo: Pick<WorkflowRunRepository, "findById">,
  localRunAbsenceIsAuthoritative = false,
  continuationClaims?: Pick<ContinuationClaimStore, "removeForRun">,
): (deletedRunIds: readonly string[]) => Promise<void> {
  return async (deletedRunIds) => {
    await removeWaitRecordsOfRuns(store, new Set(deletedRunIds));
    await sweepWaitRecords(
      store,
      (workflowId, runId) =>
        runRepo.findById(
          createWorkflowId(workflowId),
          createWorkflowRunId(runId),
        ),
      new Date(),
      { localRunAbsenceIsAuthoritative },
    );
    // The continuation claims of a run go with it (swamp-club#3108), last:
    // a claim that cannot be removed must not keep the wait records.
    await removeClaimsOfRuns(continuationClaims, deletedRunIds);
  };
}

export function createRunGcDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
  markDirty?: MarkDirtyHook,
  signalWaits?: SignalWaitSupport,
  continuationClaims?: Pick<ContinuationClaimStore, "removeForRun">,
): RunGcDeps {
  const service = createRunLifecycleService(
    repoDir,
    datastoreResolver,
    markDirty,
    signalWaits,
    continuationClaims,
  );
  return {
    gcAll: (options) => service.gcAll(options),
  };
}

/**
 * The run lifecycle service over a repository's runs, outputs and run
 * snapshots, as run gc and the retention pass use it.
 */
export function createRunLifecycleService(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
  markDirty?: MarkDirtyHook,
  signalWaits?: SignalWaitSupport,
  continuationClaims?: Pick<ContinuationClaimStore, "removeForRun">,
): DefaultRunLifecycleService {
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const workflowRunRepo = new YamlWorkflowRunRepository(
    repoDir,
    undefined,
    dsPath(SWAMP_SUBDIRS.workflowRuns),
    markDirty,
  );
  const outputRepo = new YamlOutputRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.outputs),
    markDirty,
  );
  const evaluatedWorkflowRepo = new YamlEvaluatedWorkflowRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.workflowsEvaluated),
    markDirty,
  );
  return new DefaultRunLifecycleService(
    workflowRunRepo,
    outputRepo,
    evaluatedWorkflowRepo,
    () => workflowRunRepo.listRunIds(),
    signalWaits?.supported
      ? waitRecordCollector(
        signalWaits.store,
        workflowRunRepo,
        signalWaits.localRunAbsenceIsAuthoritative,
        continuationClaims,
      )
      // Claims are kept wherever a resume takes one, waits or no waits.
      : continuationClaims
      ? (deletedRunIds) => removeClaimsOfRuns(continuationClaims, deletedRunIds)
      : undefined,
    () => listTerminalRunIds(workflowRunRepo),
  );
}

export async function runGcPreview(
  ctx: LibSwampContext,
  deps: RunGcDeps,
  input: RunGcInput,
): Promise<RunGcPreview> {
  ctx.logger.debug`Previewing run GC`;
  const result = await deps.gcAll({
    workflowRunRetentionDays: input.workflowRunRetentionDays ??
      DEFAULT_WORKFLOW_RUN_RETENTION_DAYS,
    outputRetentionDays: input.outputRetentionDays ??
      DEFAULT_OUTPUT_RETENTION_DAYS,
    dryRun: true,
    ...(input.evaluatedSnapshotRetentionDays === undefined ? {} : {
      snapshotRetentionDays: input.evaluatedSnapshotRetentionDays,
    }),
  });
  return {
    workflowRunsToDelete: result.workflowRunsDeleted,
    workflowRunBytesReclaimable: result.workflowRunBytesReclaimed,
    outputsToDelete: result.outputsDeleted,
    outputBytesReclaimable: result.outputBytesReclaimed,
    evaluatedSnapshotsToDelete: result.snapshotsDeleted,
    evaluatedSnapshotBytesReclaimable: result.snapshotBytesReclaimed,
    totalBytesReclaimable: result.workflowRunBytesReclaimed +
      result.outputBytesReclaimed + result.snapshotBytesReclaimed,
  };
}

export async function* runGc(
  ctx: LibSwampContext,
  deps: RunGcDeps,
  input: RunGcInput,
): AsyncIterable<RunGcEvent> {
  yield* withUnitOfWork(ctx, () =>
    withGeneratorSpan(
      "swamp.run.gc",
      { "gc.dry_run": input.dryRun },
      (async function* () {
        yield { kind: "collecting" } as const;

        const result = await deps.gcAll({
          workflowRunRetentionDays: input.workflowRunRetentionDays ??
            DEFAULT_WORKFLOW_RUN_RETENTION_DAYS,
          outputRetentionDays: input.outputRetentionDays ??
            DEFAULT_OUTPUT_RETENTION_DAYS,
          dryRun: input.dryRun,
          ...(input.evaluatedSnapshotRetentionDays === undefined ? {} : {
            snapshotRetentionDays: input.evaluatedSnapshotRetentionDays,
          }),
        });

        yield {
          kind: "completed" as const,
          data: {
            workflowRunsDeleted: result.workflowRunsDeleted,
            workflowRunBytesReclaimed: result.workflowRunBytesReclaimed,
            outputsDeleted: result.outputsDeleted,
            outputBytesReclaimed: result.outputBytesReclaimed,
            evaluatedSnapshotsDeleted: result.snapshotsDeleted,
            evaluatedSnapshotBytesReclaimed: result.snapshotBytesReclaimed,
            totalBytesReclaimed: result.workflowRunBytesReclaimed +
              result.outputBytesReclaimed + result.snapshotBytesReclaimed,
            dryRun: result.dryRun,
          },
        };
      })(),
    ));
}
