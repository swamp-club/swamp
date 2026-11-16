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

import { UserError } from "../errors.ts";
import { parseWorkspaceName } from "../workspace/workspace_name.ts";

export type ServeId =
  | { readonly kind: "root" }
  | { readonly kind: "workspace"; readonly name: string };

export const ROOT_SERVE: ServeId = Object.freeze({ kind: "root" });

export function workspaceServe(name: string): ServeId {
  return Object.freeze({ kind: "workspace", name: parseWorkspaceName(name) });
}

export function serveIdKey(id: ServeId): string {
  return id.kind === "root" ? "root" : `workspace:${id.name}`;
}

export type WantedServeState = "running" | "suspended" | "deleted";

export type ObservedServeState =
  | "stopped"
  | "starting"
  | "ready"
  | "backoff"
  | "failed";

/** `code` is null when the child died by a signal or could not be spawned. */
export type ManagedServeEvent =
  | { readonly kind: "wanted"; readonly wanted: WantedServeState }
  | { readonly kind: "resume" }
  | { readonly kind: "ready" }
  | { readonly kind: "exited"; readonly code: number | null }
  | { readonly kind: "tick" };

/** `until` is when the supervisor should send the next tick. */
export type ManagedServeAction =
  | { readonly kind: "spawn" }
  | { readonly kind: "stop" }
  | { readonly kind: "wait"; readonly until?: number };

export interface ManagedServePolicy {
  readonly restartDelayMs: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly crashWindowMs: number;
  readonly maxCrashesInWindow: number;
}

export interface ManagedServeStep {
  readonly next: ManagedServe;
  readonly action: ManagedServeAction;
}

export const SAFE_RESTART_EXIT_CODE = 75;

export function parseManagedServePolicy(
  policy: ManagedServePolicy,
): ManagedServePolicy {
  for (const [field, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new UserError(
        `Invalid serve restart policy: ${field} must be a positive whole number, got ${value}.`,
      );
    }
  }
  if (policy.initialBackoffMs > policy.maxBackoffMs) {
    throw new UserError(
      "Invalid serve restart policy: initialBackoffMs must not exceed maxBackoffMs.",
    );
  }
  if (policy.restartDelayMs > policy.maxBackoffMs) {
    throw new UserError(
      "Invalid serve restart policy: restartDelayMs must not exceed maxBackoffMs.",
    );
  }
  return Object.freeze({
    restartDelayMs: policy.restartDelayMs,
    initialBackoffMs: policy.initialBackoffMs,
    maxBackoffMs: policy.maxBackoffMs,
    crashWindowMs: policy.crashWindowMs,
    maxCrashesInWindow: policy.maxCrashesInWindow,
  });
}

export const DEFAULT_MANAGED_SERVE_POLICY: ManagedServePolicy =
  parseManagedServePolicy({
    restartDelayMs: 1_000,
    initialBackoffMs: 1_000,
    maxBackoffMs: 60_000,
    crashWindowMs: 600_000,
    maxCrashesInWindow: 5,
  });

interface ManagedServeState {
  readonly id: ServeId;
  readonly policy: ManagedServePolicy;
  readonly wanted: WantedServeState;
  readonly observed: ObservedServeState;
  readonly crashTimes: readonly number[];
  readonly backoffMs: number;
  readonly retryAt: number | undefined;
  readonly stopRequested: boolean;
}

export class ManagedServe {
  readonly #state: ManagedServeState;

  private constructor(state: ManagedServeState) {
    this.#state = state;
  }

  static create(
    id: ServeId,
    policy: ManagedServePolicy = DEFAULT_MANAGED_SERVE_POLICY,
  ): ManagedServe {
    const checkedId = id.kind === "root" ? ROOT_SERVE : workspaceServe(id.name);
    return new ManagedServe({
      id: checkedId,
      policy: parseManagedServePolicy(policy),
      wanted: "running",
      observed: "stopped",
      crashTimes: [],
      backoffMs: 0,
      retryAt: undefined,
      stopRequested: false,
    });
  }

  get id(): ServeId {
    return this.#state.id;
  }

  get policy(): ManagedServePolicy {
    return this.#state.policy;
  }

  get wanted(): WantedServeState {
    return this.#state.wanted;
  }

