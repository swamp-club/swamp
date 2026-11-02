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
import type { ShutdownDeadline } from "./shutdown_deadline.ts";

const logger = getSwampLogger(["serve", "shutdown"]);

export const SHUTDOWN_SLOW_STAGE_NOTICE_MS = 1_000;

/**
 * "left" gets nothing once the budget is spent, "floor" always gets one short
 * attempt, "self" is capped by its own argument so it is awaited, never raced
 */
export type ShutdownStageBound = "left" | "floor" | "self";

export type ShutdownStageOutcome = "done" | "failed" | "timed_out";

export interface ShutdownStagesOptions {
  readonly onTimedOut?: (stage: string, waitedMs: number) => void;
  readonly slowNoticeMs?: number;
}

/**
 * runs shutdown's post-drain stages in turn so none waits past the shutdown
 * deadline and one that fails or stalls never skips the stages after it
 */
export class ShutdownStages {
  readonly #deadline: ShutdownDeadline;
  readonly #onTimedOut?: (stage: string, waitedMs: number) => void;
  readonly #slowNoticeMs: number;

  constructor(deadline: ShutdownDeadline, options: ShutdownStagesOptions = {}) {
    this.#deadline = deadline;
    this.#onTimedOut = options.onTimedOut;
    this.#slowNoticeMs = options.slowNoticeMs ?? SHUTDOWN_SLOW_STAGE_NOTICE_MS;
  }

  async run(
    stage: string,
    work: () => Promise<unknown>,
    bound: ShutdownStageBound = "left",
  ): Promise<ShutdownStageOutcome> {
    const started = Date.now();
    logger.debug`Shutdown: stopping ${stage}`;
    const slowNotice = setTimeout(() => {
      logger.info`Shutdown: still waiting for ${stage}...`;
    }, this.#slowNoticeMs);
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = Promise.resolve().then(work).then(() => "done" as const);
      let outcome: "done" | "timed_out";
      if (bound === "self") {
        outcome = await pending;
      } else {
        const waitMs = bound === "floor"
          ? this.#deadline.remaining()
          : this.#deadline.left();
        // a timed-out stage's work is let go; process exit ends it
        pending.catch(() => {});
        const timedOut = new Promise<"timed_out">((resolve) => {
          deadlineTimer = setTimeout(() => resolve("timed_out"), waitMs);
        });
        outcome = await Promise.race([pending, timedOut]);
      }
      const waitedMs = Date.now() - started;
      if (outcome === "timed_out") {
        logger
          .warn`Shutdown: ${stage} did not stop within the shutdown deadline (waited ${waitedMs} ms); continuing without it`;
        this.#onTimedOut?.(stage, waitedMs);
        return "timed_out";
      }
      logger.debug`Shutdown: stopped ${stage} in ${waitedMs} ms`;
      return "done";
    } catch (error) {
      logger.error`Shutdown: ${stage} failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      return "failed";
    } finally {
      clearTimeout(slowNotice);
      clearTimeout(deadlineTimer);
    }
  }
}
