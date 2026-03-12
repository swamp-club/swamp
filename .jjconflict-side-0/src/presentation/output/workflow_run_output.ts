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

import type { OutputMode } from "./output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

// Re-export view-model types from libswamp with backward-compatible aliases.
// The canonical definitions now live in libswamp/workflows/workflow_run_view.ts.
export {
  type DataArtifactRefData,
  type JobRunView as JobRunData,
  type StepArtifactsData,
  type StepRunView as StepRunData,
  type WorkflowRunView as WorkflowRunData,
} from "../../libswamp/mod.ts";

import type { WorkflowRunView } from "../../libswamp/mod.ts";

export function renderWorkflowRun(
  data: WorkflowRunView,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderLogWorkflowRun(data);
  }
}

function renderLogWorkflowRun(data: WorkflowRunView): void {
  const logger = getSwampLogger(["workflow", "run"]);

  logger.info("Workflow: {workflowName} (Run ID: {id})", {
    workflowName: data.workflowName,
    id: data.id,
  });

  for (const job of data.jobs) {
    const durationSuffix = job.duration !== undefined
      ? ` (${job.duration}ms)`
      : "";
    logger.info("  {status} {jobName}{duration}", {
      status: statusIcon(job.status),
      jobName: job.name,
      duration: durationSuffix,
    });

    for (const step of job.steps) {
      const stepDuration = step.duration !== undefined
        ? ` (${step.duration}ms)`
        : "";
      const stepIcon = step.status === "failed" && step.allowedFailure
        ? "\u26A0"
        : statusIcon(step.status);
      logger.info("    {status} {stepName}{duration}", {
        status: stepIcon,
        stepName: step.name,
        duration: stepDuration,
      });

      if (step.error) {
        logger.error("      -> {error}", { error: step.error });
      }
    }
  }

  const resultLevel = data.status === "failed" ? "error" : "info";
  const durationSuffix = data.duration !== undefined
    ? ` (${data.duration}ms)`
    : "";
  logger[resultLevel]("Result: {status}{duration}", {
    status: data.status.toUpperCase(),
    duration: durationSuffix,
  });

  if (data.path) {
    logger.info("Saved to: {path}", { path: data.path });
  }
}

function statusIcon(
  status: "pending" | "running" | "succeeded" | "failed" | "skipped",
): string {
  const icons: Record<string, string> = {
    pending: "\u25CB",
    running: "\u25D0",
    succeeded: "\u2713",
    failed: "\u2717",
    skipped: "\u2298",
  };
  return icons[status] ?? "?";
}
