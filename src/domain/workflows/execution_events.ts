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

import type { MethodExecutionEvent } from "../models/method_events.ts";
import type { DataHandle } from "../models/model.ts";
import type { EnvVarUsageDetail } from "../models/validation_service.ts";
// deno-lint-ignore verbatim-module-syntax
import { WorkflowRun } from "./workflow_run.ts";

/**
 * Events emitted by the workflow execution generator.
 *
 * These events use `kind` as their discriminant field. The domain execution
 * service throws errors rather than yielding an `error` terminal — the
 * libswamp layer catches thrown errors and wraps them as
 * `{ kind: "error", error: SwampError }` for the consumer.
 */
/**
 * Lightweight job metadata emitted with the `started` event so renderers
 * can display the full tree skeleton before any jobs begin executing.
 */
export interface WorkflowJobInfo {
  id: string;
  stepCount: number;
  dependsOn: string[];
}

export type WorkflowExecutionEvent =
  | {
    kind: "started";
    runId: string;
    workflowName: string;
    logPath: string;
    jobs: WorkflowJobInfo[];
  }
  | { kind: "job_started"; jobId: string }
  | { kind: "job_completed"; jobId: string; status: string }
  | { kind: "job_skipped"; jobId: string }
  | { kind: "step_started"; jobId: string; stepId: string }
  | {
    kind: "step_completed";
    jobId: string;
    stepId: string;
    dataHandles?: DataHandle[];
  }
  | { kind: "step_skipped"; jobId: string; stepId: string }
  | {
    kind: "step_failed";
    jobId: string;
    stepId: string;
    error: string;
    allowedFailure?: boolean;
  }
  | {
    kind: "model_resolved";
    jobId: string;
    stepId: string;
    modelName: string;
    modelType: string;
    methodName: string;
  }
  | {
    kind: "env_var_warning";
    jobId: string;
    stepId: string;
    modelName: string;
    envVars: EnvVarUsageDetail[];
    message: string;
  }
  | {
    kind: "method_executing";
    jobId: string;
    stepId: string;
    modelName: string;
    methodName: string;
  }
  | {
    kind: "method_output";
    jobId: string;
    stepId: string;
    modelName: string;
    methodName: string;
    stream: "stdout" | "stderr";
    line: string;
  }
  | {
    kind: "method_event";
    jobId: string;
    stepId: string;
    modelName: string;
    methodName: string;
    event: MethodExecutionEvent;
  }
  | {
    kind: "report_started";
    reportName: string;
    scope: string;
    jobId?: string;
    stepId?: string;
  }
  | {
    kind: "report_completed";
    reportName: string;
    scope: string;
    markdown: string;
    json: Record<string, unknown>;
    jobId?: string;
    stepId?: string;
  }
  | {
    kind: "report_failed";
    reportName: string;
    scope: string;
    error: string;
    jobId?: string;
    stepId?: string;
  }
  | { kind: "completed"; run: WorkflowRun };
