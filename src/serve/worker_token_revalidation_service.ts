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
 * cuts off workers whose token lost its authority wherever that happened (CLI
 * without --server, HA peer, here), after delivering any rotation made outside
 * the gateway; the serve revoke handler is immediate, this covers the rest
 */

import { runDetached } from "../infrastructure/tracing/mod.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  deliverablePredecessor,
  type EnrollmentBindingCutoffCause,
  type EnrollmentToken,
  enrollmentTokenBindingVerdict,
} from "../domain/models/worker/enrollment_token_model.ts";

const logger = getSwampLogger(["serve", "worker-token-revalidation"]);

export const DEFAULT_WORKER_TOKEN_REVALIDATION_MS = 30_000;

/**
 * a token must be missing this many consecutive passes before its workers are
 * cut off: a present but momentarily unreadable record looks missing for one
 * pass, a deleted token stays missing
 */
export const MISSING_PASSES_BEFORE_CUTOFF = 2;

export interface WorkerTokenRevalidationDeps {
  readonly intervalMs: number;
  listBoundTokens(): readonly {
    tokenName: string;
    tokenCreatedAt: string;
  }[];
  /**
   * Every token's current record, keyed by name, from one read. A token
   * that does not exist or no longer parses is absent. Throws on read
   * failures, which keep every worker until the next pass.
   */
  readTokens(): Promise<ReadonlyMap<string, EnrollmentToken>>;
  revokeToken(
    name: string,
    cause: EnrollmentBindingCutoffCause,
    options: { mint: string },
  ): Promise<string[]>;
  deliverRotation?(name: string, token: EnrollmentToken): Promise<void>;
}

export class WorkerTokenRevalidationService {
  readonly #deps: WorkerTokenRevalidationDeps;
  readonly #missingPasses = new Map<string, number>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #wake: (() => void) | null = null;
  #ticking = false;
  #nudged = false;
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
    this.#wake?.();
    await this.#pending;
  }

  /** runs a pass now, or right after the one in progress; a no-op before start */
  nudge(): void {
    if (this.#disposed) return;
    if (this.#ticking) {
      this.#nudged = true;
      return;
    }
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#wake?.();
  }

  async runOnce(): Promise<string[]> {
    return await this.#revalidate();
  }

  #scheduleNext(): void {
    if (this.#disposed) return;
    const wake = Promise.withResolvers<void>();
    this.#wake = wake.resolve;
    this.#timer = runDetached(() =>
      setTimeout(wake.resolve, this.#deps.intervalMs)
    );
    Deno.unrefTimer(this.#timer);
    // continued from the loop's own context, so a nudge from inside a workflow
    // step never runs the pass, or its writes, in that step's unit of work
    this.#pending = runDetached(() => wake.promise.then(() => this.#tick()));
  }

  async #tick(): Promise<void> {
    this.#timer = null;
    this.#wake = null;
    if (this.#disposed) return;
    this.#ticking = true;
    this.#nudged = false;
    try {
      await this.#revalidate();
    } catch (err) {
      logger.error`Worker token revalidation failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    } finally {
      this.#ticking = false;
      this.#scheduleNext();
      if (this.#nudged) this.nudge();
    }
  }

  #boundMintsByName(): Map<string, string[]> {
    const mintsByName = new Map<string, string[]>();
    for (const bound of this.#deps.listBoundTokens()) {
      const mints = mintsByName.get(bound.tokenName) ?? [];
      mints.push(bound.tokenCreatedAt);
      mintsByName.set(bound.tokenName, mints);
    }
    return mintsByName;
  }

  async #revalidate(): Promise<string[]> {
    if (this.#disposed) return [];
    const mintsByName = this.#boundMintsByName();

    if (mintsByName.size === 0) {
      this.#missingPasses.clear();
      return [];
    }

    let tokens: ReadonlyMap<string, EnrollmentToken>;
    try {
      tokens = await this.#deps.readTokens();
    } catch (err) {
      // A transient read failure must not drop the fleet; the next pass
      // retries.
      logger.warn(
        "Could not revalidate worker tokens, keeping every worker until the next pass: {error}",
        { error: err instanceof Error ? err.message : String(err) },
      );
      return [];
    }

    for (const name of this.#missingPasses.keys()) {
      if (!mintsByName.has(name)) this.#missingPasses.delete(name);
    }

    const delivered = await this.#deliverRotations(mintsByName, tokens);
    if (delivered.length > 0) {
      // only delivered names are re-read: another name's fresh mint judged
      // against this pass's older record could cut off a just-enrolled worker
      const refreshed = this.#boundMintsByName();
      for (const name of delivered) {
        mintsByName.set(name, refreshed.get(name) ?? []);
      }
    }

    const removed: string[] = [];
    for (const [name, mints] of mintsByName) {
      if (this.#disposed) break;
      const token = tokens.get(name) ?? null;
      if (token === null) {
        const missing = (this.#missingPasses.get(name) ?? 0) + 1;
        this.#missingPasses.set(name, missing);
        if (missing < MISSING_PASSES_BEFORE_CUTOFF) {
          logger.warn(
            "Enrollment token {name} has no readable record; its workers are cut off if it is still missing on the next pass",
            { name },
          );
          continue;
        }
      } else {
        this.#missingPasses.delete(name);
      }
      for (const mint of mints) {
        const verdict = enrollmentTokenBindingVerdict(token, mint);
        if (verdict.keep) continue;
        const cutOff = await this.#deps.revokeToken(name, verdict.cause, {
          mint,
        });
        for (const worker of cutOff) removed.push(worker);
      }
      if (token === null) this.#missingPasses.delete(name);
    }
    return removed;
  }

  /** concurrent, so one silent worker delays every verdict by one timeout at most */
  async #deliverRotations(
    mintsByName: ReadonlyMap<string, string[]>,
    tokens: ReadonlyMap<string, EnrollmentToken>,
  ): Promise<string[]> {
    const deliver = this.#deps.deliverRotation;
    if (deliver === undefined) return [];
    const due: [string, EnrollmentToken][] = [];
    for (const [name, mints] of mintsByName) {
      const token = tokens.get(name);
      const predecessor = token && deliverablePredecessor(token);
      if (
        token !== undefined && predecessor !== undefined &&
        mints.some((mint) =>
          Date.parse(mint) === Date.parse(predecessor.createdAt)
        )
      ) {
        due.push([name, token]);
      }
    }
    await Promise.all(due.map(async ([name, token]) => {
      try {
        await deliver(name, token);
      } catch (err) {
        logger.warn(
          "Could not deliver the rotated enrollment token {name}: {error}",
          { name, error: err instanceof Error ? err.message : String(err) },
        );
      }
    }));
    return due.map(([name]) => name);
  }
}
