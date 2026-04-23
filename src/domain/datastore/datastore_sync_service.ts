// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

/** Options accepted by sync service methods. */
export interface DatastoreSyncOptions {
  /**
   * Signal the caller uses to bound how long the sync may run. Extensions
   * that honor this signal should abort in-flight work when it fires and
   * reject with an error whose `name` is `"AbortError"` (or equivalent).
   * Optional — extensions that ignore the signal remain correct, but swamp
   * core will still enforce a hard deadline via `Promise.race` in the
   * coordinator, so unbounded extensions do not block the CLI indefinitely.
   */
  signal?: AbortSignal;
}

/**
 * Interface for datastore synchronization services.
 *
 * Extension datastores implement this interface to provide
 * bidirectional sync between a local cache and a remote backend.
 */
export interface DatastoreSyncService {
  /** Pull changed files from the remote datastore to the local cache. */
  pullChanged(options?: DatastoreSyncOptions): Promise<number | void>;
  /** Push changed files from the local cache to the remote datastore. */
  pushChanged(options?: DatastoreSyncOptions): Promise<number | void>;
}

/** Direction of a sync operation. */
export type SyncDirection = "push" | "pull";

/**
 * Thrown when a datastore sync operation exceeds the configured timeout.
 *
 * Raised by the coordinator's hard `Promise.race` deadline, so it fires
 * regardless of whether the underlying extension honored the `AbortSignal`.
 * The message includes the actionable escape hatch for the most common
 * root cause — a stuck datastore lock left behind by a prior crashed run.
 *
 * Extends `UserError` so the message renders clean (no stack trace) at
 * the CLI error boundary — the message is already hand-crafted to be
 * actionable, and a stack would bury the escape hatch.
 */
export class SyncTimeoutError extends UserError {
  readonly label: string;
  readonly direction: SyncDirection;
  readonly timeoutMs: number;
  override readonly cause?: unknown;

  constructor(
    label: string,
    direction: SyncDirection,
    timeoutMs: number,
    options?: { cause?: unknown },
  ) {
    const msg = `Datastore ${direction} to "${label}" timed out after ` +
      `${timeoutMs}ms. If a prior process crashed without releasing the ` +
      `lock, run 'swamp datastore lock release --force' (add ` +
      `--model <type>/<id> for a specific model lock).`;
    super(msg);
    this.name = "SyncTimeoutError";
    this.label = label;
    this.direction = direction;
    this.timeoutMs = timeoutMs;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}
