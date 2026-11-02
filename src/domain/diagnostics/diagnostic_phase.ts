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
import {
  type ExecutionObservation,
  type ObservationAttributes,
  type ObservationOutcome,
  observationOutcome,
  observeExecution,
} from "../remote/observability.ts";

/**
 * a closed vocabulary: it is the swamp.diagnostic.area attribute, never a
 * dynamic span name
 */
export const DIAGNOSTIC_AREAS = [
  "enrollment",
  "step_outputs",
  "worker_delete",
  "output_retention",
  "access_poll",
  "output_search",
] as const;
export type DiagnosticArea = typeof DIAGNOSTIC_AREAS[number];

const SHARED_PHASES = [
  "definition_lookup",
  "definition_scan",
  "lock_wait",
  "lock_held",
  "gate_wait",
] as const;

/**
 * a phase started in an area that does not list it stays silent, so an area
 * carried by accident into unrelated work cannot mislabel it
 */
const AREA_PHASES = {
  enrollment: [
    "prepare",
    "type_resolution",
    "registry_load",
    "token_record_scan",
    "definition_adopt",
    "definition_save",
  ],
  step_outputs: ["catalog_open", "output_walk", "owner_index"],
  worker_delete: [
    "prune_pass",
    "worker_listing",
    "eligibility",
    "delete_loop",
    "binding_cleanup",
    "model_delete",
    "definition_resolve",
    "workflow_reference_check",
    "data_discovery",
    "expiry_check",
    "output_discovery",
    "output_removal",
    "data_removal",
    "evaluated_removal",
    "definition_removal",
  ],
  output_retention: [
    "retention_batch",
    "candidate_enumeration",
    "candidate_scan",
    "orphan_log_sweep",
    "summary_compaction",
    "batch_commit",
  ],
  access_poll: [
    "poll_cycle",
    "change_detection",
    "remote_pull",
    "catalog_invalidate",
    "snapshot_queue_wait",
    "snapshot_build",
  ],
  output_search: [
    "candidate_scan",
    "candidate_authorization",
    "definition_names",
    "workflow_names",
    "authorization",
    "response",
  ],
} as const satisfies Record<DiagnosticArea, readonly string[]>;

export type DiagnosticPhase =
  | typeof SHARED_PHASES[number]
  | typeof AREA_PHASES[DiagnosticArea][number];

const sharedPhases: ReadonlySet<string> = new Set(SHARED_PHASES);
const areaPhases = new Map<DiagnosticArea, ReadonlySet<string>>(
  DIAGNOSTIC_AREAS.map((area) => [area, new Set(AREA_PHASES[area])]),
);

function exportsPhase(area: DiagnosticArea, phase: DiagnosticPhase): boolean {
  return sharedPhases.has(phase) || areaPhases.get(area)!.has(phase);
}

interface TallyFrame {
  readonly tally: PhaseTally;
  nested: number;
  readonly outer: TallyFrame | undefined;
}

const tallyFrames = new AsyncLocalStorage<TallyFrame>();

/**
 * work is summed across items, so it is not elapsed time; a nested measurement
 * is excluded from its outer one, so concurrent ones can understate it, never
 * make it negative
 */
export class PhaseTally {
  readonly #counts = new Map<string, number>();
  readonly #work = new Map<string, number>();

  constructor(readonly recording: boolean) {}

