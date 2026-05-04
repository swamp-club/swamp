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
  /**
   * Cache-relative path of the file about to be written or removed.
   * Optional — omitted when core can't attribute the dirty signal to a
   * single path (bulk mutations like `rename` or non-dry-run
   * `collectGarbage`). Sync services that track per-path dirty state
   * SHOULD treat absence as "fall back to full walk on next pushChanged."
   *
   * Path is forward-slash-normalized regardless of host OS, matching the
   * cache-index key convention. Extensions consuming `relPath` for disk
   * access on Windows MUST convert to native separators (e.g. via
   * `@std/path` `join`) before `Deno.stat`/`Deno.readFile`/etc.
   *
   * Field scope: swamp core only sets this on `markDirty` calls. The
   * field has no defined meaning on `pullChanged` or `pushChanged` —
   * extensions can ignore it there. (It lives on the shared
   * `DatastoreSyncOptions` for source compatibility, not because pull
   * or push consume it.)
   */
  relPath?: string;
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
  /**
   * Signal that the local cache has uncommitted work.
   *
   * Must be called before (or immediately after) any write into the cache
   * directory that does not go through a sync-service method, so the next
   * `pushChanged` fast path cannot short-circuit past the write. Implementations
   * that cache a clean/dirty watermark (e.g. the s3/gcs zero-diff fast path
   * described in `design/datastores.md`) MUST invalidate the watermark here.
   * Implementations without a fast path MAY no-op.
   *
   * Implementations must be idempotent and cheap — swamp core calls this at
   * the start of every repository-layer mutation that writes into the cache,
   * and calls are not deduplicated. Called before the write begins so a crash
   * mid-write still leaves the watermark dirty.
   *
   * Contract — the load-bearing rules every implementer needs to honor:
   *
   * 1. **Pre-write timing.** Fires *before* the cache write begins.
   *    Extensions MUST NOT act synchronously on `options.relPath` — the
   *    file isn't on disk yet. Treat `relPath` as a hint to record for
   *    the next `pushChanged`.
   * 2. **Absence-on-disk = delete.** When `pushChanged` later consumes a
   *    recorded `relPath` and the file no longer exists in the cache, the
   *    extension SHOULD delete the corresponding remote record. This
   *    collapses create/update/delete into one signal — no separate
   *    op-kind needed.
   * 3. **`undefined` `relPath` = bulk.** A call without `relPath` signals
   *    a mutation core couldn't attribute to a single path. Extensions
   *    maintaining a per-path dirty set MUST honor this by either
   *    invalidating the set or flagging the next `pushChanged` for a
   *    full walk.
   * 4. **Process restart loses the set.** Extensions holding the dirty
   *    set in memory MUST fall back to a full walk on the first
   *    `pushChanged` after process start. Persisting the set to a
   *    sidecar is allowed but optional.
   * 5. **`relPath` is cache-relative**, relative to the directory
   *    returned by `DatastoreProvider.resolveCachePath`. Path is
   *    forward-slash-normalized; extensions consuming it for disk access
   *    on Windows MUST convert to native separators.
   * 6. **Backward compatibility.** `relPath` is optional; existing
   *    implementations (`@swamp/s3-datastore`, `@swamp/gcs-datastore`,
   *    filesystem no-op, every test mock) keep working unchanged because
   *    the old single-watermark pattern still satisfies the contract.
   * 7. **Field scope.** swamp core only sets `relPath` on `markDirty`
   *    calls. The field has no defined meaning on `pullChanged` or
   *    `pushChanged`.
   * 8. **Bulk overrides per-path within one operation.** Some core
   *    mutations emit a bulk signal AND one or more per-path signals
   *    from the same logical operation (e.g. `rename` calls the dirty
   *    hook upfront with no `relPath` for the tombstone + latest-marker
   *    writes that don't decompose, then its internal `save()` of the
   *    new name emits a per-path signal). Extensions MUST treat any
   *    bulk signal as overriding per-path signals from the same
   *    operation. Easiest implementation: keep both a `bulkInvalidated:
   *    boolean` flag and the dirty set; in `pushChanged`, fall back to
   *    a full walk when `bulkInvalidated` is true regardless of the
   *    set's contents.
   */
  markDirty(options?: DatastoreSyncOptions): Promise<void>;
}

/** Direction of a sync operation. */
export type SyncDirection = "push" | "pull";

/**
 * Callback invoked by repositories before they write into the datastore cache.
 *
 * Thin indirection over {@link DatastoreSyncService.markDirty} so repositories
 * do not need a handle on the full sync service (or to know whether one is
 * registered at all). Undefined when the repository is wired against a
 * datastore with no sync service (e.g. filesystem) — callers treat it as a
 * no-op.
 *
 * **Internal vs public contract.** Repositories pass an absolute path (or
 * `undefined` for bulk mutations) — they don't have the cache root in scope.
 * The composition root in `repo_context.ts` wraps this hook with a helper
 * that converts the absolute path to a forward-slash cache-relative string
 * and forwards it to {@link DatastoreSyncService.markDirty} via
 * {@link DatastoreSyncOptions.relPath}. The full contract (8 rules
 * including pre-write timing, absence-on-disk semantics, restart behavior)
 * is documented on `DatastoreSyncService.markDirty`.
 */
export type MarkDirtyHook = (relPath?: string) => Promise<void>;

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
