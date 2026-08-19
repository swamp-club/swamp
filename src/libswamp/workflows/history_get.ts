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
import {
  isPartialId,
  matchByPartialId,
} from "../../domain/models/model_lookup.ts";
import { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound, validationFailed } from "../errors.ts";
import type { WorkflowRunView } from "./workflow_run_view.ts";
import { toRunData } from "./run.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
export type WorkflowHistoryGetEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkflowRunView }
  | { kind: "error"; error: SwampError };

/** Partial ID match result. */
interface PartialMatchResult {
  status: "found" | "not_found" | "ambiguous";
  match?: WorkflowRun;
  matches?: Array<{ id: string }>;
}

/** Dependencies for the workflow history get operation. */
export interface WorkflowHistoryGetDeps {
  isPartialId: (value: string) => boolean;
  matchRunByPartialId: (idPrefix: string) => Promise<PartialMatchResult>;
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
    isPartialId,
    matchRunByPartialId: async (idPrefix: string) => {
      const allRuns = await runRepo.findAllGlobal();
      const result = matchByPartialId(
        allRuns.map((r) => ({ id: r.run.id, item: r.run })),
        idPrefix,
      );
      if (result.status === "found") {
        return { status: "found" as const, match: result.match };
      }
      if (result.status === "ambiguous") {
        return {
          status: "ambiguous" as const,
          matches: result.matches.map((m) => ({ id: m.id })),
        };
      }
      return { status: "not_found" as const };
    },
    findWorkflow: async (idOrName) =>
      await workflowRepo.findByName(idOrName) ??
        await workflowRepo.findById(createWorkflowId(idOrName)),
    findLatestRun: (workflowId) => runRepo.findLatestByWorkflowId(workflowId),
    getRunPath: (workflowId, runId) =>
      runRepo.getPath(workflowId, createWorkflowRunId(runId)),
  };
}

/** Retrieves a specific run by ID or the latest run for a workflow. */
export async function* workflowHistoryGet(
  _ctx: LibSwampContext,
  deps: WorkflowHistoryGetDeps,
  runIdOrWorkflow: string,
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
      const data = toRunData(run, path);

      yield { kind: "completed", data };
    })(),
  );
}
