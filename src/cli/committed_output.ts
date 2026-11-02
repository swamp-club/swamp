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
 * holds a v3 command's stdout until its root commits, then writes it in order
 * or drops it; stderr is never held; nested roots join the outer hold;
 * process-wide, as the CLI runs one command per process
 */

const STDOUT_METHODS = ["log", "info", "debug"] as const;

type StdoutMethod = typeof STDOUT_METHODS[number];

type ConsoleWrite = (...args: unknown[]) => void;

export type OutputHoldMode = "held" | "live-until-outcome";

export interface OutputHold {
  end(committed: boolean): void;
}

interface ActiveHold {
  readonly originals: ReadonlyMap<StdoutMethod, ConsoleWrite>;
  readonly wrappers: ReadonlyMap<StdoutMethod, ConsoleWrite>;
  readonly queue: { method: StdoutMethod; args: unknown[] }[];
  holding: boolean;
}

let active: ActiveHold | undefined;

const JOINED: OutputHold = { end: () => {} };

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

const OUTCOME_EVENTS: readonly string[] = [
  "completed",
  "cancelled",
  "suspended",
];

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
