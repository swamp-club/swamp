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

import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "run-index-warmup"]);

/** What the warm-up reads. */
export interface RunIndexWarmupDeps {
  /** The ids of every workflow, read through the workflow listings. */
  listWorkflowIds(): Promise<string[]>;
  /**
   * How many run records a workflow has, counted without reading them.
   * Stops when `signal` aborts.
   */
  countRunRecords(workflowId: string, signal: AbortSignal): Promise<number>;
  /**
   * The most runs a snapshot may hold and still be cached. A workflow with
   * more is not warmed: its snapshot would be built and dropped.
   */
  maxRuns: number;
  /**
   * Reads one workflow's run index snapshot, which keeps it cached. Stops
   * when `signal` aborts, between records if it is rebuilding the index.
   */
  warm(workflowId: string, signal: AbortSignal): Promise<unknown>;
}

const STOPPED = Symbol("stopped");

/**
 * Reads every workflow's run index snapshot once serve is listening, so the
 * dashboard's first requests find them cached rather than building them
 * (swamp-club#3443). One workflow at a time, so requests that arrive
 * meanwhile interleave with it; a request for a workflow it is loading
 * waits on that load rather than starting another, and loads it itself if
 * the warm-up stops first. A workflow whose index cannot be read is left to
 * the request that needs it, as is one with more runs than the cache keeps.
 *
 * Stopping does not wait for the load in flight (swamp-club#3468): a plain
 * read of the index, a load a request started, or a repair queued behind
 * another reader does not watch the warm-up's signal, and would hold
 * shutdown for as long as it takes.
 */
export class RunIndexWarmup {
  readonly #deps: RunIndexWarmupDeps;
  readonly #abort = new AbortController();
  #running: Promise<void> | null = null;

  constructor(deps: RunIndexWarmupDeps) {
    this.#deps = deps;
  }

  /**
   * Starts the warm-up in the background. Not awaited, so serve does not
   * hold its readiness on it; `dispose` and `finished` wait for it.
   */
  start(): void {
    if (this.#running || this.#abort.signal.aborted) return;
    this.#running = this.#warmAll(this.#abort.signal);
  }

  /**
   * Resolves when the warm-up has finished, or was never started. Once it
   * is stopped, that is as soon as it lets go of the load in flight.
   */
  async finished(): Promise<void> {
    if (this.#running) await this.#running;
  }

  /**
   * Stops the warm-up without waiting for it. It lets go of the load in
   * flight at once; that load stops between records and writes no index if
   * it is the warm-up's own rebuild or repair, and otherwise runs on
   * unwatched. Shutdown calls this before it drains runs, and waits with
   * `finished` after.
   */
  stop(): void {
    this.#abort.abort();
  }

  /** Stops the warm-up and waits for it. */
  async dispose(): Promise<void> {
    this.stop();
    await this.finished();
  }

  async #warmAll(signal: AbortSignal): Promise<void> {
    const started = Date.now();
    let warmed = 0;
    const { promise: stopped, resolve: onStopped } = Promise.withResolvers<
      typeof STOPPED
    >();
    const onAbort = () => onStopped(STOPPED);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const ids = await this.#deps.listWorkflowIds();
      for (const id of ids) {
        if (signal.aborted) break;
        try {
          const runs = await untilStopped(
            this.#deps.countRunRecords(id, signal),
            stopped,
          );
          if (runs === STOPPED) break;
          if (runs > this.#deps.maxRuns) {
            logger
              .debug`Run index warm-up skipped workflow ${id}: its ${runs} runs are more than the cache keeps`;
            continue;
          }
          const result = await untilStopped(
            this.#deps.warm(id, signal),
            stopped,
          );
          if (result === STOPPED) break;
          warmed++;
        } catch (error) {
          if (signal.aborted) break;
          logger.debug`Run index warm-up skipped workflow ${id}: ${error}`;
        }
      }
    } catch (error) {
      logger.warn`Run index warm-up could not list workflows: ${error}`;
      return;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) {
      logger.debug`Run index warm-up stopped after ${warmed} workflows`;
      return;
    }
    logger.info`Run index warm-up read ${warmed} workflows in ${
      Date.now() - started
    } ms`;
  }
}

/**
 * Settles as `work` does, or with `STOPPED` once `stopped` resolves first.
 * `work` is then let go: its outcome, failure included, is no longer
 * wanted.
 */
function untilStopped<T>(
  work: Promise<T>,
  stopped: Promise<typeof STOPPED>,
): Promise<T | typeof STOPPED> {
  work.catch(() => {});
  return Promise.race([work, stopped]);
}
