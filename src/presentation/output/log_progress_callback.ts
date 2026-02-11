// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { getWorkflowRunLogger } from "../../infrastructure/logging/logger.ts";
import type {
  ExecutionProgressCallback,
  ImplicitDependencyMap,
} from "../../domain/workflows/execution_service.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";

/**
 * Creates a LogTape-based progress callback for workflow lifecycle events.
 * Process output is streamed through LogTape loggers and persisted by
 * RunFileSink, so no stdout/stderr callbacks are needed.
 */
export function createLogProgressCallback(
  workflowName: string,
): ExecutionProgressCallback {
  const wfLogger = getWorkflowRunLogger(workflowName);

  return {
    onWorkflowStart: () => {
      wfLogger.info("Starting workflow");
    },

    onJobStart: (_run: WorkflowRun, jobName: string) => {
      getWorkflowRunLogger(workflowName, jobName).info("Job started");
    },

    onJobComplete: (_run: WorkflowRun, jobName: string) => {
      getWorkflowRunLogger(workflowName, jobName).info("Job completed");
    },

    onJobSkip: (_run: WorkflowRun, jobName: string) => {
      getWorkflowRunLogger(workflowName, jobName).info("Job skipped");
    },

    onStepStart: (
      _run: WorkflowRun,
      jobName: string,
      stepName: string,
    ) => {
      getWorkflowRunLogger(workflowName, jobName, stepName).info(
        "Step started",
      );
    },

    onStepComplete: (
      _run: WorkflowRun,
      jobName: string,
      stepName: string,
    ) => {
      getWorkflowRunLogger(workflowName, jobName, stepName).info(
        "Step completed",
      );
    },

    onStepSkip: (
      _run: WorkflowRun,
      jobName: string,
      stepName: string,
    ) => {
      getWorkflowRunLogger(workflowName, jobName, stepName).info(
        "Step skipped",
      );
    },

    onStepFail: (
      _run: WorkflowRun,
      jobName: string,
      stepName: string,
      error: string,
    ) => {
      getWorkflowRunLogger(workflowName, jobName, stepName).error(
        "Step failed: {error}",
        { error },
      );
    },

    onWorkflowComplete: (run: WorkflowRun) => {
      if (run.status === "failed") {
        wfLogger.error("Workflow {status}", { status: run.status });
      } else {
        wfLogger.with({ summary: true }).info("Workflow {status}", {
          status: run.status,
        });
      }
    },

    onImplicitDependencies: (deps: ImplicitDependencyMap) => {
      for (const [jobName, stepDeps] of deps) {
        for (const [stepName, depList] of stepDeps) {
          getWorkflowRunLogger(workflowName, jobName, stepName)
            .info("Implicit dependencies: {deps}", {
              deps: depList.join(", "),
            });
        }
      }
    },
  };
}
