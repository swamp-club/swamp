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
 * one per process, handed to every executor serve builds, and closed by
 * shutdown for the runs it interrupts
 */

import type { RunWriteFence } from "../domain/workflows/run_write_fence.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "shutdown"]);

/**
 * bounds how long closing waits for saves under way so shutdown stays inside
 * its termination grace; a save still running at the deadline is logged, and is
 * refused at its write unless that write had begun
 */
export const RUN_WRITE_FENCE_WAIT_MS = 2_000;

export class ServeRunWriteFence implements RunWriteFence {
  readonly #closed = new Set<string>();
  readonly #takenOver = new Set<string>();
  readonly #inFlight = new Map<string, Set<Promise<void>>>();

  isClosed(runId: string): boolean {
    return this.#closed.has(runId);
  }

  isTakenOver(runId: string): boolean {
    return this.#takenOver.has(runId);
  }

  // called before the owner's record commits, so each executor commit either
  // checks after this and is withdrawn, or checked earlier and lands first
  takeOver(runId: string): void {
    this.#takenOver.add(runId);
  }

  track(runId: string, write: Promise<void>): Promise<void> {
    let writes = this.#inFlight.get(runId);
    if (writes === undefined) {
      writes = new Set();
      this.#inFlight.set(runId, writes);
    }
    const settled: Promise<void> = write.then(release, release);
    writes.add(settled);
    const inFlight = this.#inFlight;
    function release() {
      writes!.delete(settled);
      if (writes!.size === 0 && inFlight.get(runId) === writes) {
        inFlight.delete(runId);
      }
    }
    return write;
  }

  async close(
    runIds: readonly string[],
    waitMs: number = RUN_WRITE_FENCE_WAIT_MS,
  ): Promise<void> {
    for (const runId of runIds) this.#closed.add(runId);
    const pending = runIds.flatMap((runId) => [
      ...(this.#inFlight.get(runId) ?? []),
    ]);
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    });
    try {
      await Promise.race([Promise.allSettled(pending), deadline]);
    } finally {
      clearTimeout(timer);
    }
    const late = runIds.filter((runId) => this.#inFlight.has(runId));
    if (late.length > 0) {
      logger.warn(
        "A save of workflow run(s) {runIds} by their executor was still under way {seconds}s after shutdown closed their write fence; it is refused when it reaches its write, unless that write had already begun",
        { runIds: late, seconds: waitMs / 1000 },
      );
    }
  }
}
