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
import { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound } from "../errors.ts";
import type { WorkflowRunView } from "./workflow_run_view.ts";
import { toRunData } from "./run.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
export type WorkflowHistoryGetEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkflowRunView }
  | { kind: "error"; error: SwampError };

/** Dependencies for the workflow history get operation. */
export interface WorkflowHistoryGetDeps {
  findWorkflow: (idOrName: string) => Promise<Workflow | null>;
  findLatestRun: (workflowId: WorkflowId) => Promise<WorkflowRun | null>;
  getRunPath: (workflowId: WorkflowId, runId: string) => string;
}

/** Wires real infrastructure into WorkflowHistoryGetDeps. */
export function createWorkflowHistoryGetDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
  injectedWorkflowRepo?: WorkflowRepository,
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
    findWorkflow: async (idOrName) =>
      await workflowRepo.findByName(idOrName) ??
        await workflowRepo.findById(createWorkflowId(idOrName)),
    findLatestRun: (workflowId) => runRepo.findLatestByWorkflowId(workflowId),
    getRunPath: (workflowId, runId) =>
      runRepo.getPath(workflowId, createWorkflowRunId(runId)),
  };
}

/** Retrieves the latest run for a workflow. */
export async function* workflowHistoryGet(
  _ctx: LibSwampContext,
  deps: WorkflowHistoryGetDeps,
  workflowIdOrName: string,
): AsyncIterable<WorkflowHistoryGetEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.history.get",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const workflow = await deps.findWorkflow(workflowIdOrName);
      if (!workflow) {
        yield { kind: "error", error: notFound("Workflow", workflowIdOrName) };
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

      const path = deps.getRunPath(workflow.id, latestRun.id);
      const data = toRunData(latestRun, path);

      yield { kind: "completed", data };
    })(),
  );
}
