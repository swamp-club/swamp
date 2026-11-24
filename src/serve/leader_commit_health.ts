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

import { MAX_OUTAGE_CAUSE_DEPTH } from "../infrastructure/datastore_v3/datastore_outage.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { LitestreamControlError } from "../infrastructure/datastore_v3/litestream/litestream_control_client.ts";

const logger = getSwampLogger(["serve", "leadership"]);

/** what a leader that cannot commit names on /ready; never the raw error */
export type CannotCommitCause =
  | "storage_full"
  | "storage_io_error"
  | "storage_read_only";

/** storage failures in a row, spanning the window, before a leader steps down */
export const CANNOT_COMMIT_FAILURES = 3;
export const CANNOT_COMMIT_WINDOW_MS = 10_000;

const SQLITE_READONLY = 8;
const SQLITE_IOERR = 10;
const SQLITE_FULL = 13;

/** extended codes that name memory, locking, recovery or a moved file, not the storage */
const SQLITE_NOT_STORAGE: ReadonlySet<number> = new Set([
  3082, // SQLITE_IOERR_NOMEM
  3850, // SQLITE_IOERR_LOCK
  2314, // SQLITE_IOERR_RDLOCK
  2058, // SQLITE_IOERR_UNLOCK
  3594, // SQLITE_IOERR_CHECKRESERVEDLOCK
  5130, // SQLITE_IOERR_SHMLOCK
  5898, // SQLITE_IOERR_DELETE_NOENT
  264, // SQLITE_READONLY_RECOVERY
  520, // SQLITE_READONLY_CANTLOCK
  1032, // SQLITE_READONLY_DBMOVED
]);

const CODE_CAUSES: ReadonlyMap<string, CannotCommitCause> = new Map([
  ["ENOSPC", "storage_full"],
  ["EDQUOT", "storage_full"],
  ["EIO", "storage_io_error"],
  ["EROFS", "storage_read_only"],
]);

/**
 * The sidecar's own failure, writing its files on this node; a bucket or
 * network failure names none of these, and every node shares it.
 */
const SIDECAR_STORAGE_CAUSES: readonly [RegExp, CannotCommitCause][] = [
  [/no space left on device|disk quota exceeded/i, "storage_full"],
  [/input\/output error/i, "storage_io_error"],
  [/read-only file system/i, "storage_read_only"],
];

function causeOfOne(error: object): CannotCommitCause | undefined {
  if (error instanceof LitestreamControlError) {
    const reported = error.sidecarError;
    if (reported === undefined) return undefined;
    for (const [pattern, cause] of SIDECAR_STORAGE_CAUSES) {
      if (pattern.test(reported)) return cause;
    }
    return undefined;
  }
  const e = error as Record<string, unknown>;
  if (typeof e.errcode === "number") {
    if (SQLITE_NOT_STORAGE.has(e.errcode)) return undefined;
    // extended result codes keep the primary code in the low byte
    switch (e.errcode & 0xff) {
      case SQLITE_FULL:
        return "storage_full";
      case SQLITE_IOERR:
        return "storage_io_error";
      case SQLITE_READONLY:
        return "storage_read_only";
    }
  }
  if (typeof e.code === "string") {
    const cause = CODE_CAUSES.get(e.code);
    if (cause !== undefined) return cause;
  }
  return undefined;
}

