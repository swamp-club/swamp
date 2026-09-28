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

import { traceHeadersToEnv } from "./execution_envelope.ts";

/** The env vars an execution's trace context is published under. */
const TRACE_ENV_NAMES = ["TRACEPARENT", "TRACESTATE"] as const;

/** The slice of `Deno.env` that {@link ProcessTraceEnv} reads and writes. */
export type TraceEnvStore = Pick<typeof Deno.env, "get" | "set" | "delete">;

/**
 * Publishes an in-process execution's trace context in the process env for
 * code that reads `TRACEPARENT` from it (in-process extension methods, and
 * subprocesses spawned with an inherited env).
 *
 * The process env is shared by every execution in the process, so it can
 * only carry one execution's context at a time. While exactly one execution
 * is active, the env holds that execution's headers. As soon as a second
 * execution overlaps, the env reverts to its baseline (the values it held
 * before the first execution started, i.e. the process's own inbound
 * context) and stays there until every execution has finished, so no
 * execution ever sees a sibling's span and nothing leaks past the last
 * execution. Per-execution context is always available on
 * `MethodContext.traceHeaders`.
 */
export class ProcessTraceEnv {
  #active = 0;
  #baseline: Map<string, string | undefined> | undefined;

  constructor(private readonly env: TraceEnvStore = Deno.env) {}

  /**
   * Marks an execution as started. Every call must be paired with
   * {@link exit}, including when this call throws.
   */
  enter(traceHeaders: Readonly<Record<string, string>> | undefined): void {
    this.#active++;
    if (this.#active > 1) {
      this.#restoreBaseline();
      return;
    }
    const traceEnv = traceHeadersToEnv(traceHeaders);
    if (Object.keys(traceEnv).length === 0) {
      return;
    }
    // Snapshot before writing, so a failed write still unwinds on exit.
    this.#baseline = new Map(
      TRACE_ENV_NAMES.map((name) => [name, this.env.get(name)]),
    );
    for (const [name, value] of Object.entries(traceEnv)) {
      this.env.set(name, value);
    }
  }

  /** Marks an execution as finished. */
  exit(): void {
    if (this.#active === 0) {
      return;
    }
    this.#active--;
    if (this.#active === 0) {
      this.#restoreBaseline();
    }
  }

  #restoreBaseline(): void {
    const baseline = this.#baseline;
    if (!baseline) {
      return;
    }
    this.#baseline = undefined;
    for (const [name, value] of baseline) {
      if (value !== undefined) {
        this.env.set(name, value);
      } else {
        this.env.delete(name);
      }
    }
  }
}

/** The process-wide instance shared by every in-process execution. */
export const processTraceEnv: ProcessTraceEnv = new ProcessTraceEnv();
