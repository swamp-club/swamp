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
 * The serve paths whose cost is broken into exported phases
 * (design/enablers/serve-phase-telemetry.md). A closed vocabulary: it is the
 * `swamp.diagnostic.area` attribute, never a dynamic span name.
 */
export const DIAGNOSTIC_AREAS = [
  "enrollment",
  "step_outputs",
  "worker_delete",
  "output_retention",
  "access_poll",
] as const;
export type DiagnosticArea = typeof DIAGNOSTIC_AREAS[number];

/** Phases of shared code that any area may run; the area tells them apart. */
const SHARED_PHASES = [
  "definition_lookup",
  "definition_scan",
  "lock_wait",
  "lock_held",
  "gate_wait",
] as const;

/**
 * The phases each area exports besides the shared ones. A phase started in an
 * area that does not list it stays silent, so an area carried by accident
 * into unrelated work cannot mislabel it. Areas with no phases yet export
 * only the shared ones.
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
  worker_delete: [],
  output_retention: [
    "retention_batch",
    "candidate_enumeration",
    "candidate_scan",
    "orphan_log_sweep",
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

/** A running {@link PhaseTally} measurement, and the one it runs inside. */
interface TallyFrame {
  readonly tally: PhaseTally;
  nested: number;
  readonly outer: TallyFrame | undefined;
}

const tallyFrames = new AsyncLocalStorage<TallyFrame>();

/**
 * Bounded counters and cumulative work for a phase that loops over items.
 * Counts export as `swamp.diagnostic.<key>`, work as
 * `swamp.diagnostic.<key>_work_ms`.
 *
 * Work is summed across items, so it is not elapsed time: measurements that
 * run concurrently (reads in parallel batches) each add their own time. A
 * measurement nested inside another in the same async path is exclusive:
 * the outer one excludes it. Concurrent measurements under one outer
 * measurement are all excluded from it, so its work can be understated, never
 * negative.
 *
 * A tally whose phase is not recording does nothing, so callers may gate
 * costly inputs (a byte count) on {@link PhaseTally.recording}.
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

  /** {@link measure} for synchronous work, such as a parse. */
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
 * What a phase achieved, beside `swamp.outcome` (which says only whether it
 * raised): a poll that found nothing to apply still ends `ok`.
 */
export type DiagnosticResult =
  | "completed"
  | "partial"
  | "applied"
  | "no_change"
  | "skipped";

/** A started phase. A phase started outside any area is a silent no-op. */
export interface DiagnosticPhaseHandle {
  readonly recording: boolean;
  readonly tally: PhaseTally;
  attributes(values: ObservationAttributes): void;
  result(value: DiagnosticResult): void;
  /** Runs `fn` as this phase: spans and tallies it starts are its children. */
  run<T>(fn: () => T): T;
  /** Exports the tally and ends the phase. Later calls do nothing. */
  end(outcome?: ObservationOutcome): void;
  /** Ends the phase with the outcome `error` classifies to. */
  fail(error: unknown): void;
}

interface DiagnosticScope {
  readonly area: DiagnosticArea;
  readonly tally?: PhaseTally;
  readonly attributes?: ObservationAttributes;
  /** The operation's cancellation, recorded on each phase as it ends. */
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

/** The area the current async context runs in, if any. */
export function currentDiagnosticArea(): DiagnosticArea | undefined {
  return scope.getStore()?.area;
}

/**
 * The area and phase attributes a span started outside this module carries
 * to count as `phase`: lets an existing span (a sync gate wait) be selected
 * with the phases instead of duplicating it. Empty outside any area.
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

/**
 * The tally of the innermost running phase, or a silent one. Lets code in
 * another layer, reached through a closure the phase passed down, measure
 * into that phase.
 */
export function currentDiagnosticTally(): PhaseTally {
  return scope.getStore()?.tally ?? silentTally;
}

/**
 * Runs `fn` in `area`, so phases it starts are exported. AsyncLocalStorage
 * carries the area into every timer, callback and task `fn` starts, so wrap
 * only the awaited work being measured, never a call that starts background
 * work.
 *
 * With `signal`, every phase in the area ends with
 * `swamp.diagnostic.cancel_observed`: whether this process had seen the
 * operation cancelled by then. It only observes; nothing stops.
 */
export function withDiagnosticArea<T>(
  area: DiagnosticArea,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return scope.run({ area, signal }, fn);
}

/**
 * Runs `fn` outside any area: for work scheduled from an area that is not
 * part of it, such as a debounced rebuild a change event set off.
 */
export function outsideDiagnosticArea<T>(fn: () => T): T {
  return scope.exit(fn);
}

/**
 * Runs `fn` with `attributes` added to every phase it starts, nested ones
 * included: a caller can label a lookup it cannot see inside (an initial
 * lookup versus the re-check under a lock). Outside any area it just runs
 * `fn`.
 */
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
 * Starts `phase` as a `swamp.diagnostic.<phase>` span in the current area,
 * parented on the active span. Outside any area it returns a silent handle,
 * so shared code (a repository, a lock) is exported only when a diagnostic
 * path runs it.
 */
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

/**
 * Runs `fn` as `phase`, ending it `ok` on return or with the error's outcome
 * on throw.
 */
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

/** UTF-8 length of `text` without encoding it. */
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
