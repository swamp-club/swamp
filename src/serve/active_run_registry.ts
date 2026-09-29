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
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "active-run-registry"]);

const ANONYMOUS_PRINCIPAL = "@anonymous";

export type RunKind = "workflow-run" | "workflow-resume" | "method-run";

export type RegistryErrorCode =
  | "already_registered"
  | "reserved"
  | "global_cap"
  | "principal_cap";

export class RegistryCapacityError extends Error {
  readonly code: RegistryErrorCode;
  constructor(code: RegistryErrorCode, message: string) {
    super(message);
    this.name = "RegistryCapacityError";
    this.code = code;
  }
}

export interface ActiveRun {
  readonly runId: string;
  readonly kind: RunKind;
  readonly resourceName: string;
  readonly buffer: RunEventBuffer;
  readonly controller: AbortController;
  readonly startedAt: Date;
  readonly completion: Promise<void>;
  readonly principalId: string | null;
}

export interface ActiveRunRegistryOptions {
  maxConcurrent?: number;
  maxPerPrincipal?: number;
  maxRunDurationMs?: number;
}

export class ActiveRunRegistry {
  readonly #runs = new Map<string, ActiveRun>();
  readonly #maxConcurrent: number;
  readonly #maxPerPrincipal: number | undefined;
  readonly #maxRunDurationMs: number | undefined;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #reserved = new Set<string>();
  /** Nested child run id -> the registered run whose workflow started it. */
  readonly #nested = new Map<string, string>();

  constructor(options?: ActiveRunRegistryOptions) {
    this.#maxConcurrent = Math.max(1, options?.maxConcurrent ?? 100);
    this.#maxPerPrincipal = options?.maxPerPrincipal !== undefined
      ? Math.max(1, options.maxPerPrincipal)
      : undefined;
    this.#maxRunDurationMs = options?.maxRunDurationMs;
  }

  register(run: ActiveRun): void {
    if (this.#runs.has(run.runId)) {
      throw new RegistryCapacityError(
        "already_registered",
        `Run ${run.runId} is already registered`,
      );
    }
    if (this.#reserved.has(run.runId)) {
      throw new RegistryCapacityError(
        "reserved",
        `Run ${run.runId} is reserved by another operation`,
      );
    }
    if (this.#runs.size >= this.#maxConcurrent) {
      throw new RegistryCapacityError(
        "global_cap",
        `Too many concurrent runs (limit: ${this.#maxConcurrent}); wait for active runs to complete`,
      );
    }
    if (this.#maxPerPrincipal !== undefined) {
      const effectivePrincipal = run.principalId ?? ANONYMOUS_PRINCIPAL;
      const count = this.#countForPrincipal(effectivePrincipal);
      if (count >= this.#maxPerPrincipal) {
        throw new RegistryCapacityError(
          "principal_cap",
          `Too many concurrent runs for principal ${effectivePrincipal} (limit: ${this.#maxPerPrincipal}); wait for active runs to complete`,
        );
      }
    }
    this.#runs.set(run.runId, run);

    if (this.#maxRunDurationMs !== undefined) {
      const timer = setTimeout(() => {
        this.#timers.delete(run.runId);
        logger.warn(
          "Run {runId} exceeded max duration ({durationMs}ms), aborting",
          { runId: run.runId, durationMs: this.#maxRunDurationMs! },
        );
        run.controller.abort(new Error("max run duration exceeded"));
      }, this.#maxRunDurationMs);
      Deno.unrefTimer(timer);
      this.#timers.set(run.runId, timer);
    }
  }

  /**
   * Claims a run id so no run can be registered under it until the returned
   * release function is called. Serve takes it around every change it makes
   * to a persisted run it is not driving (cancelling, approving or rejecting
   * a suspended run), so those changes and a resume never interleave within
   * this process. Returns null when the id is already registered or
   * reserved. A reservation is not a run: it is not listed, counted against
   * the caps, cancelled, or drained, and it does not block rekey. Release is
   * idempotent; call it from a finally.
   */
  reserve(runId: string): (() => void) | null {
    if (this.#runs.has(runId) || this.#reserved.has(runId)) return null;
    this.#reserved.add(runId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#reserved.delete(runId);
    };
  }

  deregister(runId: string): void {
    this.#runs.delete(runId);
    for (const [childId, parentId] of this.#nested) {
      if (parentId === runId) this.#nested.delete(childId);
    }
    const timer = this.#timers.get(runId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers.delete(runId);
    }
  }

  rekey(oldId: string, newId: string): boolean {
    const run = this.#runs.get(oldId);
    if (!run) return false;
    if (this.#runs.has(newId)) return false;
    this.#runs.delete(oldId);
    this.#runs.set(newId, { ...run, runId: newId });
    for (const [childId, parentId] of this.#nested) {
      if (parentId === oldId) this.#nested.set(childId, newId);
    }
    const timer = this.#timers.get(oldId);
    if (timer !== undefined) {
      this.#timers.delete(oldId);
      this.#timers.set(newId, timer);
    }
    return true;
  }

  get(runId: string): ActiveRun | undefined {
    return this.#runs.get(runId);
  }

  /**
   * Records that a nested workflow step of the registered run `parentId`
   * started the child run `childId`. The child is not registered: it is
   * cancelled through its parent, and only {@link findForAttach} resolves it.
   */
  addNestedRun(parentId: string, childId: string): void {
    if (!this.#runs.has(parentId) || this.#runs.has(childId)) return;
    this.#nested.set(childId, parentId);
  }

  /**
   * The run a client reattaches to by `runId`: a registered run, or the one
   * whose nested workflow step started the child run `runId`. A client older
   * than swamp-club#2470 tracks the child's id once a nested step starts, so
   * its reconnect names the child.
   */
  findForAttach(runId: string): ActiveRun | undefined {
    const run = this.#runs.get(runId);
    if (run) return run;
    const parentId = this.#nested.get(runId);
    return parentId === undefined ? undefined : this.#runs.get(parentId);
  }

  /** `reason` becomes the cancelled run's `cancel_reason`. */
  cancel(runId: string, reason = "cancelled by user"): boolean {
    const run = this.#runs.get(runId);
    if (!run) return false;
    run.controller.abort(new Error(reason));
    return true;
  }

  cancelAll(typeFilter?: string, reason = "cancelled by user"): number {
    let count = 0;
    for (const run of this.#runs.values()) {
      if (typeFilter && !matchesTypeFilter(run.kind, typeFilter)) continue;
      run.controller.abort(new Error(reason));
      count++;
    }
    return count;
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

  #countForPrincipal(effectivePrincipalId: string): number {
    let count = 0;
    for (const run of this.#runs.values()) {
      const p = run.principalId ?? ANONYMOUS_PRINCIPAL;
      if (p === effectivePrincipalId) count++;
    }
    return count;
  }
}

function matchesTypeFilter(kind: RunKind, filter: string): boolean {
  if (kind === filter) return true;
  if (filter === "workflow-run" && kind === "workflow-resume") return true;
  return false;
}
