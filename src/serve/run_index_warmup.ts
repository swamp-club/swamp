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
import { STOPPED, stoppedBy, untilStopped } from "./until_stopped.ts";

const logger = getSwampLogger(["serve", "run-index-warmup"]);

export interface RunIndexWarmupDeps {
  listWorkflowIds(): Promise<string[]>;
  countRunRecords(workflowId: string, signal: AbortSignal): Promise<number>;
  maxRuns: number;
  warm(workflowId: string, signal: AbortSignal): Promise<unknown>;
}

/**
 * one workflow at a time so requests interleave. Stopping does not wait for the
 * load in flight: the signal is raced against each dependency's promise so an
 * uncancellable one cannot hold shutdown.
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

  async finished(): Promise<void> {
    if (this.#running) await this.#running;
  }

  /**
   * returns at once, letting go of the load in flight; shutdown calls this
   * before draining runs and waits with finished after
   */
  stop(): void {
    this.#abort.abort();
  }

  async dispose(): Promise<void> {
    this.stop();
    await this.finished();
  }

  async #warmAll(signal: AbortSignal): Promise<void> {
    const started = Date.now();
    let warmed = 0;
    const { stopped, release } = stoppedBy(signal);
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
      release();
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
