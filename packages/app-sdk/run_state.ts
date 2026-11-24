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

import type { RunFollowEvent } from "../client/client.ts";
import type { WorkflowRunEvent } from "../client/protocol.ts";

/** A started run's events, or an attached one's with its notices. */
export type RunStreamEvent = WorkflowRunEvent | RunFollowEvent;

/** Where a run, job or step stands, from the events seen so far. */
export type RunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export interface RunStepState {
  /** `job/step`, unique across the run */
  key: string;
  jobId: string;
  stepId: string;
  /** the step a forEach iteration expands */
  template?: string;
  status: RunStatus;
  startedAt?: number;
  endedAt?: number;
  output: string[];
  error?: string;
}

export interface RunJobState {
  id: string;
  status: RunStatus;
  startedAt?: number;
  endedAt?: number;
}

export interface RunLogEntry {
  at: number;
  kind: string;
  text: string;
  tone: "info" | "good" | "bad" | "muted";
}

export interface RunState {
  runId?: string;
  status: RunStatus | "idle";
  startedAt?: number;
  endedAt?: number;
  jobs: Record<string, RunJobState>;
  steps: Record<string, RunStepState>;
  log: RunLogEntry[];
  error?: string;
  /** Browser clock minus serve's, from the quickest stamped event; `runClock` gives "now" on serve's clock. */
  clockOffsetMs?: number;
}

export const IDLE_RUN: RunState = {
  status: "idle",
  jobs: {},
  steps: {},
  log: [],
};

const MAX_LOG = 400;
const MAX_OUTPUT_LINES = 50;

export function stepKey(jobId: string, stepId: string): string {
  return `${jobId}/${stepId}`;
}

export type RunAction =
  | { kind: "begin"; at: number }
  | { kind: "event"; at: number; event: RunStreamEvent }
  | { kind: "failed"; at: number; error: string };

function withLog(state: RunState, entry: RunLogEntry): RunState {
  const log = state.log.length >= MAX_LOG
    ? [...state.log.slice(1), entry]
    : [...state.log, entry];
  return { ...state, log };
}

function updateStep(
  state: RunState,
  jobId: string,
  stepId: string,
  change: (step: RunStepState) => RunStepState,
): RunState {
  const key = stepKey(jobId, stepId);
  const step = state.steps[key] ??
    { key, jobId, stepId, status: "pending", output: [] };
  return { ...state, steps: { ...state.steps, [key]: change(step) } };
}

function updateJob(
  state: RunState,
  jobId: string,
  change: (job: RunJobState) => RunJobState,
): RunState {
  const job = state.jobs[jobId] ?? { id: jobId, status: "pending" };
  return { ...state, jobs: { ...state.jobs, [jobId]: change(job) } };
}

function jobStatus(status: string): RunStatus {
  return status === "succeeded" || status === "failed" ||
      status === "skipped" || status === "cancelled"
    ? status
    : "succeeded";
}

/** "Now" on the clock the run's times use, for a bar still growing. */
export function runClock(state: RunState, now: number = Date.now()): number {
  return now - (state.clockOffsetMs ?? 0);
}

