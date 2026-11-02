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
import { traceHeadersToEnv } from "./execution_envelope.ts";

const TRACE_ENV_NAMES = ["TRACEPARENT", "TRACESTATE"] as const;

export type TraceEnvStore = Pick<typeof Deno.env, "get" | "set" | "delete">;

interface Frame {
  readonly parent: Frame | undefined;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * the shared env carries one context at a time: the innermost of a single
 * nesting chain, reverting to baseline while unrelated executions overlap and
 * until all finish, so no one sees a sibling's span
 */
export class ProcessTraceEnv {
  readonly #active = new Set<Frame>();
  readonly #current = new AsyncLocalStorage<Frame>();
  #overlapped = false;
  #baseline: Map<string, string | undefined> | undefined;

  constructor(private readonly env: TraceEnvStore = Deno.env) {}

  async run<T>(
    traceHeaders: Readonly<Record<string, string>> | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const frame: Frame = {
      parent: this.#current.getStore(),
      env: traceHeadersToEnv(traceHeaders),
    };
    try {
      this.#enter(frame);
      return await this.#current.run(frame, fn);
    } finally {
      this.#exit(frame);
    }
  }

  #enter(frame: Frame): void {
    const nested = this.#isActiveChain(frame.parent);
    this.#active.add(frame);
    if (this.#overlapped || !nested) {
      this.#overlapped = true;
      this.#restoreBaseline();
      return;
    }
    this.#publish(frame.env);
  }

  #exit(frame: Frame): void {
    if (!this.#active.delete(frame)) {
      return;
    }
    if (this.#active.size === 0) {
      this.#overlapped = false;
      this.#restoreBaseline();
      this.#baseline = undefined;
    } else if (!this.#overlapped) {
      // The frame is usually the innermost, handing the env back to its
      // parent, but an unawaited runModel() can leave a descendant running
      // after it, so publish whichever active frame is now innermost.
      this.#publish(this.#innermostActive().env);
    }
  }

  #innermostActive(): Frame {
    const ancestors = new Set<Frame>();
    for (const frame of this.#active) {
      for (let f = frame.parent; f; f = f.parent) {
        ancestors.add(f);
      }
    }
    // A non-empty set of finite chains always has a frame with no active
    // descendant.
    return [...this.#active].find((frame) => !ancestors.has(frame))!;
  }

  #isActiveChain(frame: Frame | undefined): boolean {
    let depth = 0;
    for (let f = frame; f; f = f.parent) {
      if (!this.#active.has(f)) {
        return false;
      }
      depth++;
    }
    return depth === this.#active.size;
  }

  #publish(traceEnv: Readonly<Record<string, string>>): void {
    if (!this.#baseline) {
      if (Object.keys(traceEnv).length === 0) {
        return;
      }
      // Snapshot before writing, so a failed write still unwinds on exit.
      this.#baseline = new Map(
        TRACE_ENV_NAMES.map((name) => [name, this.env.get(name)]),
      );
    }
    // A header the execution does not carry keeps its baseline value.
    for (const name of TRACE_ENV_NAMES) {
      this.#write(name, traceEnv[name] ?? this.#baseline.get(name));
    }
  }

  #restoreBaseline(): void {
    if (!this.#baseline) {
      return;
    }
    for (const [name, value] of this.#baseline) {
      this.#write(name, value);
    }
  }

  #write(name: string, value: string | undefined): void {
    if (value !== undefined) {
      this.env.set(name, value);
    } else {
      this.env.delete(name);
    }
  }
}

export const processTraceEnv: ProcessTraceEnv = new ProcessTraceEnv();
