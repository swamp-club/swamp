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

import type { MethodExecutionEvent } from "../models/method_events.ts";
import type { DataHandle } from "../models/model.ts";
import type { EnvVarUsageDetail } from "../models/validation_service.ts";
import type { AssertSeverity } from "./step_task.ts";
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
    /**
     * Set when a nested workflow step started this run: the id of the run
     * whose step called it. The parent forwards its child's events into its
     * own stream, so consumers that track a run by id act only on a started
     * event without it.
     */
    parentRunId?: string;
    workflowName: string;
    logPath: string;
    jobs: WorkflowJobInfo[];
  }
  | { kind: "job_started"; jobId: string }
  | { kind: "job_completed"; jobId: string; status: string }
  | { kind: "job_skipped"; jobId: string }
  | {
    kind: "step_started";
    jobId: string;
    stepId: string;
    forEachTemplate?: string;
    forEachIndex?: number;
  }
  | {
    kind: "step_completed";
    jobId: string;
    stepId: string;
    /**
     * The run that owns this step. Differs from the top-level run for events
     * a nested workflow step forwards, whose job and step names can repeat the
     * parent's. Domain-internal: mapWorkflowExecutionEvent strips it from the
     * published event.
     */
    runId: string;
    dataHandles?: DataHandle[];
    /** "loopback" or the worker name that executed the step's method. */
    executor?: string;
    forEachTemplate?: string;
    forEachIndex?: number;
  }
  | {
    kind: "step_skipped";
    jobId: string;
    stepId: string;
    reason?: "guarded" | "dependency";
    guardExpression?: string;
    guardResult?: unknown;
    forEachTemplate?: string;
    forEachIndex?: number;
  }
  | {
    kind: "approval_requested";
    runId: string;
    /**
     * The workflow the gate belongs to. A nested workflow's gate reaches the
     * parent's stream with the child's workflow and run (swamp-club#2736).
     */
    workflowName?: string;
    jobId: string;
    stepId: string;
    prompt: string;
    timeout?: number;
  }
  | {
    kind: "signal_wait_requested";
    runId: string;
    /** The workflow the wait belongs to, which differs for a nested run. */
    workflowName?: string;
    jobId: string;
    stepId: string;
    /** The id a signal names to settle this wait. */
    waitId: string;
    /** When the wait stops accepting a signal, as an ISO timestamp. */
    deadline: string;
  }
  | {
    kind: "step_failed";
    jobId: string;
    stepId: string;
    /**
     * The run that owns this step. Differs from the top-level run for events
     * a nested workflow step forwards, whose job and step names can repeat the
     * parent's. Domain-internal: mapWorkflowExecutionEvent strips it from the
     * published event.
     */
    runId: string;
    error: string;
    allowedFailure?: boolean;
    /**
     * Populated only when the failing step represents a model-method task
     * (the runStep model-method catch site). Workflow-task failures and
     * structural failures (cycle, max nesting depth) leave these
     * undefined — the libswamp telemetry bridge keys off their presence
     * to synthesize a child entry for failures that occur BEFORE the
     * `method_executing` event was yielded.
     */
    modelName?: string;
    methodName?: string;
    /**
     * The nested workflow a nested workflow step's failure names in `error`,
     * set when the step settles on its nested run (swamp-club#2736), so a
     * server can hide the error from a caller who may not read it.
     */
    nestedRun?: { workflowId: string; workflowName: string };
    /**
     * Data a failing model-method step persisted before it threw, so the
     * workflow summary can point at it. Set only at the model-method catch
     * site, and only when there is such data.
     */
    dataHandles?: DataHandle[];
    /**
     * Filesystem paths the step's error marked (see `markErrorPaths`), so
     * telemetry can remove them exactly from `error` (swamp-club#2830). Set
     * only at the model-method catch site. Domain-internal:
     * mapWorkflowExecutionEvent strips it from the published event.
     */
    errorPaths?: string[];
    forEachTemplate?: string;
    forEachIndex?: number;
  }
  | {
    kind: "model_resolved";
    jobId: string;
    stepId: string;
    /**
     * The run that owns this step. Differs from the top-level run for events
     * a nested workflow step forwards, whose job and step names can repeat the
     * parent's. Domain-internal: mapWorkflowExecutionEvent strips it from the
     * published event.
     */
    runId: string;
    modelName: string;
    modelType: string;
    modelId: string;
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
    /**
     * The run that owns this step. Differs from the top-level run for events
     * a nested workflow step forwards, whose job and step names can repeat the
     * parent's. Domain-internal: mapWorkflowExecutionEvent strips it from the
     * published event.
     */
    runId: string;
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
    kind: "step_queued";
    jobId: string;
    stepId: string;
    requirement: string;
  }
  | {
    kind: "step_target_disconnected";
    jobId: string;
    stepId: string;
    target: string;
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
  | {
    kind: "assert_result";
    jobId: string;
    stepId: string;
    passed: boolean;
    message: string;
    severity: AssertSeverity;
    expr: string;
    error?: string;
  }
  | { kind: "completed"; run: WorkflowRun }
  | { kind: "cancelled"; run: WorkflowRun; reason?: string }
  | {
    kind: "suspended";
    run: WorkflowRun;
    jobId: string;
    stepId: string;
    prompt: string;
    timeout?: number;
    /**
     * Set when the run suspended on a nested workflow step rather than a
     * gate of its own: the child run the step waits on (swamp-club#2736).
     * `jobId` and `stepId` are then the nested step.
     */
    nested?: { workflowName: string; runId: string };
    /**
     * Set when the run suspended on a step waiting for a signal rather than
     * a gate: the wait a signal names. `jobId` and `stepId` are that step.
     */
    wait?: { id: string; deadline: string };
  };