function stampOf(event: RunStreamEvent): number | undefined {
  const at = (event as { at?: unknown }).at;
  const parsed = typeof at === "string" ? Date.parse(at) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The run record's start, which a continued run sends again unchanged. */
function recordedStart(event: { startedAt?: string }): number | undefined {
  const parsed = typeof event.startedAt === "string"
    ? Date.parse(event.startedAt)
    : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** An unknown kind changes nothing, so newer servers never break it. */
export function runReducer(state: RunState, action: RunAction): RunState {
  if (action.kind === "begin") {
    return { ...IDLE_RUN, status: "running", startedAt: action.at };
  }
  if (action.kind === "failed") {
    const at = runClock(state, action.at);
    return withLog(
      { ...state, status: "failed", endedAt: at, error: action.error },
      { at, kind: "error", text: action.error, tone: "bad" },
    );
  }
  const stamp = stampOf(action.event);
  if (stamp === undefined) {
    return foldEvent(state, runClock(state, action.at), action.event);
  }
  // arrival minus emission is the skew plus latency, so the smallest is best
  const seen = action.at - stamp;
  const offset = state.clockOffsetMs === undefined ||
      seen < state.clockOffsetMs
    ? seen
    : state.clockOffsetMs;
  const timed = offset === state.clockOffsetMs
    ? state
    : { ...state, clockOffsetMs: offset };
  return foldEvent(timed, stamp, action.event);
}

function foldEvent(
  state: RunState,
  at: number,
  event: RunStreamEvent,
): RunState {
  switch (event.kind) {
    case "attached":
      return withLog(
        {
          ...state,
          runId: event.runId,
          startedAt: Date.parse(event.startedAt) || state.startedAt,
        },
        { at, kind: "attached", text: `run ${event.runId}`, tone: "info" },
      );
    case "elsewhere": {
      const text =
        `the run is on instance ${event.instanceId}; attach to that instance to follow it`;
      return withLog({ ...state, error: text }, {
        at,
        kind: event.kind,
        text,
        tone: "info",
      });
    }
    case "interrupted": {
      const text = `instance ${event.instanceId} stopped before the run ended`;
      return withLog(
        { ...state, status: "failed", endedAt: at, error: text },
        { at, kind: event.kind, text, tone: "bad" },
      );
    }
    case "started":
      if (event.parentRunId !== undefined) return state;
      // the run's own start, on the clock its other events use; a run
      // continued after a serve restart sends started again
      return withLog(
        {
          ...state,
          runId: event.runId,
          startedAt: recordedStart(event) ??
            (state.runId === event.runId ? state.startedAt : undefined) ?? at,
        },
        { at, kind: "started", text: `run ${event.runId}`, tone: "info" },
      );
    case "job_started":
      return withLog(
        updateJob(state, event.jobId, (job) => ({
          ...job,
          status: "running",
          startedAt: recordedStart(event) ?? at,
        })),
        { at, kind: "job", text: `${event.jobId} started`, tone: "info" },
      );
    case "job_completed":
      return withLog(
        updateJob(state, event.jobId, (job) => ({
          ...job,
          status: jobStatus(event.status),
          endedAt: at,
        })),
        {
          at,
          kind: "job",
          text: `${event.jobId} ${event.status}`,
          tone: event.status === "succeeded" ? "good" : "bad",
        },
      );
    case "job_skipped":
      return withLog(
        updateJob(state, event.jobId, (job) => ({
          ...job,
          status: "skipped",
          endedAt: at,
        })),
        { at, kind: "job", text: `${event.jobId} skipped`, tone: "muted" },
      );
    case "step_started": {
      const template = (event as { forEachTemplate?: string })
        .forEachTemplate;
      return withLog(
        updateStep(state, event.jobId, event.stepId, (step) => ({
          ...step,
          ...(template ? { template } : {}),
          status: "running",
          startedAt: recordedStart(event) ?? at,
        })),
        {
          at,
          kind: "step",
          text: `${event.jobId} › ${event.stepId} started`,
          tone: "info",
        },
      );
    }
    case "step_completed":
      return withLog(
        updateStep(state, event.jobId, event.stepId, (step) => ({
          ...step,
          status: "succeeded",
          endedAt: at,
        })),
        {
          at,
          kind: "step",
          text: `${event.jobId} › ${event.stepId} succeeded`,
          tone: "good",
        },
      );
    case "step_failed":
      return withLog(
        updateStep(state, event.jobId, event.stepId, (step) => ({
          ...step,
          status: "failed",
          endedAt: at,
          error: event.error,
        })),
        {
          at,
          kind: "step",
          text: `${event.jobId} › ${event.stepId} failed: ${event.error}`,
          tone: "bad",
        },
      );
    case "step_skipped":
      return withLog(
        updateStep(state, event.jobId, event.stepId, (step) => ({
          ...step,
          status: "skipped",
          endedAt: at,
        })),
        {
          at,
          kind: "step",
          text: `${event.jobId} › ${event.stepId} skipped`,
          tone: "muted",
        },
      );
    case "method_output": {
      // a method run has no jobs, so its output is filed under the method
      const jobId = "jobId" in event ? event.jobId : "method";
      const stepId = "stepId" in event ? event.stepId : event.methodName;
      const next = updateStep(state, jobId, stepId, (step) => ({
        ...step,
        output: [...step.output, event.line].slice(-MAX_OUTPUT_LINES),
      }));
      return withLog(next, {
        at,
        kind: event.stream,
        text: `${stepId}: ${event.line}`,
        tone: event.stream === "stderr" ? "bad" : "muted",
      });
    }
    case "completed":
    case "cancelled": {
      const status: RunStatus = event.kind === "cancelled"
        ? "cancelled"
        : event.run.status === "succeeded"
        ? "succeeded"
        : "failed";
      return withLog({ ...state, status, endedAt: at }, {
        at,
        kind: event.kind,
        text: `run ${status}`,
        tone: status === "succeeded" ? "good" : "bad",
      });
    }
    case "suspended":
      return withLog({ ...state, status: "pending", endedAt: at }, {
        at,
        kind: "suspended",
        text: "run is waiting at a gate",
        tone: "info",
      });
    case "error":
      return withLog(
        { ...state, status: "failed", endedAt: at, error: event.error.message },
        { at, kind: "error", text: event.error.message, tone: "bad" },
      );
    default:
      return state;
  }
}
