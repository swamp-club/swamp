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

import {
  createWorkflowId,
  createWorkflowRunId,
} from "../domain/workflows/workflow_id.ts";
import { unclaimedRuns } from "../domain/workflows/run_claim.ts";
import { runInRootUnitOfWork } from "../infrastructure/persistence/repo_unit_of_work.ts";
import { SWAMP_SUBDIRS } from "../infrastructure/persistence/paths.ts";
import { localOwnerLiveness } from "../infrastructure/persistence/run_tracker_store.ts";
import { YamlEvaluatedWorkflowRepository } from "../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  createNestedCascade,
  type NestedCascade,
  nestedCascadeFields,
  type NestedCascadeResult,
} from "../libswamp/workflows/nested_cascade.ts";
import type { ActiveRunRegistry } from "./active_run_registry.ts";
import {
  type ConnectionContext,
  emitSystemAuditEvent,
  pushChangedToRemote,
} from "./handlers/shared.ts";
import { withSyncGate } from "./sync_gate.ts";

const logger = getSwampLogger(["serve", "nested-cascade"]);

/** How long the fetch of one run record this instance lacks may take. */
const RUN_RECORD_FETCH_TIMEOUT_MS = 30_000;

/**
 * Fetches a run record this instance does not have, for a caller that
 * already holds the sync gate: the gate is not reentrant, so the gated
 * fetch in signal delivery cannot be used from inside it. Only a record
 * that is missing is fetched; one that is here may hold a change not pushed
 * yet. Best effort: a record that stays missing reads as missing.
 */
export async function fetchMissingRunUnderGate(
  ctx: ConnectionContext,
  run: { workflowId: string; runId: string },
): Promise<void> {
  const hydrate = ctx.repoContext.hydrateFile;
  if (!hydrate) return;
  const runRepo = ctx.repoContext.workflowRunRepo;
  const workflowId = createWorkflowId(run.workflowId);
  const runId = createWorkflowRunId(run.runId);
  try {
    if (await runRepo.findById(workflowId, runId)) return;
    await hydrate(runRepo.getPath(workflowId, runId), {
      signal: AbortSignal.timeout(RUN_RECORD_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    logger.debug("Run {runId} could not be fetched: {error}", {
      runId: run.runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The cascade of a serve handler (swamp-club#2867): it cancels the
 * suspended nested runs an ended run waited on, in the handler's own gated
 * unit of work, so one push carries the parent and its children.
 *
 * Each child is reserved in the registry while it is cancelled, as a cancel
 * of that child would reserve it. A child this instance is running is asked
 * to abort and is never waited for: its final push needs the sync gate the
 * handler holds. Each cancel is audited.
 *
 * `why` is the reason the parent ended, which names who ended it, for the
 * audit trail.
 */
export function serveNestedCascade(
  ctx: ConnectionContext,
  registry: ActiveRunRegistry,
  why: string,
): NestedCascade {
  const cascade = createNestedCascade({
    workflowRepo: ctx.repoContext.workflowRepo,
    runRepo: ctx.repoContext.workflowRunRepo,
    // The registry reservation is this process's claim on a run.
    runClaims: unclaimedRuns,
    // Read only when a child has a snapshot, from the datastore-resolved
    // path the run wrote it to.
    findEvaluatedWorkflow: (runId) =>
      new YamlEvaluatedWorkflowRepository(
        ctx.repoDir,
        ctx.datastoreResolver.resolvePath(SWAMP_SUBDIRS.workflowsEvaluated),
      ).findByRunId(runId),
    runTracker: ctx.runTracker,
    liveness: localOwnerLiveness(),
    runRecordCurrency: ctx.repoContext.runRecordCurrency,
    fetchMissing: (run) => fetchMissingRunUnderGate(ctx, run),
    reserveChild: (runId) => registry.reserve(runId),
    requestStop: (child, reason) => registry.cancel(child.id, reason),
  });
  return async (endedParent) => {
    const result = await cascade(endedParent);
    for (const child of result.cancelledNestedRuns) {
      emitSystemAuditEvent(
        ctx,
        "workflow.nested_run_cancelled",
        `workflow=${child.workflowName} run=${child.runId} parentWorkflow=${endedParent.workflowName} parentRun=${endedParent.id} reason=${why}`,
      );
    }
    for (const child of result.stopRequestedNestedRuns) {
      emitSystemAuditEvent(
        ctx,
        "workflow.nested_run_stop_requested",
        `workflow=${child.workflowName} run=${child.runId} parentWorkflow=${endedParent.workflowName} parentRun=${endedParent.id} reason=${why}`,
      );
    }
    return result;
  };
}

/**
 * Runs the cascade for a run that ended cancelled outside a persisted
 * cancel: one this instance was driving when it was aborted, which settles
 * itself. Gated and pushed like a persisted cancel. Best effort: a failure
 * leaves the children as the abort left them, to be refused and cancelled
 * when next touched.
 */
export async function cascadeEndedRunAndPush(
  ctx: ConnectionContext,
  runId: string,
  why: string,
): Promise<Partial<NestedCascadeResult>> {
  const registry = ctx.activeRunRegistry;
  if (!registry) return {};
  try {
    return await withSyncGate(
      ctx.syncGate,
      () => cascadeEndedRunUnderGate(ctx, registry, runId, why),
    );
  } catch (error) {
    logger.warn(
      "Nested runs of cancelled run {runId} were not cancelled with it: {error}",
      {
        runId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return {};
  }
}

/**
 * The gated half of {@link cascadeEndedRunAndPush}: reads the ended run and
 * cancels the nested runs it waited on, in a root unit of work whose flush
 * is the push.
 */
async function cascadeEndedRunUnderGate(
  ctx: ConnectionContext,
  registry: ActiveRunRegistry,
  runId: string,
  why: string,
): Promise<Partial<NestedCascadeResult>> {
  return await runInRootUnitOfWork(
    ctx.repoContext,
    { flush: () => pushChangedToRemote(ctx) },
    async () => {
      const found = await ctx.repoContext.workflowRunRepo.findGlobalById(
        createWorkflowRunId(runId),
      );
      if (!found || found.run.status !== "cancelled") return {};
      if (found.run.detachedNestedRuns().length === 0) return {};
      return nestedCascadeFields(
        await serveNestedCascade(ctx, registry, why)(found.run),
      );
    },
  );
}
