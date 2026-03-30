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

import type {
  WorkflowRunEvent,
  WorkflowRunView,
} from "../../../libswamp/mod.ts";

/** Maximum lines retained in a step's output buffer. */
export const MAX_OUTPUT_LINES = 1000;

// ---------------------------------------------------------------------------
// Report stored per-step
// ---------------------------------------------------------------------------

export type StepReport =
  | { success: true; name: string; markdown: string }
  | { success: false; name: string; error: string };

// ---------------------------------------------------------------------------
// Step state
// ---------------------------------------------------------------------------

export interface StepState {
  id: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  modelName: string | null;
  methodName: string | null;
  startedAt: number | null;
  outputBuffer: string[];
  error: string | null;
  allowedFailure: boolean;
  reports: StepReport[];
}

// ---------------------------------------------------------------------------
// Job state
// ---------------------------------------------------------------------------

export interface JobState {
  id: string;
  status:
    | "waiting"
    | "blocked"
    | "running"
    | "completed"
    | "failed"
    | "skipped";
  dependsOn: string[];
  startedAt: number | null;
  steps: Map<string, StepState>;
  stepOrder: string[];
  completedStepCount: number;
  duration: number | null;
  finalStatus: string | null;
}

// ---------------------------------------------------------------------------
// Scrollback items — graduated to <Static>
// ---------------------------------------------------------------------------

export interface ScrollbackOutputSection {
  stepId: string;
  modelName: string;
  methodName: string;
  lines: string[];
  error: string | null;
  allowedFailure: boolean;
  reports: StepReport[];
}

export type ScrollbackItem =
  | {
    type: "job";
    jobId: string;
    status: string;
    totalStepCount: number;
    completedStepCount: number;
    /** Model/method name when the job had exactly 1 step. */
    singleStepLabel: string | null;
    duration: number | null;
    outputSections: ScrollbackOutputSection[];
  }
  | { type: "report"; name: string; markdown: string }
  | { type: "report_error"; name: string; error: string }
  | {
    type: "data_hints";
    workflowName: string;
    artifactNames: string[];
  };

// ---------------------------------------------------------------------------
// Root tree state
// ---------------------------------------------------------------------------

export type TreePhase = "init" | "running" | "reports" | "done";

export interface TreeState {
  phase: TreePhase;
  workflowName: string;
  runId: string;
  jobs: Map<string, JobState>;
  jobOrder: string[];
  scrollback: ScrollbackItem[];
  activeReport: string | null;
  failed: boolean;
  finalRun: WorkflowRunView | null;
}

