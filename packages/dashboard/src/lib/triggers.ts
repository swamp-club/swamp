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

// Pure view logic for the Schedules and Webhooks pages: run aggregation by
// trigger, how a webhook names its workflow, what a failed change says,
// inputs JSON validation and the side-by-side run comparison.

import { formatAbsoluteTime, formatDuration } from "./format.ts";
import { fuzzyFilter } from "./fuzzy.ts";

// The shapes of `workflow.run.summary` (src/client/run_summary.ts), kept
// here structurally so this module stays free of the request hooks and can
// be tested on its own.

export interface RecentRun {
  runId: string;
  status: string;
  startedAt?: string;
  duration?: number;
  triggerSource?: string;
}

export interface RunCounts {
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  running: number;
  suspended: number;
  durationMs: number;
}

export interface WorkflowRunSummary extends RunCounts {
  workflowId: string;
  workflowName: string;
  lastStartedAt?: string;
  /** Newest first. */
  recent: RecentRun[];
}

/** A run as `workflow.run.search` returns it. */
export interface TriggerRun {
  runId: string;
  workflowId?: string;
  workflowName: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  triggerSource?: string;
  inputs?: Record<string, unknown>;
  failedStep?: string;
  failureReason?: string;
  stepProgress?: { completed: number; total: number };
}

const EMPTY_COUNTS: RunCounts = {
  runs: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  running: 0,
  suspended: 0,
  durationMs: 0,
};

const FINISHED = new Set(["succeeded", "failed", "cancelled"]);

type StatusBucket =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "running"
  | "suspended";

/**
 * The count a run status lands in, as serve's run summary buckets it:
 * `interrupted` counts as failed and `pending` as running. Undefined for a
 * status this dashboard does not know.
 */
export function runStatusBucket(status: string): StatusBucket | undefined {
  switch (status) {
    case "succeeded":
    case "cancelled":
    case "suspended":
    case "failed":
    case "running":
      return status;
    case "interrupted":
      return "failed";
    case "pending":
      return "running";
    default:
      return undefined;
  }
}

function startedMs(run: { startedAt?: string }): number {
  const t = run.startedAt ? Date.parse(run.startedAt) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Runs of one trigger, newest first, of exactly the named workflows. Serve
 * filters by trigger and name itself; this keeps a server that ignores
 * those filters (or matches names by substring) from mixing in others.
 */
export function runsOfTrigger(
  runs: readonly TriggerRun[],
  triggerSource: string,
  workflowNames?: readonly string[],
): TriggerRun[] {
  const names = workflowNames ? new Set(workflowNames) : null;
  return runs
    .filter((r) =>
      r.triggerSource === triggerSource &&
      (names === null || names.has(r.workflowName))
    )
    .sort((a, b) => startedMs(b) - startedMs(a));
}

/**
 * `since` as the duration an older serve's run search takes ("36h"),
 * rounded up to whole hours so the window never shrinks. Undefined for an
 * open-ended range.
 */
export function legacySince(
  since: string | undefined,
  now: number,
): string | undefined {
  if (!since) return undefined;
  const t = Date.parse(since);
  if (Number.isNaN(t)) return undefined;
  return `${Math.max(1, Math.ceil((now - t) / 3_600_000))}h`;
}

/** Runs that started inside the bounds (either end may be open). */
export function runsWithin<T extends { startedAt?: string }>(
  runs: readonly T[],
  bounds: { since?: string; until?: string },
): T[] {
  const lo = bounds.since ? Date.parse(bounds.since) : -Infinity;
  const hi = bounds.until ? Date.parse(bounds.until) : Infinity;
  return runs.filter((r) => {
    if (!r.startedAt) return true;
    const t = Date.parse(r.startedAt);
    return Number.isNaN(t) || (t >= lo && t <= hi);
  });
}

/**
 * Per-workflow counts and recent runs built from a run search — what
 * `workflow.run.summary` returns, for a serve that predates it.
 */
export function summarizeRuns(
  runs: readonly TriggerRun[],
  recentLimit = 20,
): WorkflowRunSummary[] {
  const byName = new Map<string, WorkflowRunSummary>();
  const sorted = [...runs].sort((a, b) => startedMs(b) - startedMs(a));
  for (const run of sorted) {
    let s = byName.get(run.workflowName);
    if (!s) {
      s = {
        ...EMPTY_COUNTS,
        workflowId: run.workflowId ?? run.workflowName,
        workflowName: run.workflowName,
        lastStartedAt: run.startedAt,
        recent: [],
      };
      byName.set(run.workflowName, s);
    }
    s.runs++;
    const bucket = runStatusBucket(run.status);
    if (bucket) s[bucket]++;
    if (bucket && FINISHED.has(bucket) && run.duration !== undefined) {
      s.durationMs += run.duration;
    }
    if (s.recent.length < recentLimit) {
      const recent: RecentRun = { runId: run.runId, status: run.status };
      if (run.startedAt) recent.startedAt = run.startedAt;
      if (run.duration !== undefined) recent.duration = run.duration;
      if (run.triggerSource) recent.triggerSource = run.triggerSource;
      s.recent.push(recent);
    }
  }
  return [...byName.values()];
}

/** Counts summed over the given workflow summaries. */
export function sumCounts(summaries: Iterable<RunCounts>): RunCounts {
  const total = { ...EMPTY_COUNTS };
  for (const s of summaries) {
    total.runs += s.runs;
    total.succeeded += s.succeeded;
    total.failed += s.failed;
    total.cancelled += s.cancelled;
    total.running += s.running;
    total.suspended += s.suspended;
    total.durationMs += s.durationMs;
  }
  return total;
}

/** Mean duration of finished runs, or undefined when none finished. */
export function averageDuration(counts: RunCounts): number | undefined {
  const finished = counts.succeeded + counts.failed + counts.cancelled;
  return finished > 0 ? counts.durationMs / finished : undefined;
}

/** "92%" of finished runs that succeeded, or "—" when none finished. */
export function successRate(counts: RunCounts): string {
  const finished = counts.succeeded + counts.failed + counts.cancelled;
  if (finished === 0) return "—";
  return `${Math.round((counts.succeeded / finished) * 100)}%`;
}

// ── Webhooks ────────────────────────────────────────────────────────────

export interface WebhookEntry {
  route: string;
  /** The configured workflow id or name. */
  workflow: string;
  /** Signature verification scheme, on servers that report it. */
  scheme?: string;
}

/**
 * The workflow name a webhook's configured reference names: the name
 * itself, or the name of the workflow whose id it is. Unknown references
 * are returned as configured.
 */
export function webhookWorkflowName(
  ref: string,
  workflows: ReadonlyArray<{ id: string; name: string }>,
): string {
  if (workflows.some((w) => w.name === ref)) return ref;
  return workflows.find((w) => w.id === ref)?.name ?? ref;
}

/** Every route pointing at each workflow, sorted. */
export function routesByWorkflow(
  webhooks: ReadonlyArray<{ route: string; workflowName: string }>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const w of webhooks) {
    const routes = map.get(w.workflowName) ?? [];
    routes.push(w.route);
    map.set(w.workflowName, routes.sort());
  }
  return map;
}

