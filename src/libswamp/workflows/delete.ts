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
  type ContinuationClaimStore,
  removeClaimsOfRuns,
} from "../../domain/workflows/continuation_claim.ts";
import type { SignalWaitSupport } from "../../domain/workflows/signal_wait_store.ts";
import { removeWaitRecordsOfRuns } from "../../domain/workflows/signal_wait_cleanup.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import {
  findWorkflowById,
  findWorkflowByIdOrName,
} from "../../domain/workflows/workflow_lookup.ts";
import { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { isSinglePathSegment } from "../../infrastructure/persistence/safe_path.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type { LibSwampContext } from "../context.ts";
import { withUnitOfWork } from "../unit_of_work.ts";
import type { SwampError } from "../errors.ts";
import { notFound, validationFailed } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

/** Preview data returned before confirmation. */
export interface WorkflowDeletePreview {
  id: string;
  name: string;
  workflowPath: string;
  runCount: number;
}

/** Data structure for the workflow delete completed event. */
export interface WorkflowDeleteData {
  id: string;
  name: string;
  workflowPath: string;
  runsDeleted: number;
}

export type WorkflowDeleteEvent =
  | { kind: "deleting" }
  | { kind: "completed"; data: WorkflowDeleteData }
  | { kind: "error"; error: SwampError };

/** Input for the workflow delete operation. */
export interface WorkflowDeleteInput {
  workflowIdOrName: string;
  /**
   * Treat `workflowIdOrName` as a workflow id the caller already resolved,
   * and look it up by id only, so the delete acts on the workflow the caller
   * authorized.
   */
  byId?: boolean;
  /**
   * With `byId`, the name the caller authorized: ids are not guaranteed
   * unique, so only a workflow with this name and the id is accepted.
   */
  expectedName?: string;
}

/** Dependencies for the workflow delete operation. */
export interface WorkflowDeleteDeps {
  findById: (id: WorkflowId) => Promise<Workflow | null>;
  findByName: (name: string) => Promise<Workflow | null>;
  getPath: (id: WorkflowId) => string;
  pathExists: (path: string) => Promise<boolean>;
  countRuns: (workflowId: WorkflowId) => Promise<number>;
  deleteRuns: (workflowId: WorkflowId) => Promise<number>;
  /** Lists a workflow's run IDs from the run filenames. */
  listRunIds: (workflowId: WorkflowId) => Promise<string[]>;
  /** Deletes the per-run evaluated-workflow snapshots of the given runs. */
  deleteRunSnapshots: (runIds: readonly string[]) => Promise<void>;
  /**
   * Removes the signal wait records of the given runs, so an outcome never
   * outlives its run, and the key records of the workflow. Absent where
   * the datastore holds no wait records.
   */
  deleteWaitRecords?: (
    runIds: readonly string[],
    workflowId: WorkflowId,
  ) => Promise<void>;
  deleteEvaluated: (workflowId: WorkflowId) => Promise<void>;
  deleteWorkflow: (workflowId: WorkflowId, name?: string) => Promise<void>;
}

/** Wires real infrastructure into WorkflowDeleteDeps. */
export function createWorkflowDeleteDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
  markDirty?: MarkDirtyHook,
  injectedWorkflowRepo?: WorkflowRepository,
  signalWaits?: SignalWaitSupport,
  continuationClaims?: Pick<ContinuationClaimStore, "removeForRun">,
): WorkflowDeleteDeps {
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const workflowRepo = injectedWorkflowRepo ??
    new YamlWorkflowRepository(
      repoDir,
      undefined,
      undefined,
      markDirty,
    );
  const workflowRunRepo = new YamlWorkflowRunRepository(
    repoDir,
    undefined,
    dsPath(SWAMP_SUBDIRS.workflowRuns),
    markDirty,
  );
  const evaluatedWorkflowRepo = new YamlEvaluatedWorkflowRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.workflowsEvaluated),
    markDirty,
  );
  return {
    findById: (id) => workflowRepo.findById(id),
    findByName: (name) => workflowRepo.findByName(name),
    getPath: (id) => workflowRepo.getPath(id),
    pathExists: async (path) => {
      try {
        await Deno.stat(path);
        return true;
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
      }
    },
    countRuns: async (workflowId) => {
      const runs = await workflowRunRepo.findAllByWorkflowId(workflowId);
      return runs.length;
    },
    deleteRuns: (workflowId) =>
      workflowRunRepo.deleteAllByWorkflowId(workflowId),
    listRunIds: (workflowId) =>
      workflowRunRepo.listRunIdsForWorkflow(workflowId),
    deleteWaitRecords: signalWaits?.supported || continuationClaims
      ? async (runIds, workflowId) => {
        if (signalWaits?.supported) {
          try {
            await removeWaitRecordsOfRuns(signalWaits.store, new Set(runIds));
          } finally {
            // Every key record of the workflow goes with it, the release
            // records its last claims left behind included, and whether
            // or not the runs' records could be removed: no sweep removes
            // the highest record of a key (swamp-club#3209).
            await signalWaits.store.removeKeyRecordsOfWorkflow(workflowId);
          }
        }
        // The continuation claims of a run go with it (swamp-club#3108).
        await removeClaimsOfRuns(
          continuationClaims,
          runIds.filter((runId) => isSinglePathSegment(runId)),
        );
      }
      : undefined,
    deleteRunSnapshots: async (runIds) => {
      for (const runId of runIds) {
        // listRunIds already filters, but the IDs come from the filesystem;
        // skip any that cannot name a snapshot directory.
        if (!isSinglePathSegment(runId)) continue;
        await evaluatedWorkflowRepo.deleteForRun(runId);
      }
    },
    deleteEvaluated: (workflowId) => evaluatedWorkflowRepo.delete(workflowId),
    deleteWorkflow: (workflowId, name) => workflowRepo.delete(workflowId, name),
  };
}