  add(key: string, amount = 1): void {
    if (!this.recording) return;
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + amount);
  }

  async measure<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.recording) return await fn();
    const { frame, finish } = this.#begin(key);
    try {
      return await tallyFrames.run(frame, fn);
    } finally {
      finish();
    }
  }

  measureSync<T>(key: string, fn: () => T): T {
    if (!this.recording) return fn();
    const { frame, finish } = this.#begin(key);
    try {
      return tallyFrames.run(frame, fn);
    } finally {
      finish();
    }
  }

  #begin(key: string): { frame: TallyFrame; finish: () => void } {
    // The innermost measurement of this tally in the current async path, so
    // concurrent measurements never take each other for their parent.
    const outer = tallyFrames.getStore();
    let parent = outer;
    while (parent && parent.tally !== this) parent = parent.outer;
    const frame: TallyFrame = { tally: this, nested: 0, outer };
    const started = performance.now();
    const finish = () => {
      const elapsed = performance.now() - started;
      if (parent) parent.nested += elapsed;
      this.#work.set(
        key,
        (this.#work.get(key) ?? 0) + Math.max(0, elapsed - frame.nested),
      );
    };
    return { frame, finish };
  }

  merge(other: PhaseTally): void {
    if (!this.recording) return;
    for (const [key, count] of other.#counts) this.add(key, count);
    for (const [key, ms] of other.#work) {
      this.#work.set(key, (this.#work.get(key) ?? 0) + ms);
    }
  }

  attributes(): Record<string, number> {
    const values: Record<string, number> = {};
    for (const [key, count] of this.#counts) {
      values[`swamp.diagnostic.${key}`] = count;
    }
    for (const [key, ms] of this.#work) {
      values[`swamp.diagnostic.${key}_work_ms`] = ms;
    }
    return values;
  }
}

/**
 * swamp.outcome says only whether a phase raised; a poll that found nothing to
 * apply still ends ok
 */
export type DiagnosticResult =
  | "completed"
  | "partial"
  | "applied"
  | "no_change"
  | "skipped";

export interface DiagnosticPhaseHandle {
  readonly recording: boolean;
  readonly tally: PhaseTally;
  attributes(values: ObservationAttributes): void;
  result(value: DiagnosticResult): void;
  run<T>(fn: () => T): T;
  end(outcome?: ObservationOutcome): void;
  fail(error: unknown): void;
}

interface DiagnosticScope {
  readonly area: DiagnosticArea;
  readonly tally?: PhaseTally;
  readonly attributes?: ObservationAttributes;
  readonly signal?: AbortSignal;
}

const scope = new AsyncLocalStorage<DiagnosticScope>();
const silentTally = new PhaseTally(false);
const silentPhase: DiagnosticPhaseHandle = {
  recording: false,
  tally: silentTally,
  attributes: () => {},
  result: () => {},
  run: (fn) => fn(),
  end: () => {},
  fail: () => {},
};

export function currentDiagnosticArea(): DiagnosticArea | undefined {
  return scope.getStore()?.area;
}

/**
 * lets an existing span (a sync gate wait) be selected with the phases instead
 * of duplicating it; empty outside any area
 */
export function diagnosticSpanAttributes(
  phase: DiagnosticPhase,
): ObservationAttributes {
  const current = scope.getStore();
  if (!current || !exportsPhase(current.area, phase)) return {};
  return {
    ...current.attributes,
    "swamp.diagnostic.area": current.area,
    "swamp.diagnostic.phase": phase,
  };
}

export function currentDiagnosticTally(): PhaseTally {
  return scope.getStore()?.tally ?? silentTally;
}

export function withDiagnosticTally<T>(
  area: DiagnosticArea,
  tally: PhaseTally,
  fn: () => T,
): T {
  return scope.run({ area, tally }, fn);
}

/**
 * AsyncLocalStorage carries the area into every timer, callback and task fn
 * starts, so wrap only the awaited work being measured, never a call that
 * starts background work
 */
export function withDiagnosticArea<T>(
  area: DiagnosticArea,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return scope.run({ area, signal }, fn);
}

export function outsideDiagnosticArea<T>(fn: () => T): T {
  return scope.exit(fn);
}

export function withDiagnosticAttributes<T>(
  attributes: ObservationAttributes,
  fn: () => Promise<T>,
): Promise<T> {
  const store = scope.getStore();
  if (!store) return fn();
  return scope.run({
    ...store,
    attributes: { ...store.attributes, ...attributes },
  }, fn);
}

/**
 * a generator body runs in the context of whoever advances it, so each next()
 * is run inside the area; the consumer's code between steps is not
 */
