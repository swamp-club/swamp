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

import type { RunEventBuffer } from "./run_event_buffer.ts";

export type RunKind = "workflow-run" | "workflow-resume" | "method-run";

export interface ActiveRun {
  readonly runId: string;
  readonly kind: RunKind;
  readonly buffer: RunEventBuffer;
  readonly controller: AbortController;
  readonly startedAt: Date;
  readonly completion: Promise<void>;
}

export class ActiveRunRegistry {
  readonly #runs = new Map<string, ActiveRun>();
  readonly #maxConcurrent: number;

  constructor(options?: { maxConcurrent?: number }) {
    this.#maxConcurrent = options?.maxConcurrent ?? 100;
  }

  register(run: ActiveRun): void {
    if (this.#runs.has(run.runId)) {
      throw new Error(`Run ${run.runId} is already registered`);
    }
    if (this.#runs.size >= this.#maxConcurrent) {
      throw new Error(
        `Too many concurrent runs (limit: ${this.#maxConcurrent}); wait for active runs to complete`,
      );
    }
    this.#runs.set(run.runId, run);
  }

  deregister(runId: string): void {
    this.#runs.delete(runId);
  }

  rekey(oldId: string, newId: string): boolean {
    const run = this.#runs.get(oldId);
    if (!run) return false;
    this.#runs.delete(oldId);
    this.#runs.set(newId, { ...run, runId: newId });
    return true;
  }

  get(runId: string): ActiveRun | undefined {
    return this.#runs.get(runId);
  }

  cancel(runId: string): boolean {
    const run = this.#runs.get(runId);
    if (!run) return false;
    run.controller.abort(new Error("cancelled by user"));
    return true;
  }

  list(): ReadonlyArray<ActiveRun> {
    return [...this.#runs.values()];
  }

  get size(): number {
    return this.#runs.size;
  }

  async drainAll(timeoutMs = 30_000): Promise<void> {
    const runs = [...this.#runs.values()];
    if (runs.length === 0) return;

    const completions = runs.map((r) => r.completion);

    if (timeoutMs <= 0) {
      await Promise.allSettled(completions);
      return;
    }

    await Promise.race([
      Promise.allSettled(completions),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }
}