/** read from SQLite's and the OS's codes, never a message: a refusal's message can carry a client's record key */
export function storageFailureCause(
  error: unknown,
): CannotCommitCause | undefined {
  let current = error;
  for (let depth = 0; depth < MAX_OUTAGE_CAUSE_DEPTH; depth++) {
    if (current === null || typeof current !== "object") return undefined;
    const cause = causeOfOne(current);
    if (cause !== undefined) return cause;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export interface CannotCommit {
  readonly cause: CannotCommitCause;
  readonly failures: number;
  readonly sinceMs: number;
  /** the failure that tripped it, for the log only */
  readonly error: unknown;
}

/** what the datastore API reports to and asks of the leader's commit health */
export interface CommitHealthPort {
  recordSuccess(): void;
  recordFailure(error: unknown): void;
  cannotCommit(): CannotCommit | undefined;
}

export interface LeaderCommitHealthOptions {
  readonly failures?: number;
  readonly windowMs?: number;
  readonly now?: () => number;
}

/**
 * Trips once storage failures run unbroken for the count and the window, so
 * one incident, or a burst of commits failing together, never does. A trip
 * lasts for the process: the node steps down and restarts.
 */
export class LeaderCommitHealth implements CommitHealthPort {
  readonly #failures: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #counted = new WeakSet<object>();
  readonly #listeners = new Set<(state: CannotCommit) => void>();
  #run:
    | { count: number; firstAt: number; cause: CannotCommitCause }
    | undefined;
  #tripped: CannotCommit | undefined;

  constructor(options: LeaderCommitHealthOptions = {}) {
    this.#failures = options.failures ?? CANNOT_COMMIT_FAILURES;
    this.#windowMs = options.windowMs ?? CANNOT_COMMIT_WINDOW_MS;
    this.#now = options.now ?? Date.now;
  }

  cannotCommit(): CannotCommit | undefined {
    return this.#tripped;
  }

  recordSuccess(): void {
    if (this.#tripped === undefined) this.#run = undefined;
  }

  /** anything but a storage failure neither counts nor resets */
  recordFailure(error: unknown): void {
    if (this.#tripped !== undefined) return;
    const cause = storageFailureCause(error);
    if (cause === undefined) return;
    // one failure seen by both the datastore and the request that carried it
    if (this.#seen(error)) return;
    const now = this.#now();
    const run = this.#run ?? { count: 0, firstAt: now, cause };
    run.count++;
    this.#run = run;
    if (run.count < this.#failures || now - run.firstAt < this.#windowMs) {
      return;
    }
    const tripped = {
      cause: run.cause,
      failures: run.count,
      sinceMs: now - run.firstAt,
      error,
    };
    this.#tripped = tripped;
    for (const listener of [...this.#listeners]) listener(tripped);
  }

  onCannotCommit(listener: (state: CannotCommit) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #seen(error: unknown): boolean {
    const chain: object[] = [];
    let current = error;
    for (let depth = 0; depth < MAX_OUTAGE_CAUSE_DEPTH; depth++) {
      if (current === null || typeof current !== "object") break;
      if (this.#counted.has(current)) return true;
      chain.push(current);
      current = (current as { cause?: unknown }).cause;
    }
    for (const link of chain) this.#counted.add(link);
    return false;
  }
}

const CAUSE_PHRASES: Readonly<Record<CannotCommitCause, string>> = {
  storage_full: "this node's storage is full",
  storage_io_error: "this node's storage reports I/O errors",
  storage_read_only: "this node's storage is read-only",
};

/** names the class of cause only: /ready answers anyone */
export function leaderUnreadyReason(state: CannotCommit): string {
  return `commits failed ${state.failures} times in a row over ${
    Math.round(state.sinceMs / 1000)
  }s: ${CAUSE_PHRASES[state.cause]}`;
}

export type CommitOutcomeEvent =
  | { readonly kind: "applied" }
  | { readonly kind: "failed"; readonly error: unknown };

export interface LeaderCommitHealthWiring {
  readonly datastorePath: string;
  leads(): boolean;
  /** every v3 commit outcome in the process, any datastore's */
  onCommitOutcome(
    listener: (datastorePath: string, outcome: CommitOutcomeEvent) => void,
  ): () => void;
  /** the lease then lapses at its TTL */
  stopRenewal(): Promise<void>;
  /** as a lost lead does: shut down, release the lease, restart as a follower */
  stepDown(): Promise<void>;
  readonly health?: LeaderCommitHealth;
}

export interface WiredLeaderCommitHealth {
  readonly port: CommitHealthPort;
  /** settles once a step-down this started has finished; never rejects */
  steppedDown(): Promise<void>;
  stop(): void;
}

/** only the leader's own commits count, and a trip steps down once */
export function wireLeaderCommitHealth(
  wiring: LeaderCommitHealthWiring,
): WiredLeaderCommitHealth {
  const health = wiring.health ?? new LeaderCommitHealth();
  const port: CommitHealthPort = {
    recordSuccess: () => {
      if (wiring.leads()) health.recordSuccess();
    },
    recordFailure: (error) => {
      if (wiring.leads()) health.recordFailure(error);
    },
    cannotCommit: () => health.cannotCommit(),
  };
  const stopOutcomes = wiring.onCommitOutcome((path, outcome) => {
    if (path !== wiring.datastorePath) return;
    if (outcome.kind === "applied") port.recordSuccess();
    else port.recordFailure(outcome.error);
  });
  let steppingDown: Promise<void> | undefined;
  const stopTrip = health.onCannotCommit((state) => {
    logger.error`This serve node cannot commit (${
      leaderUnreadyReason(state)
    }): it stops renewing the datastore's writer lease and steps down, to start again as a follower. Last failure: ${state.error}`;
    steppingDown ??= (async () => {
      await wiring.stopRenewal();
      await wiring.stepDown();
    })().catch((error) => {
      logger.error`Stepping down after failing to commit failed: ${error}`;
    });
  });
  return {
    port,
    steppedDown: () => steppingDown ?? Promise.resolve(),
    stop: () => {
      stopOutcomes();
      stopTrip();
    },
  };
}
