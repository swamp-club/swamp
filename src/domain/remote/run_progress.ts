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

import { AsyncLocalStorage } from "node:async_hooks";

/** Diagnostic state only: never consulted for scheduling or lock ownership. */
export type RunPhase =
  | "queued"
  | "waiting_for_lock"
  | "waiting_for_worker"
  | "executing"
  | "finalizing"
  | "persisting";

let recordPhaseDuration:
  | ((phase: RunPhase, seconds: number) => void)
  | undefined;

export function setRunPhaseDurationRecorder(
  recorder: typeof recordPhaseDuration,
): void {
  recordPhaseDuration = recorder;
}

export interface RunProgressIdentity {
  readonly runId: string;
  readonly workflow?: string;
  readonly model?: string;
  readonly method?: string;
  readonly job?: string;
  readonly step?: string;
  readonly scope?: "run" | "step" | "method";
  readonly traceId?: string;
}

export interface RunPhaseDetails {
  readonly worker?: string;
  readonly resource?: string;
  readonly holderRunId?: string;
}

export interface RunProgressSnapshot
  extends RunProgressIdentity, RunPhaseDetails {
  readonly phase: RunPhase;
  readonly phaseElapsedMs: number;
  readonly lastProgressAt: string;
  readonly holderKnown?: boolean;
}

/** One execution of a step; parallel steps and resumed executions stay separate. */
export class RunProgress {
  #closed = false;
  readonly #phases: Array<
    { phase: RunPhase; at: number; details: RunPhaseDetails }
  >;
  #lastProgressAt: string;
  constructor(
    readonly identity: RunProgressIdentity,
    private readonly now: () => number = () => performance.now(),
    private readonly wallNow: () => string = () => new Date().toISOString(),
  ) {
    this.#phases = [{ phase: "queued", at: now(), details: {} }];
    this.#lastProgressAt = wallNow();
  }

