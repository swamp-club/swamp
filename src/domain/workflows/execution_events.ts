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
 * the domain execution service throws errors rather than yielding an error
 * terminal; libswamp wraps them as an error event
 */
export interface WorkflowJobInfo {
  id: string;
  stepCount: number;
  dependsOn: string[];
}

export interface FanOutEventSelector {
  labels?: Record<string, string>;
  platform?: string;
}

// a worker's name only: its instance UUID stays in the run record
export interface FanOutEventMember {
  worker: string;
  disposition: "dispatch" | "waiting" | "skipped" | "failed" | "excluded";
  reason?: "disconnected" | "unverified" | "draining";
}

/** older remote CLIs have no handler for these, so serve sends them on request */
export const FAN_OUT_EVENT_KINDS = [
  "job_fanout_planned",
  "job_fanout_waiting",
  "job_fanout_summary",
  "job_fanout_batch_started",
  "job_fanout_halted",
] as const;

export type WorkflowExecutionEvent =
  | {
    kind: "started";
    runId: string;
    /**
     * the parent forwards its child's events into its own stream, so consumers
     * that track a run by id act only on a started event without this
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
    kind: "job_fanout_planned";
    jobId: string;
    selector: FanOutEventSelector;
    offline: "wait" | "skip" | "fail";
    minWorkers: number;
    plannedLanes: number;
    members: FanOutEventMember[];
    /** set for a rollout: the frozen plan's batches and its budget, null for none */
    batches?: string[][];
    maxFailures?: number | null;
    /**
     * set on a resume: the lanes that run again and those whose result stands;
     * for a rollout, held names the re-run lanes the last halt held
     */
    resumed?: { rerun: string[]; kept: string[]; held?: string[] };
  }
  | {
    kind: "job_fanout_waiting";
    jobId: string;
    worker: string;
    /** null when serve's default applies and the domain cannot read it */
    queueTimeoutSeconds: number | null;
  }
  | {
    kind: "job_fanout_summary";
    jobId: string;
    matching: number;
    lanesSucceeded: number;
    lanesFailed: number;
    excluded: FanOutEventMember[];
    skipped: FanOutEventMember[];
    failedAtPlan: FanOutEventMember[];
    /** set for a rollout: the lanes a halt left unstarted */
    held?: string[];
    /** set for a rollout with a budget; used counts this attempt's failed lanes */
    budget?: { used: number; allowed: number };
  }
  | {
    kind: "job_fanout_batch_started";
    jobId: string;
    /** indexes this attempt's batches; a resume runs failed lanes first */
    batch: number;
    batches: number;
    lanes: string[];
  }
  | {
    kind: "job_fanout_halted";
    jobId: string;
    failed: string[];
    maxFailures: number;
    held: string[];
  }
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
     * differs from the top-level run for events a nested workflow step
     * forwards, whose names can repeat the parent's; domain-internal, stripped
     * from the published event
     */
    runId: string;
    dataHandles?: DataHandle[];
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
     * a nested workflow's gate reaches the parent's stream with the child's
     * workflow and run
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
    waitId: string;
    deadline: string;
    key?: string;
  }
  | {
    kind: "step_failed";
    jobId: string;
    stepId: string;
    /**
     * differs from the top-level run for events a nested workflow step
     * forwards, whose names can repeat the parent's; domain-internal, stripped
     * from the published event
     */
    runId: string;
    error: string;
    errorCode?: string;
    allowedFailure?: boolean;
    /**
     * set only for model-method tasks; the telemetry bridge keys off their
     * presence to synthesize a child entry for failures before method_executing
     * was yielded; structural failures leave them undefined
     */
    modelName?: string;
    methodName?: string;
    /**
     * set when the step settles on its nested run, so a server can hide the
     * error from a caller who may not read it
     */
    nestedRun?: { workflowId: string; workflowName: string };
    dataHandles?: DataHandle[];
    /**
     * lets telemetry remove them exactly from error; set only at the
     * model-method catch site; domain-internal, stripped from the published
     * event
     */
    errorPaths?: string[];
    /**
     * set only when the registration names the workflow, key and run of the
     * refusing claim; the step's error stays the bare wait_key_held; a server
     * can hide it from a caller who may not read the holder's workflow
     */
    waitKeyHolder?: WaitKeyHolder;
    forEachTemplate?: string;
    forEachIndex?: number;
  }
  | {
    kind: "model_resolved";
    jobId: string;
    stepId: string;
    /**
     * differs from the top-level run for events a nested workflow step
     * forwards, whose names can repeat the parent's; domain-internal, stripped
     * from the published event
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
     * differs from the top-level run for events a nested workflow step
     * forwards, whose names can repeat the parent's; domain-internal, stripped
     * from the published event
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
     * set when the run suspended on a nested workflow step rather than a gate
     * of its own; jobId and stepId are then the nested step
     */
    nested?: { workflowName: string; runId: string };
    wait?: { id: string; deadline: string; key?: string };
    /**
     * each at the innermost run that has to act; none for a nested run that has
     * a gate to decide first; set whichever step jobId and stepId name
     */
    nestedSignalWaits?: NestedSignalWait[];
  };

export interface NestedSignalWait {
  workflowId: string;
  workflowName: string;
  runId: string;
  jobId: string;
  stepId: string;
  waitId: string;
  deadline: string;
  key?: string;
}

export interface WaitKeyHolder {
  workflowId: string;
  workflowName: string;
  key: string;
  runId: string;
  stepName: string;
  waitId: string;
}
