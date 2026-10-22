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

/**
 * Holds what a v3 command writes to stdout until its root unit of work has
 * committed (swamp-club#3759).
 *
 * A command renders inside its root, before the root commits. On a v3
 * datastore the commit can still fail, and the command must not have said it
 * succeeded. So while a v3 root is open, the CLI root helpers hold the
 * stdout console methods (`console.log`, `console.info`, `console.debug`),
 * which `writeOutput`, `unguardedConsole.log`, the JSON renderers and the
 * LogTape console sink all write through. When the root ends, what was held
 * is written, in order, if it committed, and dropped if it did not, but for
 * debug lines, which go to stderr; the command's error then goes to stderr as
 * always. stderr is never held, so
 * warnings keep their place.
 *
 * - **Held** (the default): from the root's start.
 * - **Live until the outcome**: a streaming command in log mode writes its
 *   progress as it happens, and holding starts at its terminal event
 *   ({@link holdFromOutcome}), so its result and what follows wait.
 *
 * A prompt inside a root first writes what is held ({@link writeHeldOutput}):
 * nothing before a prompt has written to the datastore yet. A root opened inside another joins the
 * outer hold. The CLI runs one command per process, so the hold is
 * process-wide; serve, which writes its own log lines concurrently, never
 * opens one.
 *
 * @module
 */

/** The console methods that write to stdout. */
const STDOUT_METHODS = ["log", "info", "debug"] as const;

type StdoutMethod = typeof STDOUT_METHODS[number];

type ConsoleWrite = (...args: unknown[]) => void;

/** How a hold treats output before the command's outcome. */
export type OutputHoldMode = "held" | "live-until-outcome";

/** The open hold: ended once, by the root helper that opened it. */
export interface OutputHold {
  /** Writes what was held when `committed`, drops it otherwise. */
  end(committed: boolean): void;
}

interface ActiveHold {
  readonly originals: ReadonlyMap<StdoutMethod, ConsoleWrite>;
  readonly wrappers: ReadonlyMap<StdoutMethod, ConsoleWrite>;
  readonly queue: { method: StdoutMethod; args: unknown[] }[];
  holding: boolean;
}

let active: ActiveHold | undefined;

/** A hold that does nothing: for a nested root, which joins the outer one. */
const JOINED: OutputHold = { end: () => {} };

/**
 * Starts holding stdout for a v3 root, or joins the hold already open.
 */
export function openOutputHold(mode: OutputHoldMode): OutputHold {
  if (active !== undefined) return JOINED;
  const originals = new Map<StdoutMethod, ConsoleWrite>();
  const wrappers = new Map<StdoutMethod, ConsoleWrite>();
  const queue: ActiveHold["queue"] = [];
  const hold: ActiveHold = {
    originals,
    wrappers,
    queue,
    holding: mode === "held",
  };
  for (const method of STDOUT_METHODS) {
    const original = console[method] as ConsoleWrite;
    const wrapper: ConsoleWrite = (...args) => {
      if (hold.holding) {
        queue.push({ method, args });
      } else {
        original(...args);
      }
    };
    originals.set(method, original);
    wrappers.set(method, wrapper);
    console[method] = wrapper;
  }
  active = hold;
  let ended = false;
  return {
    end(committed) {
      if (ended) return;
      ended = true;
      for (const method of STDOUT_METHODS) {
        // Restored only while still the hold's: whatever replaced it since
        // restores what it saw itself.
        if (console[method] === wrappers.get(method)) {
          console[method] = originals.get(method)!;
        }
      }
      active = undefined;
      if (committed) {
        for (const { method, args } of queue) originals.get(method)!(...args);
        return;
      }
      // Nothing it printed stands, but a debug trace the user asked for is
      // diagnosis, not a result: it goes to stderr, where the error follows.
      for (const { method, args } of queue) {
        if (method === "debug") console.error(...args);
      }
    },
  };
}

/** Starts holding, from now on, the stdout of a live-until-outcome hold. */
export function beginOutcome(): void {
  if (active !== undefined) active.holding = true;
}

/**
 * Writes what is held so far, ahead of a prompt: a preview the command
 * printed must show before its question. Nothing before a prompt has
 * written to the datastore, so it is safe to show. Holding goes on.
 */
export function writeHeldOutput(): void {
  const hold = active;
  if (hold === undefined) return;
  for (const { method, args } of hold.queue.splice(0)) {
    hold.originals.get(method)!(...args);
  }
}

/** The events that end a run with its outcome. */
const OUTCOME_EVENTS: readonly string[] = [
  "completed",
  "cancelled",
  "suspended",
];

/**
 * `handlers` with holding started at the outcome: each terminal handler
 * begins the hold before it renders, so the run's result and what follows
 * it wait for the commit while its progress streams.
 */
export function holdFromOutcome<H extends object>(handlers: H): H {
  const wrapped = { ...handlers } as Record<string, unknown>;
  for (const kind of OUTCOME_EVENTS) {
    const handler = wrapped[kind];
    if (typeof handler !== "function") continue;
    wrapped[kind] = (...args: unknown[]) => {
      beginOutcome();
      return handler(...args);
    };
  }
  return wrapped as H;
}
