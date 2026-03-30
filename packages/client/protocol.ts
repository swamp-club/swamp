// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and\/or modify
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
// along with Swamp.  If not, see <https:\/\/www.gnu.org\/licenses\/>.

/**
 * Wire protocol types for the swamp WebSocket API.
 *
 * These types mirror src/serve/protocol.ts in the swamp CLI. They are
 * duplicated here so the client package has zero dependencies on the CLI
 * source tree and can be published independently to JSR.
 */

// ── Inbound (client → server) ────────────────────────────────────────────

export interface WorkflowRunPayload {
  workflowIdOrName: string;
  inputs?: Record<string, unknown>;
  lastEvaluated?: boolean;
  driver?: string;
  verbose?: boolean;
  runtimeTags?: Record<string, string>;
}

export interface ModelMethodRunPayload {
  modelIdOrName: string;
  methodName: string;
  inputs?: Record<string, unknown>;
  lastEvaluated?: boolean;
  driver?: string;
  runtimeTags?: Record<string, string>;
}

export type ServerRequest =
  | { type: "workflow.run"; id: string; payload: WorkflowRunPayload }
  | { type: "model.method.run"; id: string; payload: ModelMethodRunPayload }
  | { type: "cancel"; id: string };

// ── Outbound (server → client) ───────────────────────────────────────────

export interface SerializedEvent {
  kind: string;
  [key: string]: unknown;
}

export interface SerializedError {
  code: string;
  message: string;
  details?: unknown;
}

export type ServerMessage =
  | { type: "event"; id: string; event: SerializedEvent }
  | { type: "error"; id: string; error: SerializedError };

// ── Event types (wire-format discriminated unions) ────────────────────────

/** Events emitted during a workflow run. */
export type WorkflowRunEvent =
  | { kind: "validating_inputs" }
  | { kind: "evaluating_workflow" }
  | { kind: "started"; runId: string; workflowName: string }
  | { kind: "job_started"; jobId: string }
  | { kind: "job_completed"; jobId: string; status: string }
  | { kind: "job_skipped"; jobId: string }
  | { kind: "step_started"; jobId: string; stepId: string }
  | { kind: "step_completed"; jobId: string; stepId: string }
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
    envVars: Array<{ path: string; envVar: string }>;
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
    event: Record<string, unknown>;
  }
  | { kind: "report_started"; reportName: string; scope: string }
  | {
    kind: "report_completed";
    reportName: string;
    scope: string;
    markdown: string;
    json: Record<string, unknown>;
  }
  | { kind: "report_failed"; reportName: string; scope: string; error: string }
  | { kind: "completed"; run: WorkflowRunView }
  | { kind: "error"; error: SerializedError };

/** Events emitted during a model method run. */
export type ModelMethodRunEvent =
  | { kind: "validating_inputs" }
  | { kind: "resolving_model"; modelIdOrName: string }
  | {
    kind: "model_resolved";
    modelName: string;
    modelType: string;
    methodName: string;
  }
  | {
    kind: "env_var_warning";
    modelName: string;
    envVars: Array<{ path: string; envVar: string }>;
    message: string;
  }
  | { kind: "evaluating_expressions"; lastEvaluated: boolean }
  | { kind: "executing"; modelName: string; methodName: string }
  | {
    kind: "method_output";
    modelName: string;
    methodName: string;
    stream: "stdout" | "stderr";
    line: string;
  }
  | {
    kind: "method_event";
    modelName: string;
    methodName: string;
    event: Record<string, unknown>;
  }
  | { kind: "data_artifact_saved"; name: string; path: string }
  | { kind: "report_started"; reportName: string; scope: string }
  | {
    kind: "report_completed";
    reportName: string;
    scope: string;
    markdown: string;
    json: Record<string, unknown>;
  }
  | { kind: "report_failed"; reportName: string; scope: string; error: string }
  | { kind: "completed"; run: ModelMethodRunView }
  | { kind: "error"; error: SerializedError };

// ── Completed event payload types ────────────────────────────────────────

export interface WorkflowRunView {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  jobs: Array<{
    name: string;
    status: string;
    steps: Array<{
      name: string;
      status: string;
      error?: string;
      duration?: number;
      dataArtifacts?: Array<{
        dataId: string;
        name: string;
        version: number;
        tags: Record<string, string>;
      }>;
      allowedFailure?: boolean;
    }>;
    duration?: number;
  }>;
  duration?: number;
  path?: string;
}

export interface ModelMethodRunView {
  modelId: string;
  modelName: string;
  modelType: string;
  methodName: string;
  status: string;
  duration?: number;
  outputId: string;
  logFile?: string;
  dataArtifacts: Array<{
    id: string;
    name: string;
    path: string;
    attributes?: Record<string, unknown>;
  }>;
}