export function createInitialState(workflowName: string): TreeState {
  return {
    phase: "init",
    workflowName,
    runId: "",
    jobs: new Map(),
    jobOrder: [],
    scrollback: [],
    activeReport: null,
    failed: false,
    finalRun: null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cloneJobs(jobs: Map<string, JobState>): Map<string, JobState> {
  return new Map(jobs);
}

function updateJob(
  jobs: Map<string, JobState>,
  jobId: string,
  update: Partial<JobState>,
): Map<string, JobState> {
  const cloned = cloneJobs(jobs);
  const existing = cloned.get(jobId);
  if (existing) {
    cloned.set(jobId, { ...existing, ...update });
  }
  return cloned;
}

function getOrCreateStep(job: JobState, stepId: string): StepState {
  const existing = job.steps.get(stepId);
  if (existing) return existing;
  return {
    id: stepId,
    status: "pending",
    modelName: null,
    methodName: null,
    startedAt: null,
    outputBuffer: [],
    error: null,
    allowedFailure: false,
    reports: [],
  };
}

/**
 * After a job completes, re-evaluate blocked jobs whose dependencies
 * are now all completed/skipped.
 */
function recomputeBlockedStatus(jobs: Map<string, JobState>): void {
  for (const job of jobs.values()) {
    if (job.status !== "blocked") continue;
    const allDepsResolved = job.dependsOn.every((depId) => {
      const dep = jobs.get(depId);
      return dep &&
        (dep.status === "completed" || dep.status === "failed" ||
          dep.status === "skipped");
    });
    if (allDepsResolved) {
      jobs.set(job.id, { ...job, status: "waiting" });
    }
  }
}

/**
 * Graduate a completed/failed/skipped job to scrollback.
 */
function graduateJob(job: JobState): ScrollbackItem {
  const outputSections: ScrollbackOutputSection[] = [];
  for (const stepId of job.stepOrder) {
    const step = job.steps.get(stepId);
    if (!step) continue;
    if (
      step.outputBuffer.length > 0 || step.error !== null ||
      step.reports.length > 0
    ) {
      outputSections.push({
        stepId: step.id,
        modelName: step.modelName ?? step.id,
        methodName: step.methodName ?? "",
        lines: step.outputBuffer,
        error: step.error,
        allowedFailure: step.allowedFailure,
        reports: step.reports,
      });
    }
  }

  let singleStepLabel: string | null = null;
  if (job.stepOrder.length === 1) {
    const step = job.steps.get(job.stepOrder[0]);
    if (step?.modelName && step?.methodName) {
      const prefix = step.id !== step.modelName ? `${step.id}: ` : "";
      singleStepLabel = `${prefix}${step.modelName} \u2192 ${step.methodName}`;
    }
  }

  return {
    type: "job",
    jobId: job.id,
    status: job.finalStatus ?? job.status,
    totalStepCount: job.stepOrder.length,
    completedStepCount: job.completedStepCount,
    singleStepLabel,
    duration: job.duration,
    outputSections,
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Action type for the tree reducer. Supports both individual events and
 * batched events to avoid React's maximum update depth limit when many
 * events arrive within a single tick.
 */
export type TreeAction =
  | WorkflowRunEvent
  | { type: "batch"; events: WorkflowRunEvent[] };

/**
 * Top-level reducer that handles both single events and batch actions.
 * Batch actions fold each event through `treeReducerSingle` in order,
 * producing a single state update for React.
 */
export function treeReducer(
  state: TreeState,
  action: TreeAction,
): TreeState {
  if ("type" in action && action.type === "batch") {
    return action.events.reduce(
      (s, event) => treeReducerSingle(s, event),
      state,
    );
  }
  return treeReducerSingle(state, action as WorkflowRunEvent);
}

function treeReducerSingle(
  state: TreeState,
  event: WorkflowRunEvent,
): TreeState {
  switch (event.kind) {
    case "validating_inputs":
    case "evaluating_workflow":
      return state;

    case "started": {
      const jobs = new Map<string, JobState>();
      const jobOrder: string[] = [];
      const completedIds = new Set<string>();

      for (const jobInfo of event.jobs) {
        // Skip duplicates (forEach-expanded jobs can share a name)
        if (jobs.has(jobInfo.id)) continue;

        const hasUnresolvedDeps = jobInfo.dependsOn.some(
          (dep) => !completedIds.has(dep),
        );
        jobs.set(jobInfo.id, {
          id: jobInfo.id,
          status: hasUnresolvedDeps ? "blocked" : "waiting",
          dependsOn: jobInfo.dependsOn,
          startedAt: null,
          steps: new Map(),
          stepOrder: [],
          completedStepCount: 0,
          duration: null,
          finalStatus: null,
        });
        jobOrder.push(jobInfo.id);
      }

      return {
        ...state,
        phase: "running",
        workflowName: event.workflowName,
        runId: event.runId,
        jobs,
        jobOrder,
      };
    }

    case "job_started": {
      const jobs = updateJob(state.jobs, event.jobId, {
        status: "running",
        startedAt: Date.now(),
      });
      return { ...state, jobs };
    }

    case "job_completed": {
      const job = state.jobs.get(event.jobId);
      if (!job) return state;

      const duration = job.startedAt ? Date.now() - job.startedAt : null;

      const updatedJob: JobState = {
        ...job,
        status: event.status === "succeeded" ? "completed" : "failed",
        finalStatus: event.status,
        duration,
      };

      const jobs = cloneJobs(state.jobs);
      jobs.set(event.jobId, updatedJob);
      recomputeBlockedStatus(jobs);

      const scrollback = [
        ...state.scrollback,
        graduateJob(updatedJob),
      ];

      return { ...state, jobs, scrollback };
    }

    case "job_skipped": {
      const job = state.jobs.get(event.jobId);
      if (!job) return state;

      const updatedJob: JobState = { ...job, status: "skipped" };
      const jobs = cloneJobs(state.jobs);
      jobs.set(event.jobId, updatedJob);
      recomputeBlockedStatus(jobs);

      const scrollback = [
        ...state.scrollback,
        graduateJob(updatedJob),
      ];

      return { ...state, jobs, scrollback };
    }

    case "step_started": {
      const job = state.jobs.get(event.jobId);
      if (!job) return state;

      const step = getOrCreateStep(job, event.stepId);
      const newStep: StepState = {
        ...step,
        status: "running",
        startedAt: Date.now(),
      };
      const steps = new Map(job.steps);
      steps.set(event.stepId, newStep);

      const stepOrder = job.stepOrder.includes(event.stepId)
        ? job.stepOrder
        : [...job.stepOrder, event.stepId];

      const jobs = updateJob(state.jobs, event.jobId, { steps, stepOrder });
      return { ...state, jobs };
    }

    case "step_completed": {
      const job = state.jobs.get(event.jobId);
      if (!job) return state;

      const step = job.steps.get(event.stepId);
      if (!step) return state;

      const steps = new Map(job.steps);
      steps.set(event.stepId, { ...step, status: "completed" });

      const jobs = updateJob(state.jobs, event.jobId, {
        steps,
        completedStepCount: job.completedStepCount + 1,
      });
      return { ...state, jobs };
    }

    case "step_skipped": {
      const job = state.jobs.get(event.jobId);
      if (!job) return state;

      const step = getOrCreateStep(job, event.stepId);
      const steps = new Map(job.steps);
      steps.set(event.stepId, { ...step, status: "skipped" });

      const stepOrder = job.stepOrder.includes(event.stepId)
        ? job.stepOrder
        : [...job.stepOrder, event.stepId];

      const jobs = updateJob(state.jobs, event.jobId, { steps, stepOrder });
      return { ...state, jobs };
    }

    case "step_failed": {
      const job = state.jobs.get(event.jobId);
      if (!job) return state;

      const step = job.steps.get(event.stepId) ??
        getOrCreateStep(job, event.stepId);
      const steps = new Map(job.steps);
      steps.set(event.stepId, {
        ...step,
        status: "failed",
        error: event.error,
        allowedFailure: event.allowedFailure ?? false,
      });

      const stepOrder = job.stepOrder.includes(event.stepId)
        ? job.stepOrder
        : [...job.stepOrder, event.stepId];

      const completedStepCount = event.allowedFailure
        ? job.completedStepCount + 1
        : job.completedStepCount;

      const jobs = updateJob(state.jobs, event.jobId, {
        steps,
        stepOrder,
        completedStepCount,
      });
      return { ...state, jobs };
    }

    case "model_resolved": {
      const job = state.jobs.get(event.jobId);
      if (!job) return state;

      const step = job.steps.get(event.stepId) ??
        getOrCreateStep(job, event.stepId);
      const steps = new Map(job.steps);
      steps.set(event.stepId, {
        ...step,
        modelName: event.modelName,
        methodName: event.methodName,
      });

      const stepOrder = job.stepOrder.includes(event.stepId)
        ? job.stepOrder
        : [...job.stepOrder, event.stepId];

      const jobs = updateJob(state.jobs, event.jobId, { steps, stepOrder });
      return { ...state, jobs };
    }

    case "env_var_warning":
    case "method_executing":
      return state;

    case "method_output": {
      const job = state.jobs.get(event.jobId);
      if (!job) return state;

      const step = job.steps.get(event.stepId);
      if (!step) return state;

      const outputBuffer = step.outputBuffer.length >= MAX_OUTPUT_LINES
        ? [...step.outputBuffer.slice(1), event.line]
        : [...step.outputBuffer, event.line];

      const steps = new Map(job.steps);
      steps.set(event.stepId, { ...step, outputBuffer });

      const jobs = updateJob(state.jobs, event.jobId, { steps });
      return { ...state, jobs };
    }

    case "method_event":
      return state;

    case "report_started": {
      // Per-step reports: track via step's reports array
      // Workflow-scope reports: show progress line
      if (event.jobId && event.stepId) {
        return state;
      }
      return {
        ...state,
        phase: "reports",
        activeReport: event.reportName,
      };
    }

    case "report_completed": {
      if (event.jobId && event.stepId) {
        // Attach to the step
        const job = state.jobs.get(event.jobId);
        if (!job) return state;
        const step = job.steps.get(event.stepId);
        if (!step) return state;

        const steps = new Map(job.steps);
        steps.set(event.stepId, {
          ...step,
          reports: [
            ...step.reports,
            { success: true, name: event.reportName, markdown: event.markdown },
          ],
        });
        const jobs = updateJob(state.jobs, event.jobId, { steps });
        return { ...state, jobs };
      }

      // Workflow-scope report → scrollback
      return {
        ...state,
        activeReport: null,
        scrollback: [
          ...state.scrollback,
          { type: "report", name: event.reportName, markdown: event.markdown },
        ],
      };
    }

    case "report_failed": {
      if (event.jobId && event.stepId) {
        const job = state.jobs.get(event.jobId);
        if (!job) return state;
        const step = job.steps.get(event.stepId);
        if (!step) return state;

        const steps = new Map(job.steps);
        steps.set(event.stepId, {
          ...step,
          reports: [
            ...step.reports,
            { success: false, name: event.reportName, error: event.error },
          ],
        });
        const jobs = updateJob(state.jobs, event.jobId, { steps });
        return { ...state, jobs };
      }

      return {
        ...state,
        activeReport: null,
        scrollback: [
          ...state.scrollback,
          {
            type: "report_error",
            name: event.reportName,
            error: event.error,
          },
        ],
      };
    }

    case "completed": {
      return {
        ...state,
        phase: "done",
        failed: event.run.status === "failed",
        finalRun: event.run,
        activeReport: null,
      };
    }

    case "error":
      return {
        ...state,
        phase: "done",
        failed: true,
        activeReport: null,
      };

    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}
