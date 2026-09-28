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

/** The env vars an execution's trace context is published under. */
const TRACE_ENV_NAMES = ["TRACEPARENT", "TRACESTATE"] as const;

/** The slice of `Deno.env` that {@link ProcessTraceEnv} reads and writes. */
export type TraceEnvStore = Pick<typeof Deno.env, "get" | "set" | "delete">;

/** One active execution, linked to the execution that nested it (if any). */
interface Frame {
  readonly parent: Frame | undefined;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Publishes an in-process execution's trace context in the process env for
 * code that reads `TRACEPARENT` from it (in-process extension methods, and
 * subprocesses spawned with an inherited env).
 *
 * The process env is shared by every execution in the process, so it can
 * only carry one execution's context at a time. While the active executions
 * form a single nesting chain (a lone execution, plus any executions it
 * started through `runModel()` and is awaiting), the env holds the innermost
 * execution's headers, and a nested execution hands the env back to its
 * parent when it finishes. As soon as two unrelated executions overlap
 * (parallel workflow steps, concurrent `swamp serve` requests, parallel
 * `runModel()` calls), the env reverts to its baseline (the values it held
 * before the first execution started, i.e. the process's own inbound
 * context) and stays there until every execution has finished, so no
 * execution ever sees a sibling's span and nothing leaks past the last
 * execution. Per-execution context is always available on
 * `MethodContext.traceHeaders`.
 */
export class ProcessTraceEnv {
  readonly #active = new Set<Frame>();
  readonly #current = new AsyncLocalStorage<Frame>();
  #overlapped = false;
  #baseline: Map<string, string | undefined> | undefined;

  constructor(private readonly env: TraceEnvStore = Deno.env) {}

  /**
   * Runs one execution's method code with its trace context published in the
   * process env whenever that is safe. Executions started from within `fn`
   * are treated as nested in this one.
   */
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

  /**
   * The active execution no other active execution descends from. Only
   * called while the active executions form a single chain.
   */
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

  /**
   * Whether the active executions are exactly `frame` and its ancestors
   * (vacuously true when nothing is active and `frame` is undefined).
   */
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

/** The process-wide instance shared by every in-process execution. */
export const processTraceEnv: ProcessTraceEnv = new ProcessTraceEnv();