/** Fuzzy filter over a webhook's route and workflow. */
export function filterWebhooks<
  T extends { route: string; workflowName: string },
>(
  webhooks: readonly T[],
  query: string,
): T[] {
  return fuzzyFilter(webhooks, query, (w) => [w.route, w.workflowName]);
}

// ── Schedule changes ────────────────────────────────────────────────────

const DENIED_CODES: ReadonlySet<string> = new Set([
  "unauthorized",
  "forbidden",
  "access_not_configured",
]);

/** True for serve's refusal codes (no access, or no policy configured). */
export function isDeniedCode(code: string | undefined): boolean {
  return code !== undefined && DENIED_CODES.has(code);
}

export type ScheduleAction = "pause" | "resume" | "save" | "reset";

/** The message beside a schedule's controls after a change. */
export interface ScheduleFeedback {
  tone: "success" | "danger";
  text: string;
}

const ACTION_TEXT: Record<ScheduleAction, string> = {
  pause: "pause",
  resume: "resume",
  save: "change",
  reset: "reset",
};

/**
 * What to say when a schedule change failed: a permission refusal reads as
 * one, anything else keeps serve's own message.
 */
export function scheduleErrorMessage(
  action: ScheduleAction,
  workflowName: string,
  error: { code?: string; message: string },
): string {
  if (isDeniedCode(error.code)) {
    return `You don't have permission to ${
      ACTION_TEXT[action]
    } the schedule of ${workflowName}. Changing schedules needs write access to the workflow.`;
  }
  return `Couldn't ${ACTION_TEXT[action]} the schedule: ${error.message}`;
}

/** What to say once a schedule change landed. */
export function scheduleSuccessMessage(action: ScheduleAction): string {
  switch (action) {
    case "pause":
      return "Paused. No new scheduled runs will start.";
    case "resume":
      return "Resumed.";
    case "save":
      return "Schedule saved.";
    case "reset":
      return "Reset to the workflow file's schedule.";
  }
}