  enter(phase: RunPhase, details: RunPhaseDetails = {}): () => void {
    if (this.#closed) return () => {};
    this.#recordCurrent();
    const entry = { phase, at: this.now(), details };
    this.#phases.push(entry);
    this.#lastProgressAt = this.wallNow();
    let ended = false;
    return () => {
      if (ended || this.#closed) return;
      ended = true;
      const index = this.#phases.indexOf(entry);
      const wasCurrent = index === this.#phases.length - 1;
      if (wasCurrent) this.#recordCurrent();
      this.#phases.splice(index, 1);
      if (wasCurrent) this.#phases.at(-1)!.at = this.now();
      this.#lastProgressAt = this.wallNow();
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#recordCurrent();
    this.#closed = true;
  }

  progressed(): void {
    if (!this.#closed) this.#lastProgressAt = this.wallNow();
  }

  #recordCurrent(): void {
    // Step residence histograms must not also count the enclosing workflow.
    if (this.identity.scope === "run" || this.identity.scope === "method") {
      return;
    }
    const current = this.#phases.at(-1)!;
    // A diagnostic exporter must not turn a phase transition into a run failure.
    try {
      recordPhaseDuration?.(
        current.phase,
        Math.max(0, this.now() - current.at) / 1000,
      );
    } catch { /* Observation only. */ }
  }

  snapshot(): RunProgressSnapshot {
    const current = this.#phases.at(-1)!;
    return {
      ...this.identity,
      ...current.details,
      phase: current.phase,
      phaseElapsedMs: Math.max(0, this.now() - current.at),
      lastProgressAt: this.#lastProgressAt,
      ...(current.phase === "waiting_for_lock"
        ? { holderKnown: current.details.holderRunId !== undefined }
        : {}),
    };
  }
}

const active = new Set<RunProgress>();
export interface TrackedRunObservation {
  readonly runId: string;
  readonly kind: "workflow" | "model_method";
}

const trackedRunSources = new Set<() => readonly TrackedRunObservation[]>();

/** Adapters supply authoritative running rows owned by this process. */
export function registerTrackedRunSource(
  source: () => readonly TrackedRunObservation[],
): () => void {
  trackedRunSources.add(source);
  return () => {
    trackedRunSources.delete(source);
  };
}

export function trackedRunCounts(): {
  workflow: number;
  model_method: number;
  unavailableSources: number;
} {
  const runs = new Map<string, TrackedRunObservation>();
  let unavailableSources = 0;
  for (const source of trackedRunSources) {
    try {
      for (const run of source()) runs.set(run.runId, run);
    } catch {
      unavailableSources++;
    }
  }
  let workflow = 0;
  let model_method = 0;
  for (const run of runs.values()) {
    if (run.kind === "workflow") workflow++;
    else model_method++;
  }
  return { workflow, model_method, unavailableSources };
}

/** A trigger receipt waiting for admission is distinct from a workflow run. */
export interface WebhookAdmissionSnapshot {
  readonly receiptId: string;
  readonly workflow: string;
  readonly phase: "queued" | "starting" | "executing";
  readonly phaseElapsedMs: number;
  readonly enqueuedAt: string;
  readonly lastProgressAt: string;
  readonly traceId?: string;
  readonly runId?: string;
  readonly blockingRunIds: readonly string[];
  readonly unknownBlockers: number;
}

const scope = new AsyncLocalStorage<RunProgress>();

export function registerRunProgress(
  identity: RunProgressIdentity,
): RunProgress {
  const progress = new RunProgress(identity);
  active.add(progress);
  return progress;
}

export function removeRunProgress(progress: RunProgress): void {
  progress.close();
  active.delete(progress);
}

/** Process-local snapshots. Callers must authorize the run before disclosing it. */
export function runProgressSnapshots(runId?: string): RunProgressSnapshot[] {
  return [...active].filter((p) =>
    runId === undefined || p.identity.runId === runId
  )
    .map((p) => p.snapshot());
}

export function currentRunProgress(): RunProgress | undefined {
  return scope.getStore();
}

export async function withRunProgress<T>(
  progress: RunProgress,
  work: () => Promise<T>,
): Promise<T> {
  return await scope.run(progress, work);
}

/** Observe the root workflow from its first started event through generator cleanup. */
export async function* trackWorkflowProgress<
  T extends {
    kind: string;
    runId?: string;
    workflowName?: string;
    parentRunId?: string;
  },
>(generator: AsyncGenerator<T>, traceId?: string): AsyncGenerator<T> {
  let progress: RunProgress | undefined;
  let done = false;
  try {
    while (true) {
      const result = await (progress
        ? scope.run(progress, () =>
          generator.next())
        : generator.next());
      if (result.done) {
        done = true;
        return;
      }
      const event = result.value;
      if (
        !progress && event.kind === "started" && event.runId &&
        event.workflowName
      ) {
        progress = registerRunProgress({
          runId: event.runId,
          workflow: event.workflowName,
          scope: "run",
          traceId,
        });
        progress.enter("executing");
      }
      progress?.progressed();
      yield event;
    }
  } finally {
    try {
      if (!done) {
        progress?.enter("finalizing");
        if (progress) {
          await scope.run(progress, () => generator.return(undefined));
        } else await generator.return(undefined);
      }
    } finally {
      if (progress) removeRunProgress(progress);
    }
  }
}

/** Bind each generator advance, including cleanup, without leaking to its consumer. */
export async function* bindRunProgress<T>(
  progress: RunProgress,
  generator: AsyncGenerator<T>,
): AsyncGenerator<T> {
  let done = false;
  try {
    while (true) {
      const result = await scope.run(progress, () => generator.next());
      if (result.done) {
        done = true;
        return;
      }
      yield result.value;
    }
  } finally {
    if (!done) await scope.run(progress, () => generator.return(undefined));
  }
}

export async function withRunPhase<T>(
  phase: RunPhase,
  details: RunPhaseDetails,
  work: () => Promise<T>,
): Promise<T> {
  const leave = currentRunProgress()?.enter(phase, details);
  try {
    return await work();
  } finally {
    leave?.();
  }
}