export function bindGeneratorToDiagnosticArea<T, TReturn>(
  area: DiagnosticArea,
  generator: AsyncGenerator<T, TReturn>,
  signal?: AbortSignal,
): AsyncGenerator<T, TReturn> {
  const store = { area, signal };
  return runEachStep((step) => scope.run(store, step), generator);
}

/**
 * Advances `source` only inside `within`, including the `return()` that runs
 * its `finally` blocks when the consumer stops early.
 */
async function* runEachStep<T, TReturn>(
  within: <R>(step: () => R) => R,
  source: AsyncIterable<T, TReturn>,
): AsyncGenerator<T, TReturn> {
  const iterator = source[Symbol.asyncIterator]();
  let done = false;
  try {
    while (true) {
      let result: IteratorResult<T, TReturn>;
      try {
        result = await within(() => iterator.next());
      } catch (error) {
        done = true;
        throw error;
      }
      if (result.done) {
        done = true;
        return result.value;
      }
      yield result.value;
    }
  } finally {
    if (!done) await within(() => iterator.return?.());
  }
}

export function startDiagnosticPhase(
  phase: DiagnosticPhase,
  attributes: ObservationAttributes = {},
): DiagnosticPhaseHandle {
  const current = scope.getStore();
  if (!current || !exportsPhase(current.area, phase)) return silentPhase;
  // Telemetry never fails the work it observes: a phase that cannot be
  // started or exported is dropped, so the caller's result, error and
  // cleanup (a lock release) are never replaced by a telemetry error.
  let observation: ExecutionObservation;
  try {
    observation = observeExecution(
      `diagnostic.${phase}`,
      {
        ...current.attributes,
        "swamp.diagnostic.area": current.area,
        "swamp.diagnostic.phase": phase,
        ...attributes,
      },
    );
  } catch {
    return silentPhase;
  }
  const recording = observation.recording ?? false;
  const tally = recording ? new PhaseTally(true) : silentTally;
  const store = { ...current, tally };
  let ended = false;
  const quietly = (fn: () => void) => {
    try {
      fn();
    } catch {
      // Dropped: see above.
    }
  };
  const end = (outcome: ObservationOutcome = "ok") => {
    if (ended) return;
    ended = true;
    quietly(() => {
      if (recording) {
        observation.attributes(tally.attributes());
        if (current.signal) {
          observation.attributes({
            "swamp.diagnostic.cancel_observed": current.signal.aborted,
          });
        }
      }
      observation.end(outcome);
    });
  };
  return {
    recording,
    tally,
    attributes: (values) => {
      if (recording) quietly(() => observation.attributes(values));
    },
    result: (value) => {
      if (recording) {
        quietly(() =>
          observation.attributes({ "swamp.diagnostic.result": value })
        );
      }
    },
    run: (fn) => scope.run(store, () => observation.run(fn)),
    end,
    fail: (error) => end(observationOutcome(error)),
  };
}

export async function observeDiagnosticPhase<T>(
  phase: DiagnosticPhase,
  attributes: ObservationAttributes,
  fn: (phase: DiagnosticPhaseHandle) => Promise<T>,
): Promise<T> {
  const handle = startDiagnosticPhase(phase, attributes);
  try {
    const result = await handle.run(() => fn(handle));
    handle.end();
    return result;
  } catch (error) {
    handle.fail(error);
    throw error;
  }
}

export async function* withGeneratorDiagnosticPhase<T, TReturn>(
  phase: DiagnosticPhase,
  attributes: ObservationAttributes,
  make: (phase: DiagnosticPhaseHandle) => AsyncGenerator<T, TReturn>,
): AsyncGenerator<T, TReturn> {
  const handle = startDiagnosticPhase(phase, attributes);
  let outcome: ObservationOutcome = "cancelled";
  try {
    const result = yield* runEachStep(handle.run, make(handle));
    outcome = "ok";
    return result;
  } catch (error) {
    outcome = observationOutcome(error);
    throw error;
  } finally {
    handle.end(outcome);
  }
}

export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 && code < 0xdc00 &&
      (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