export type InputsParse =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/** Validates the editor's inputs JSON: empty means `{}`, else an object. */
export function parseInputsJson(text: string): InputsParse {
  if (text.trim() === "") return { ok: true, value: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Not valid JSON: ${detail}` };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      error: 'Inputs must be a JSON object, like {"region": "eu-west-1"}',
    };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/** Pretty JSON for the editor; `{}` reads as an empty box. */
export function formatInputsJson(inputs: Record<string, unknown>): string {
  return Object.keys(inputs).length === 0
    ? ""
    : JSON.stringify(inputs, null, 2);
}

export interface InputRow {
  key: string;
  effective?: unknown;
  builtIn?: unknown;
  override?: unknown;
  /** Where the effective value comes from. */
  origin: "override" | "workflow" | "none";
}

/** Effective vs workflow-file vs override value of every input key. */
export function inputRows(
  effective: Record<string, unknown> | undefined,
  builtIn: Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined,
): InputRow[] {
  const keys = new Set([
    ...Object.keys(effective ?? {}),
    ...Object.keys(builtIn ?? {}),
    ...Object.keys(override ?? {}),
  ]);
  return [...keys].sort().map((key) => {
    const has = (o: Record<string, unknown> | undefined) =>
      o !== undefined && Object.prototype.hasOwnProperty.call(o, key);
    return {
      key,
      ...(has(effective) && { effective: effective![key] }),
      ...(has(builtIn) && { builtIn: builtIn![key] }),
      ...(has(override) && { override: override![key] }),
      origin: has(override) ? "override" : has(builtIn) ? "workflow" : "none",
    };
  });
}

/** A value as one line of text: strings bare, everything else as JSON. */
export function valueText(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

// ── Run comparison ──────────────────────────────────────────────────────

export interface RunDetailStep {
  name: string;
  status: string;
  duration?: number;
  error?: string;
}

export interface RunDetailJob {
  name: string;
  status: string;
  steps: RunDetailStep[];
}

/** One side: the search item, plus the full run once fetched. */
export interface CompareSide {
  run: TriggerRun;
  jobs?: RunDetailJob[] | null;
}

export interface CompareRow {
  section: "Run" | "Inputs" | "Steps";
  label: string;
  a: string;
  b: string;
  /** Status cells render as pills. */
  kind?: "status";
  differs: boolean;
  /** B relative to A, for durations ("+1.2s"). */
  delta?: string;
}

function durationDelta(a?: number, b?: number): string | undefined {
  if (a === undefined || b === undefined) return undefined;
  const diff = b - a;
  if (diff === 0) return undefined;
  return `${diff > 0 ? "+" : "−"}${formatDuration(Math.abs(diff))}`;
}

function stepText(step: RunDetailStep | undefined): string {
  if (!step) return "—";
  return step.duration !== undefined
    ? `${step.status} · ${formatDuration(step.duration)}`
    : step.status;
}

/**
 * Rows comparing two runs. A row differs when what it says differs —
 * except times and durations, which always do; a duration row carries the
 * change instead.
 */
export function compareRuns(a: CompareSide, b: CompareSide): CompareRow[] {
  const rows: CompareRow[] = [];
  const run = (
    label: string,
    va: string,
    vb: string,
    extra: Partial<CompareRow> = {},
  ) =>
    rows.push({
      section: "Run",
      label,
      a: va,
      b: vb,
      differs: va !== vb,
      ...extra,
    });

  run("Status", a.run.status, b.run.status, { kind: "status" });
  run(
    "Duration",
    formatDuration(a.run.duration),
    formatDuration(b.run.duration),
    {
      differs: false,
      delta: durationDelta(a.run.duration, b.run.duration),
    },
  );
  run(
    "Started",
    a.run.startedAt ? formatAbsoluteTime(a.run.startedAt) : "—",
    b.run.startedAt ? formatAbsoluteTime(b.run.startedAt) : "—",
    { differs: false },
  );
  run("Trigger", a.run.triggerSource ?? "—", b.run.triggerSource ?? "—");
  if (a.run.failedStep || b.run.failedStep) {
    run("Failed step", a.run.failedStep ?? "—", b.run.failedStep ?? "—");
  }
  if (a.run.failureReason || b.run.failureReason) {
    run("Failure", a.run.failureReason ?? "—", b.run.failureReason ?? "—");
  }

  const ia = a.run.inputs ?? {};
  const ib = b.run.inputs ?? {};
  const inputKeys = [...new Set([...Object.keys(ia), ...Object.keys(ib)])]
    .sort();
  for (const key of inputKeys) {
    const va = valueText(ia[key]);
    const vb = valueText(ib[key]);
    rows.push({
      section: "Inputs",
      label: key,
      a: va,
      b: vb,
      differs: va !== vb,
    });
  }

  if (a.jobs || b.jobs) {
    const steps = new Map<string, { a?: RunDetailStep; b?: RunDetailStep }>();
    const add = (jobs: RunDetailJob[] | null | undefined, side: "a" | "b") => {
      for (const job of jobs ?? []) {
        for (const step of job.steps) {
          const key = `${job.name} › ${step.name}`;
          const entry = steps.get(key) ?? {};
          entry[side] = step;
          steps.set(key, entry);
        }
      }
    };
    add(a.jobs, "a");
    add(b.jobs, "b");
    for (const [label, pair] of steps) {
      rows.push({
        section: "Steps",
        label,
        a: stepText(pair.a),
        b: stepText(pair.b),
        differs: pair.a?.status !== pair.b?.status,
        delta: durationDelta(pair.a?.duration, pair.b?.duration),
      });
    }
  }
  return rows;
}

/**
 * The selection after toggling a run: at most two, and picking a third
 * drops the earliest pick so the latest two are compared.
 */
export function toggleCompare(
  selected: readonly string[],
  runId: string,
): string[] {
  if (selected.includes(runId)) return selected.filter((id) => id !== runId);
  return [...selected, runId].slice(-2);
}
