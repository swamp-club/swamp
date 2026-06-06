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
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import {
  isPartialId,
  matchByPartialId,
} from "../../domain/models/model_lookup.ts";
import { readLogFile } from "../../presentation/output/log_file_reader.ts";
import { toRelativePath } from "../../infrastructure/persistence/paths.ts";
import { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { LibSwampContext } from "../context.ts";
import { notFound, type SwampError, validationFailed } from "../errors.ts";

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
}

/** Partial ID match result. */
interface PartialMatchResult {
  status: "found" | "not_found" | "ambiguous";
  match?: WorkflowRun;
  matches?: Array<{ id: string }>;
}

/** Dependencies for the workflow history logs operation. */
export interface WorkflowHistoryLogsDeps {
  isPartialId: (value: string) => boolean;
  matchRunByPartialId: (
    runIdOrWorkflow: string,
  ) => Promise<PartialMatchResult>;
  findWorkflow: (nameOrId: string) => Promise<Workflow | null>;
  findLatestRun: (workflowId: string) => Promise<WorkflowRun | null>;
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
    findWorkflow: async (nameOrId: string) =>
      await workflowRepo.findByName(nameOrId) ??
        await workflowRepo.findById(createWorkflowId(nameOrId)),
    findLatestRun: (workflowId: string) =>
      runRepo.findLatestByWorkflowId(createWorkflowId(workflowId)),
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

      let run: WorkflowRun | undefined;

      // Try partial ID matching first if input looks like an ID
      if (deps.isPartialId(input.runIdOrWorkflow)) {
        const result = await deps.matchRunByPartialId(input.runIdOrWorkflow);

        if (result.status === "found" && result.match) {
          run = result.match;
        } else if (result.status === "ambiguous" && result.matches) {
          yield {
            kind: "error",
            error: validationFailed(
              `Ambiguous ID prefix "${input.runIdOrWorkflow}" matches:\n` +
                result.matches.map((m) => `  ${m.id}`).join("\n"),
            ),
          };
          return;
        }
        // not_found: fall through to workflow name lookup
      }

      // If not found as run ID, try as workflow name and get latest run
      if (!run) {
        const workflow = await deps.findWorkflow(input.runIdOrWorkflow);

        if (!workflow) {
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
        }

        const latestRun = await deps.findLatestRun(workflow.id);
        if (!latestRun) {
          yield {
            kind: "error",
            error: notFound("Run", `for workflow: ${workflow.name}`),
          };
          return;
        }

        run = latestRun;
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
