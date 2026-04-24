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
 * The message lists every available remedy inline — tune the timeout via
 * `--timeout` or the `SWAMP_DATASTORE_SYNC_TIMEOUT_MS` env var, update the
 * datastore extension (the s3/gcs fingerprint fast path short-circuits
 * zero-diff syncs), or release a stuck lock — so users get actionable
 * next steps without needing to chase docs. Version-free wording keeps
 * the message stable across extension releases.
 *
 * Extends `UserError` so the message renders clean (no stack trace) at
 * the CLI error boundary — the message is already hand-crafted to be
 * actionable, and a stack would bury the remedies.
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
      `${timeoutMs}ms. Try one of:\n` +
      `  • Set SWAMP_DATASTORE_SYNC_TIMEOUT_MS for the duration of your ` +
      `shell session — applies to every command that triggers sync, ` +
      `including the implicit pull/push around write commands.\n` +
      `  • If the timeout fired on an explicit 'swamp datastore sync', ` +
      `rerun with --timeout <seconds> (e.g. --timeout 1800 for large ` +
      `one-off syncs). The flag is not available on other commands; use ` +
      `the env var above for those.\n` +
      `  • If you are on @swamp/s3-datastore or @swamp/gcs-datastore at ` +
      `scale, update to the latest extension — the fingerprint fast path ` +
      `short-circuits zero-diff syncs.\n` +
      `  • If a prior process crashed without releasing the lock, run ` +
      `'swamp datastore lock release --force' (add --model <type>/<id> ` +
      `for a specific model lock).`;
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
