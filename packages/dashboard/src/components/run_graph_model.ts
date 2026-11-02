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

export type ConditionData =
  | { type: "always" }
  | { type: "succeeded" }
  | { type: "failed" }
  | { type: "completed" }
  | { type: "skipped" }
  | { type: "and"; conditions: ConditionData[] }
  | { type: "or"; conditions: ConditionData[] }
  | { type: "not"; condition: ConditionData };

export interface ArtifactRefLike {
  dataId: string;
  name: string;
  version: number;
  tags?: Record<string, string>;
}

export interface StepRunLike {
  name: string;
  status: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  allowedFailure?: boolean;
  skipReason?: { kind: string; expression?: string };
  nestedRun?: { workflowName: string; runId: string; detached?: boolean };
  approval?: { status: string };
  wait?: unknown;
  dataArtifacts?: ArtifactRefLike[];
}

export interface JobRunLike {
  name: string;
  status: string;
  steps?: StepRunLike[];
  startedAt?: string;
  completedAt?: string;
  duration?: number;
}

export interface RunLike {
  status: string;
  jobs: JobRunLike[];
  nestedWaits?: { runId: string; stepName: string; status?: string }[];
}

export interface WorkflowDefinitionLike {
  jobs?: Array<{
    name: string;
    dependsOn?: Array<{ job: string; condition?: ConditionData }>;
    steps?: Array<{ name: string; task?: { type?: string } }>;
  }>;
}

export type DisplayStatus =
  | "succeeded"
  | "failed"
  | "running"
  | "waiting"
  | "pending"
  | "skipped"
  | "cancelled"
  | "unknown";

export interface NestedRunRef {
  stepName: string;
  workflowName: string;
  runId: string;
  status?: string;
}

export interface RunGraphJob {
  name: string;
  status: DisplayStatus;
  rawStatus: string;
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  stepsTotal: number;
  stepsDone: number;
  failedStep?: { name: string; error?: string };
  allowedFailures: number;
  waitingOn?: "approval" | "signal" | "nested";
  nested: NestedRunRef[];
}

export type EdgeState = "met" | "unmet" | "pending";

export interface RunGraphEdge {
  from: string;
  to: string;
  condition?: ConditionData;
  /**
   * met or unmet once the upstream job finished, pending until then; unmet when
   * the upstream job was cancelled
   */
  state: EdgeState;
  active: boolean;
}

export interface RunGraph {
  jobs: RunGraphJob[];
  edges: RunGraphEdge[];
  /** False when the definition could not be read: no edges are known. */
  hasDependencies: boolean;
}

const FINISHED_RUN = new Set(["cancelled", "interrupted", "failed"]);

export function displayStatus(
  status: string,
  runStatus?: string,
): DisplayStatus {
  // A finished run leaves work it never reached in its last state; show it
  // as stopped rather than forever pending or running.
  const stopped = runStatus !== undefined && FINISHED_RUN.has(runStatus);
  switch (status) {
    case "succeeded":
    case "failed":
    case "skipped":
    case "cancelled":
      return status;
    case "running":
      return stopped ? "cancelled" : "running";
    case "waiting_approval":
    case "waiting":
    case "waiting_signal":
      return stopped ? "cancelled" : "waiting";
    case "pending":
      return stopped ? "cancelled" : "pending";
    default:
      return "unknown";
  }
}

const FINISHED_STEP = new Set(["succeeded", "failed", "skipped"]);

export function isLive(status: DisplayStatus): boolean {
  return status === "running" || status === "waiting";
}

export function elapsed(
  item: { startedAt?: string; completedAt?: string; duration?: number },
  now: number,
  live: boolean,
): number | undefined {
  if (item.duration !== undefined) return item.duration;
  if (!item.startedAt) return undefined;
  const start = Date.parse(item.startedAt);
  if (Number.isNaN(start)) return undefined;
  if (item.completedAt) {
    const end = Date.parse(item.completedAt);
    return Number.isNaN(end) ? undefined : Math.max(0, end - start);
  }
  return live ? Math.max(0, now - start) : undefined;
}

export function evaluateCondition(
  condition: ConditionData | undefined,
  upstreamStatus: string,
): boolean | null {
  if (!FINISHED_STEP.has(upstreamStatus)) return null;
  return evaluate(condition ?? { type: "succeeded" }, upstreamStatus);
}

function evaluate(condition: ConditionData, status: string): boolean {
  switch (condition.type) {
    case "always":
      return true;
    case "succeeded":
      return status === "succeeded";
    case "failed":
      return status === "failed";
    case "completed":
      return status === "succeeded" || status === "failed";
    case "skipped":
      return status === "skipped";
    case "and":
      return condition.conditions.every((c) => evaluate(c, status));
    case "or":
      return condition.conditions.some((c) => evaluate(c, status));
    case "not":
      return !evaluate(condition.condition, status);
    default:
      return false;
  }
}

export function describeCondition(
  condition: ConditionData | undefined,
): string {
  if (!condition) return "succeeded";
  switch (condition.type) {
    case "and":
      return condition.conditions.map(wrap).join(" and ");
    case "or":
      return condition.conditions.map(wrap).join(" or ");
    case "not":
      return `not ${wrap(condition.condition)}`;
    default:
      return condition.type;
  }
}

