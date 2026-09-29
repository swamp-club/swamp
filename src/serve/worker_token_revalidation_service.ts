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
 * Re-checks the enrollment token behind every worker in the pool and cuts
 * off the workers whose token has lost its authority — revoked, re-minted,
 * or deleted — wherever that happened: from the CLI without --server, on an
 * HA peer (the runtime data poller brings the record in), or here. The
 * serve revoke handler cuts workers off immediately; this pass covers the
 * revokes that never reach this instance's gateway.
 */

import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  type EnrollmentBindingCutoffCause,
  type EnrollmentToken,
  enrollmentTokenBindingVerdict,
} from "../domain/models/worker/enrollment_token_model.ts";

const logger = getSwampLogger(["serve", "worker-token-revalidation"]);

/** Matches the server-token session revalidation interval. */
export const DEFAULT_WORKER_TOKEN_REVALIDATION_MS = 30_000;

export interface WorkerTokenRevalidationDeps {
  readonly intervalMs: number;
  /** Each distinct token mint held by a pool member. */
  listBoundTokens(): readonly {
    tokenName: string;
    tokenCreatedAt: string | null;
  }[];
  /**
   * The token's current record, or null when it does not exist or no
   * longer parses. Throws on read failures, which keep the workers.
   */
  readToken(name: string): Promise<EnrollmentToken | null>;
  /** Cuts off the workers enrolled on one mint; returns their names. */
  revokeToken(
    name: string,
    cause: EnrollmentBindingCutoffCause,
    options: { mint: string | null },
  ): Promise<string[]>;
}

export class WorkerTokenRevalidationService {
  readonly #deps: WorkerTokenRevalidationDeps;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pending: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(deps: WorkerTokenRevalidationDeps) {
    this.#deps = deps;
  }

  start(): void {
    if (this.#disposed) return;
    logger.info(
      "Starting worker token revalidation (interval: {interval}ms)",
      { interval: this.#deps.intervalMs },
    );
    this.#scheduleNext();
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.#pending;
  }

  /** Runs one revalidation pass; returns the names of the workers cut off. */
  async runOnce(): Promise<string[]> {
    return await this.#revalidate();
  }

  #scheduleNext(): void {
    if (this.#disposed) return;
    this.#timer = setTimeout(() => {
      this.#pending = this.#tick();
    }, this.#deps.intervalMs);
    Deno.unrefTimer(this.#timer);
  }

  async #tick(): Promise<void> {
    if (this.#disposed) return;
    try {
      await this.#revalidate();
    } catch (err) {
      logger.error`Worker token revalidation failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    } finally {
      this.#scheduleNext();
    }
  }

  async #revalidate(): Promise<string[]> {
    const mintsByName = new Map<string, (string | null)[]>();
    for (const bound of this.#deps.listBoundTokens()) {
      const mints = mintsByName.get(bound.tokenName) ?? [];
      mints.push(bound.tokenCreatedAt);
      mintsByName.set(bound.tokenName, mints);
    }

    const removed: string[] = [];
    for (const [name, mints] of mintsByName) {
      if (this.#disposed) break;
      let token: EnrollmentToken | null;
      try {
        token = await this.#deps.readToken(name);
      } catch (err) {
        // A transient read failure must not drop the fleet; the next pass
        // retries.
        logger.warn(
          "Could not revalidate workers on token {name}, keeping them until the next pass: {error}",
          { name, error: err instanceof Error ? err.message : String(err) },
        );
        continue;
      }
      for (const mint of mints) {
        const verdict = enrollmentTokenBindingVerdict(token, mint);
        if (verdict.keep) continue;
        const cutOff = await this.#deps.revokeToken(name, verdict.cause, {
          mint,
        });
        for (const worker of cutOff) removed.push(worker);
      }
    }
    return removed;
  }
}
