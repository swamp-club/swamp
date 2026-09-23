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

import type { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import { isPartialId } from "../../domain/models/model_lookup.ts";
import { createRunMatcher, type PartialMatchResult } from "./run_lookup.ts";
import { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import {
  createCatalogStore,
  namespaceFromResolver,
} from "../../infrastructure/persistence/repository_factory.ts";
import {
  createDataRepositoryAttributeReader,
  type ResourceReadPolicy,
  StepOutputResolver,
} from "../../domain/workflows/step_output_resolver.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound, validationFailed } from "../errors.ts";
import type { WorkflowRunView } from "./workflow_run_view.ts";
import {
  resolveRunStepOutputs,
  type RunStepOutputs,
  toRunData,
} from "./run.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
export type WorkflowHistoryGetEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkflowRunView }
  | { kind: "error"; error: SwampError };

/** Dependencies for the workflow history get operation. */
export interface WorkflowHistoryGetDeps {
  isPartialId: (value: string) => boolean;
  matchRunByPartialId: (idPrefix: string) => Promise<PartialMatchResult>;
  findWorkflow: (idOrName: string) => Promise<Workflow | null>;
  findLatestRun: (workflowId: WorkflowId) => Promise<WorkflowRun | null>;
  getRunPath: (workflowId: WorkflowId, runId: string) => string;
  /** Reads a run's step outputs back from the datastore. */
  resolveStepOutputs: (run: WorkflowRun) => Promise<RunStepOutputs>;
}

/** Options for {@link workflowHistoryGet}. */
export interface WorkflowHistoryGetOptions {
  /**
   * Resolve step outputs and data attributes from the datastore. Leave unset
   * when the caller does not render them, so no data is read.
   */
  includeOutputs?: boolean;
}

/**
 * Wires real infrastructure into WorkflowHistoryGetDeps. `canRead` limits
 * which resources' attributes may appear in step outputs; serve passes the
 * principal's data-read decision. Sensitive fields are shown as stored,
 * never resolved from their vault.
 */
export function createWorkflowHistoryGetDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
  injectedWorkflowRepo?: WorkflowRepository,
  canRead?: ResourceReadPolicy,
): WorkflowHistoryGetDeps {
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const workflowRepo: WorkflowRepository = injectedWorkflowRepo ??
    new YamlWorkflowRepository(repoDir);
  const runRepo = new YamlWorkflowRunRepository(
    repoDir,
    undefined,
    dsPath(SWAMP_SUBDIRS.workflowRuns),
  );
  return {
    isPartialId,
    matchRunByPartialId: createRunMatcher(runRepo),
    findWorkflow: async (idOrName) =>
      await workflowRepo.findByName(idOrName) ??
        await workflowRepo.findById(createWorkflowId(idOrName)),
    findLatestRun: (workflowId) => runRepo.findLatestByWorkflowId(workflowId),
    getRunPath: (workflowId, runId) =>
      runRepo.getPath(workflowId, createWorkflowRunId(runId)),
    resolveStepOutputs: async (run) => {
      // Opened per call: only callers that render outputs pay for it.
      const catalogStore = createCatalogStore(repoDir, datastoreResolver);
      try {
        const dataRepo = new FileSystemUnifiedDataRepository(
          repoDir,
          dsPath(SWAMP_SUBDIRS.data),
          catalogStore,
          undefined,
          undefined,
          namespaceFromResolver(datastoreResolver),
        );
        const resolver = new StepOutputResolver({
          readAttributes: createDataRepositoryAttributeReader(dataRepo),
          findChildRun: (workflowId, runId) =>
            runRepo.findById(
              createWorkflowId(workflowId),
              createWorkflowRunId(runId),
            ),
          canRead,
        });
        return await resolveRunStepOutputs(run, resolver);
      } finally {
        catalogStore.close();
      }
    },
  };
}

/** Retrieves a specific run by ID or the latest run for a workflow. */
export async function* workflowHistoryGet(
  _ctx: LibSwampContext,
  deps: WorkflowHistoryGetDeps,
  runIdOrWorkflow: string,
  options: WorkflowHistoryGetOptions = {},
): AsyncIterable<WorkflowHistoryGetEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.history.get",
    {},
    (async function* () {
      yield { kind: "resolving" };

      let run: WorkflowRun | undefined;

      if (deps.isPartialId(runIdOrWorkflow)) {
        const result = await deps.matchRunByPartialId(runIdOrWorkflow);

        if (result.status === "found" && result.match) {
          run = result.match;
        } else if (result.status === "ambiguous" && result.matches) {
          yield {
            kind: "error",
            error: validationFailed(
              `Ambiguous ID prefix "${runIdOrWorkflow}" matches:\n` +
                result.matches.map((m) => `  ${m.id}`).join("\n"),
            ),
          };
          return;
        }
      }

      if (!run) {
        const workflow = await deps.findWorkflow(runIdOrWorkflow);
        if (!workflow) {
          yield {
            kind: "error",
            error: {
              code: "not_found",
              message: `No workflow run or workflow found: ${runIdOrWorkflow}`,
              details: {
                entityType: "Workflow run or workflow",
                idOrName: runIdOrWorkflow,
              },
            },
          };
          return;
        }

        const latestRun = await deps.findLatestRun(workflow.id);
        if (!latestRun) {
          yield {
            kind: "error",
            error: notFound(
              "Workflow run",
              `no runs for workflow: ${workflow.name}`,
            ),
          };
          return;
        }

        run = latestRun;
      }

      const path = deps.getRunPath(
        run.workflowId as WorkflowId,
        run.id,
      );
      const stepOutputs = options.includeOutputs
        ? await deps.resolveStepOutputs(run)
        : undefined;
      const data = toRunData(run, path, undefined, stepOutputs);

      yield { kind: "completed", data };
    })(),
  );
}