function wrap(condition: ConditionData): string {
  const text = describeCondition(condition);
  return condition.type === "and" || condition.type === "or"
    ? `(${text})`
    : text;
}

function jobOf(job: JobRunLike, run: RunLike): RunGraphJob {
  const steps = job.steps ?? [];
  const status = displayStatus(job.status, run.status);
  const failed = steps.find((s) => s.status === "failed" && !s.allowedFailure);
  const nested: NestedRunRef[] = [];
  for (const step of steps) {
    if (!step.nestedRun) continue;
    const wait = run.nestedWaits?.find((w) =>
      w.runId === step.nestedRun!.runId
    );
    nested.push({
      stepName: step.name,
      workflowName: step.nestedRun.workflowName,
      runId: step.nestedRun.runId,
      ...(wait?.status ? { status: wait.status } : {}),
    });
  }
  let waitingOn: RunGraphJob["waitingOn"];
  if (status === "waiting") {
    const waiting = steps.find((s) =>
      s.status === "waiting_approval" || s.status === "waiting" ||
      s.status === "waiting_signal"
    );
    if (waiting?.nestedRun) waitingOn = "nested";
    else if (waiting?.status === "waiting_approval") waitingOn = "approval";
    else if (waiting) waitingOn = "signal";
  }
  return {
    name: job.name,
    status,
    rawStatus: job.status,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
    ...(job.duration !== undefined ? { duration: job.duration } : {}),
    stepsTotal: steps.length,
    stepsDone: steps.filter((s) => FINISHED_STEP.has(s.status)).length,
    ...(failed
      ? {
        failedStep: {
          name: failed.name,
          ...(failed.error ? { error: failed.error } : {}),
        },
      }
      : {}),
    allowedFailures:
      steps.filter((s) => s.status === "failed" && s.allowedFailure).length,
    ...(waitingOn ? { waitingOn } : {}),
    nested,
  };
}

/**
 * nodes are the run's jobs in run order; edges come from the definition and
 * only between jobs the run has, since the definition may have changed since
 * the run started
 */
export function buildRunGraph(
  run: RunLike,
  definition: WorkflowDefinitionLike | null,
): RunGraph {
  const jobs = run.jobs.map((job) => jobOf(job, run));
  const byName = new Map(run.jobs.map((j) => [j.name, j]));
  const edges: RunGraphEdge[] = [];
  for (const defJob of definition?.jobs ?? []) {
    const target = byName.get(defJob.name);
    if (!target) continue;
    const targetStatus = displayStatus(target.status, run.status);
    for (const dep of defJob.dependsOn ?? []) {
      const source = byName.get(dep.job);
      if (!source || dep.job === defJob.name) continue;
      // A cancelled job (or one a finished run left unfinished) will never
      // finish, so nothing downstream of it runs: its edges are unmet.
      const met = displayStatus(source.status, run.status) === "cancelled"
        ? false
        : evaluateCondition(dep.condition, source.status);
      const state: EdgeState = met === null ? "pending" : met ? "met" : "unmet";
      edges.push({
        from: dep.job,
        to: defJob.name,
        ...(dep.condition ? { condition: dep.condition } : {}),
        state,
        active: state === "met" && isLive(targetStatus),
      });
    }
  }
  return {
    jobs,
    edges,
    hasDependencies: definition !== null && Array.isArray(definition.jobs),
  };
}

export function stepProgress(run: RunLike): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const job of run.jobs) {
    for (const step of job.steps ?? []) {
      total++;
      if (FINISHED_STEP.has(step.status)) done++;
    }
  }
  return { done, total };
}

export function firstFailure(
  run: RunLike,
): { job: string; step: string; error?: string } | null {
  for (const job of run.jobs) {
    for (const step of job.steps ?? []) {
      if (step.status === "failed" && !step.allowedFailure) {
        return {
          job: job.name,
          step: step.name,
          ...(step.error ? { error: step.error } : {}),
        };
      }
    }
  }
  return null;
}

export function jobSummary(job: RunGraphJob): string {
  if (job.status === "skipped") return "Skipped";
  if (job.status === "cancelled") return "Did not finish";
  if (job.status === "waiting") {
    switch (job.waitingOn) {
      case "approval":
        return "Waiting for approval";
      case "signal":
        return "Waiting for a signal";
      case "nested":
        return "Waiting on a nested run";
      default:
        return "Waiting";
    }
  }
  if (job.status === "pending") return "Queued";
  if (job.stepsTotal === 0) return "No steps";
  return `${job.stepsDone}/${job.stepsTotal} ${
    job.stepsTotal === 1 ? "step" : "steps"
  }`;
}

export function failureTarget(
  run: RunLike,
  stepName?: string | null,
): { job: string; step: string } | null {
  if (stepName) {
    for (const job of run.jobs) {
      if ((job.steps ?? []).some((s) => s.name === stepName)) {
        return { job: job.name, step: stepName };
      }
    }
  }
  const first = firstFailure(run);
  return first ? { job: first.job, step: first.step } : null;
}
