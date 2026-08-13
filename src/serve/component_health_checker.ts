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

import type { DatastoreHealthResult } from "../domain/datastore/datastore_health.ts";

export interface ComponentHealth {
  readonly name: string;
  readonly healthy: boolean;
  readonly message: string;
  readonly latencyMs: number;
  readonly details?: Record<string, string>;
}

export type HealthCheckFn = (
  signal: AbortSignal,
) => Promise<DatastoreHealthResult>;

export interface ComponentHealthCheckerDeps {
  readonly checkDatastore?: HealthCheckFn;
  readonly checkVault?: HealthCheckFn;
}

const DEFAULT_CHECK_TIMEOUT_MS = 5_000;

export class ComponentHealthChecker {
  readonly #deps: ComponentHealthCheckerDeps;
  readonly #timeoutMs: number;

  constructor(
    deps: ComponentHealthCheckerDeps,
    timeoutMs: number = DEFAULT_CHECK_TIMEOUT_MS,
  ) {
    this.#deps = deps;
    this.#timeoutMs = timeoutMs;
  }

  async checkAll(signal?: AbortSignal): Promise<ComponentHealth[]> {
    const results: ComponentHealth[] = [];
    const checks: Array<{ name: string; fn: HealthCheckFn }> = [];

    if (this.#deps.checkDatastore) {
      checks.push({ name: "datastore", fn: this.#deps.checkDatastore });
    }
    if (this.#deps.checkVault) {
      checks.push({ name: "vault", fn: this.#deps.checkVault });
    }

    const settled = await Promise.allSettled(
      checks.map(({ fn }) => this.#runWithTimeout(fn, signal)),
    );

    for (let i = 0; i < checks.length; i++) {
      const { name } = checks[i];
      const result = settled[i];
      if (result.status === "fulfilled") {
        const r = result.value;
        results.push({
          name,
          healthy: r.healthy,
          message: r.message,
          latencyMs: r.latencyMs,
          details: r.details,
        });
      } else {
        results.push({
          name,
          healthy: false,
          message: result.reason instanceof Error
            ? result.reason.message
            : "Health check failed",
          latencyMs: this.#timeoutMs,
        });
      }
    }

    return results;
  }

  async #runWithTimeout(
    fn: HealthCheckFn,
    parentSignal?: AbortSignal,
  ): Promise<DatastoreHealthResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    if (parentSignal) {
      parentSignal.addEventListener(
        "abort",
        () => controller.abort(),
        { once: true },
      );
    }

    try {
      return await fn(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }
}
