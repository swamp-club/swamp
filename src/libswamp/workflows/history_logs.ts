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

import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import { isPartialId } from "../../domain/models/model_lookup.ts";
import { createRunMatcher } from "./run_lookup.ts";
import { readLogFile } from "../../presentation/output/log_file_reader.ts";
import { toRelativePath } from "../../infrastructure/persistence/paths.ts";
import { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { LibSwampContext } from "../context.ts";
import { notFound, type SwampError, validationFailed } from "../errors.ts";

import {
  resolveRunReference,
  type RunReference,
  type RunReferenceDeps,
} from "./run_reference.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/** Log file data. */
export interface LogData {
  lines: string[];
  path: string;
}

/** No log file data (pre-logFile runs). */
export interface NoLogFileData {
  runId: string;
  workflowName: string;
}

/** Empty log file data. */
export interface EmptyLogData {
  runId: string;
  workflowName: string;
  path: string;
}

export type WorkflowHistoryLogsCompletedData =
  | { type: "log"; log: LogData }
  | { type: "no_log_file"; info: NoLogFileData }
  | { type: "empty_log"; info: EmptyLogData };

export type WorkflowHistoryLogsEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkflowHistoryLogsCompletedData }
  | { kind: "error"; error: SwampError };

export interface WorkflowHistoryLogsInput {
  runIdOrWorkflow: string;
  tail?: number;
  repoDir: string;
  /**
   * The argument, already resolved with resolveRunReference. The read acts
   * on exactly this and does not look the argument up again.
   */
  reference?: RunReference;
}

/** Dependencies for the workflow history logs operation. */
export interface WorkflowHistoryLogsDeps extends RunReferenceDeps {
  readLogFile: (
    path: string,
    options?: { tail?: number },
  ) => Promise<LogData>;
  toRelativePath: (repoDir: string, path: string) => string;
}

/** Wires real infrastructure into WorkflowHistoryLogsDeps. */
export function createWorkflowHistoryLogsDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
  injectedWorkflowRepo?: WorkflowRepository,
): WorkflowHistoryLogsDeps {
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const runRepo = new YamlWorkflowRunRepository(
    repoDir,
    undefined,
    dsPath(SWAMP_SUBDIRS.workflowRuns),
  );
  const workflowRepo: WorkflowRepository = injectedWorkflowRepo ??
    new YamlWorkflowRepository(repoDir);
  return {
    isPartialId,
    matchRunByPartialId: createRunMatcher(runRepo),
    findWorkflow: async (nameOrId: string) =>
      await workflowRepo.findByName(nameOrId) ??
        await workflowRepo.findById(createWorkflowId(nameOrId)),
    findLatestRun: (workflowId) => runRepo.findLatestByWorkflowId(workflowId),
    readLogFile,
    toRelativePath,
  };
}

/** Yields log content for a workflow run. */
export async function* workflowHistoryLogs(
  _ctx: LibSwampContext,
  deps: WorkflowHistoryLogsDeps,
  input: WorkflowHistoryLogsInput,
): AsyncIterable<WorkflowHistoryLogsEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.history.logs",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const reference = input.reference ??
        await resolveRunReference(deps, input.runIdOrWorkflow);
      let run: WorkflowRun;
      switch (reference.kind) {
        case "run":
          run = reference.run;
          break;
        case "ambiguous":
          yield {
            kind: "error",
            error: validationFailed(
              `Ambiguous ID prefix "${input.runIdOrWorkflow}" matches:\n` +
                reference.ids.map((id) => `  ${id}`).join("\n"),
            ),
          };
          return;
        case "not_found":
          yield {
            kind: "error",
            error: {
              code: "not_found",
              message:
                `No workflow run or workflow found: ${input.runIdOrWorkflow}`,
              details: {
                entityType: "Workflow run or workflow",
                idOrName: input.runIdOrWorkflow,
              },
            },
          };
          return;
        case "workflow":
          if (!reference.latest) {
            yield {
              kind: "error",
              error: notFound(
                "Run",
                `for workflow: ${reference.workflow.name}`,
              ),
            };
            return;
          }
          run = reference.latest;
      }

      // Read log file
      if (!run.logFile) {
        yield {
          kind: "completed",
          data: {
            type: "no_log_file",
            info: {
              runId: run.id,
              workflowName: run.workflowName,
            },
          },
        };
        return;
      }

      const logData = await deps.readLogFile(run.logFile, { tail: input.tail });
      const displayPath = deps.toRelativePath(input.repoDir, run.logFile);

      if (logData.lines.length === 0) {
        yield {
          kind: "completed",
          data: {
            type: "empty_log",
            info: {
              runId: run.id,
              workflowName: run.workflowName,
              path: displayPath,
            },
          },
        };
        return;
      }

      yield {
        kind: "completed",
        data: {
          type: "log",
          log: { ...logData, path: displayPath },
        },
      };
    })(),
  );
}
