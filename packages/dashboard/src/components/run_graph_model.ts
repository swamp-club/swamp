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

// The run graph's read model: a run's jobs as graph nodes with display
// statuses and step progress, and the workflow definition's `dependsOn` as
// edges, each knowing whether its condition was met. Pure, so the page and
// its tests read a run the same way.

/** A dependency condition, as `workflow.get` returns it. */
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

/** The parts of a `workflow.history.get` step the graph and panels read. */
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

/** The parts of a `workflow.get` definition the graph reads. */
export interface WorkflowDefinitionLike {
  jobs?: Array<{
    name: string;
    dependsOn?: Array<{ job: string; condition?: ConditionData }>;
    steps?: Array<{ name: string; task?: { type?: string } }>;
  }>;
}

/** What a node or step shows: one icon and color per value. */
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
  /** The status as the run records it. */
  rawStatus: string;
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  stepsTotal: number;
  /** Steps that reached an outcome (succeeded, failed or skipped). */
  stepsDone: number;
  /** The first step that failed the job, with its error. */
  failedStep?: { name: string; error?: string };
  /** Steps that failed but were allowed to. */
  allowedFailures: number;
  /** Why a waiting job waits. */
  waitingOn?: "approval" | "signal" | "nested";
  nested: NestedRunRef[];
}

export type EdgeState = "met" | "unmet" | "pending";

export interface RunGraphEdge {
  from: string;
  to: string;
  condition?: ConditionData;
  /**
   * Met/unmet once the upstream job finished; pending until then. Unmet
   * when the upstream job was cancelled.
   */
  state: EdgeState;
  /** Work is flowing along it now: met, into a running or waiting job. */
  active: boolean;
}

export interface RunGraph {
  jobs: RunGraphJob[];
  edges: RunGraphEdge[];
  /** False when the definition could not be read: no edges are known. */
  hasDependencies: boolean;
}

const FINISHED_RUN = new Set(["cancelled", "interrupted", "failed"]);

/** The display status of a job or step status within a run. */
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

/** True for a status that keeps the clock running. */
export function isLive(status: DisplayStatus): boolean {
  return status === "running" || status === "waiting";
}

/**
 * How long a job or step has taken: its recorded duration, or — while it
 * is still going — the time since it started.
 */
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

/**
 * Whether a dependency's condition holds for the upstream job's status.
 * Null while the upstream job has not finished.
 */
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

/** "succeeded", "failed or skipped", "not (succeeded)" — for edge titles. */
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
 * Builds the graph for a run. Nodes are the run's jobs in run order (the
 * run is the record of what happened); edges come from the definition and
 * are kept only between jobs the run has, since the definition may have
 * changed since the run started.
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

/** Step progress across the run: finished steps over all steps. */
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

/** The job and step that failed the run, for the failure summary. */
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

/** "3/5 steps", or the reason a job is not moving. */
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

/**
 * The failed step a failure link opens: the named step when the run has
 * it, else the first step that failed the run. Null when nothing failed.
 */
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