  get observed(): ObservedServeState {
    return this.#state.observed;
  }

  get crashCount(): number {
    return this.#state.crashTimes.length;
  }

  get backoffMs(): number {
    return this.#state.backoffMs;
  }

  get retryAt(): number | undefined {
    return this.#state.retryAt;
  }

  /** A stopping child still reads as starting or ready until it exits. */
  get stopRequested(): boolean {
    return this.#state.stopRequested;
  }

  get childLive(): boolean {
    return this.observed === "starting" || this.observed === "ready";
  }

  step(event: ManagedServeEvent, now: number): ManagedServeStep {
    switch (event.kind) {
      case "wanted":
        return this.#onWanted(event.wanted);
      case "resume":
        return this.#onResume();
      case "ready":
        return this.#onReady();
      case "exited":
        return this.#onExited(event.code, now);
      case "tick":
        return this.#onTick(now);
    }
  }

  // deleted is final in HostedWorkspace, which refuses a later change; the
  // entity does not enforce it
  #onWanted(wanted: WantedServeState): ManagedServeStep {
    const next = this.#with({ wanted });
    if (next.observed === "failed") return next.#wait();
    if (wanted === "running") {
      return next.observed === "stopped" ? next.#spawn() : next.#wait();
    }
    if (next.childLive) {
      return next.stopRequested ? next.#wait() : {
        next: next.#with({ stopRequested: true }),
        action: { kind: "stop" },
      };
    }
    if (next.observed === "backoff") {
      return next.#with({ observed: "stopped", retryAt: undefined }).#wait();
    }
    return next.#wait();
  }

  #onResume(): ManagedServeStep {
    if (this.observed !== "failed") return this.#onWanted("running");
    return this.#with({
      wanted: "running",
      crashTimes: [],
      backoffMs: 0,
    }).#spawn();
  }

  #onReady(): ManagedServeStep {
    if (this.observed !== "starting") return this.#wait();
    return this.#with({ observed: "ready" }).#wait();
  }

  #onExited(code: number | null, now: number): ManagedServeStep {
    if (!this.childLive) return this.#wait();
    if (this.stopRequested) {
      const stopped = this.#with({
        observed: "stopped",
        stopRequested: false,
        retryAt: undefined,
      });
      return stopped.wanted === "running" ? stopped.#spawn() : stopped.#wait();
    }
    const { policy } = this;
    if (code === SAFE_RESTART_EXIT_CODE) {
      return this.#with({
        observed: "backoff",
        retryAt: now + policy.restartDelayMs,
      }).#wait();
    }
    // a crash dated after now is kept, so a clock stepping back cannot let
    // the list outgrow maxCrashesInWindow
    const crashTimes = [
      ...this.#state.crashTimes.filter((t) => now - t < policy.crashWindowMs),
      now,
    ];
    if (crashTimes.length >= policy.maxCrashesInWindow) {
      return this.#with({
        observed: "failed",
        crashTimes,
        retryAt: undefined,
      }).#wait();
    }
    const backoffMs = Math.min(
      policy.initialBackoffMs * 2 ** (crashTimes.length - 1),
      policy.maxBackoffMs,
    );
    return this.#with({
      observed: "backoff",
      crashTimes,
      backoffMs,
      retryAt: now + backoffMs,
    }).#wait();
  }

  #onTick(now: number): ManagedServeStep {
    if (this.wanted !== "running") return this.#wait();
    if (this.observed === "stopped") return this.#spawn();
    if (
      this.observed === "backoff" && this.retryAt !== undefined &&
      now >= this.retryAt
    ) {
      return this.#spawn();
    }
    return this.#wait();
  }

  #spawn(): ManagedServeStep {
    return {
      next: this.#with({
        observed: "starting",
        retryAt: undefined,
        stopRequested: false,
      }),
      action: { kind: "spawn" },
    };
  }

  #wait(): ManagedServeStep {
    const until = this.observed === "backoff" ? this.retryAt : undefined;
    return {
      next: this,
      action: until === undefined ? { kind: "wait" } : { kind: "wait", until },
    };
  }

  #with(changes: Partial<ManagedServeState>): ManagedServe {
    return new ManagedServe({ ...this.#state, ...changes });
  }
}