/** Looks up the workflow by name then exact id, or by id only with `byId`. */
function findWorkflow(
  deps: WorkflowDeleteDeps,
  input: WorkflowDeleteInput,
): Promise<Workflow | null> {
  return input.byId
    ? findWorkflowById(deps, input.workflowIdOrName, input.expectedName)
    : findWorkflowByIdOrName(deps, input.workflowIdOrName);
}

/** Gathers preview info for the workflow delete operation. */
export async function workflowDeletePreview(
  ctx: LibSwampContext,
  deps: WorkflowDeleteDeps,
  input: WorkflowDeleteInput,
): Promise<WorkflowDeletePreview> {
  ctx.logger.debug`Looking up workflow: ${input.workflowIdOrName}`;
  const workflow = await findWorkflow(deps, input);
  if (!workflow) {
    throw notFound("Workflow", input.workflowIdOrName);
  }

  const workflowPath = deps.getPath(workflow.id);

  // Guard against deleting extension-only workflows
  const exists = await deps.pathExists(workflowPath);
  if (!exists) {
    throw validationFailed(
      `Cannot delete extension workflow '${workflow.name}'. Extension workflows are read-only. To remove it, delete the source file directly.`,
    );
  }

  const runCount = await deps.countRuns(workflow.id);

  return {
    id: workflow.id,
    name: workflow.name,
    workflowPath,
    runCount,
  };
}

/** Deletes a workflow and its run history. */
export async function* workflowDelete(
  ctx: LibSwampContext,
  deps: WorkflowDeleteDeps,
  input: WorkflowDeleteInput,
): AsyncIterable<WorkflowDeleteEvent> {
  yield* withUnitOfWork(ctx, () =>
    withGeneratorSpan(
      "swamp.workflow.delete",
      { "workflow.id_or_name": input.workflowIdOrName },
      (async function* () {
        yield { kind: "deleting" };

        const workflow = await findWorkflow(deps, input);
        if (!workflow) {
          yield {
            kind: "error",
            error: notFound("Workflow", input.workflowIdOrName),
          };
          return;
        }

        const workflowPath = deps.getPath(workflow.id);

        // Collect the run IDs (from the run filenames) before the runs are
        // deleted; the snapshots go after the runs, so a failed run delete
        // never leaves surviving runs without their snapshots.
        const runIds = await deps.listRunIds(workflow.id);

        // Delete runs
        ctx.logger.debug`Deleting workflow runs`;
        const runsDeleted = await deps.deleteRuns(workflow.id);

        ctx.logger.debug`Deleting run snapshots`;
        await deps.deleteRunSnapshots(runIds);

        // After the runs, like the snapshots: records a failure leaves
        // behind are swept later, and no run is left without its records.
        if (deps.deleteWaitRecords) {
          ctx.logger.debug`Deleting signal wait records`;
          // The runs are gone by now. A store that cannot be reached must
          // not leave the workflow half deleted, so the delete goes on.
          try {
            await deps.deleteWaitRecords(runIds, workflow.id);
          } catch (error) {
            ctx.logger
              .warn`Could not remove the signal wait records and continuation claims of the deleted runs: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
        }

        // Delete evaluated workflow
        ctx.logger.debug`Deleting evaluated workflow`;
        await deps.deleteEvaluated(workflow.id);

        // Delete workflow
        ctx.logger.debug`Deleting workflow: ${workflow.id}`;
        await deps.deleteWorkflow(workflow.id, workflow.name);

        yield {
          kind: "completed",
          data: {
            id: workflow.id,
            name: workflow.name,
            workflowPath,
            runsDeleted,
          },
        };
      })(),
    ));
}
