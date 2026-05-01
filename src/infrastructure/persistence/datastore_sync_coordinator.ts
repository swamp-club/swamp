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

/**
 * Global datastore sync coordinator with distributed locking.
 *
 * Supports two modes:
 * - **Full sync** (S3 datastores): lock + pull → execute → push + unlock
 * - **Lock-only** (filesystem datastores): lock → execute → unlock
 *
 * Supports both global locking (structural commands) and per-model
 * locking (model method run). Uses a Map of named entries so multiple
 * independent locks can be held concurrently.
 *
 * Registered in requireInitializedRepo, flushed from runCli() after the
 * command completes.
 *
 * Each direction (push/pull) is bounded by a hard deadline — see
 * `runBoundedSync`. The deadline protects swamp from extensions that
 * never return (issue #157) by firing a `SyncTimeoutError` regardless
 * of whether the extension honored the AbortSignal.
 */

import {
  type DatastoreSyncService,
  DEFAULT_SYNC_TIMEOUT_MS,
  type SyncDirection,
  SyncTimeoutError,
} from "../../domain/datastore/mod.ts";
import type { DistributedLock } from "../../domain/datastore/distributed_lock.ts";
import { getSwampLogger } from "../logging/logger.ts";
import { getTracer, SpanStatusCode } from "../tracing/mod.ts";
import {
  registerShutdownHandler,
  type ShutdownHandlerHandle,
} from "../process/shutdown_handlers.ts";
import { summarizeSyncError } from "./sync_error_diagnostic.ts";

/** Options for registering a datastore sync lifecycle. */
export interface RegisterDatastoreSyncOptions {
  /** Sync service for pull/push operations. */
  service?: DatastoreSyncService;
  /** Distributed lock for concurrency control. */
  lock?: DistributedLock;
  /** Label for log messages (e.g. "S3", "custom"). Defaults to "datastore". */
  label?: string;
  /**
   * Hard deadline (ms) enforced on each direction of sync. Applies
   * independently to pull and push — not a combined budget. Falls back to
   * `DEFAULT_SYNC_TIMEOUT_MS` (5 minutes) when omitted. Ignored when no
   * service is registered.
   */
  syncTimeoutMs?: number;
}

/** Internal entry tracking a single lock/sync pair. */
interface SyncEntry {
  service?: DatastoreSyncService;
  lock?: DistributedLock;
  label: string;
  syncTimeoutMs: number;
}

/** Key used by the global (structural) lock. */
export const GLOBAL_LOCK_KEY = "__global__";

/** Interval at which long-running syncs emit a heartbeat log line. */
const PROGRESS_LOG_INTERVAL_MS = 30_000;

/** Map of all registered lock entries, keyed by lock name. */
const entries: Map<string, SyncEntry> = new Map();
let shutdownHandle: ShutdownHandlerHandle | null = null;

/**
 * Installs the SIGINT handler to release all held locks. SIGINT-only by
 * design: this fast-path handler runs on Ctrl-C and `Deno.exit(130)`s
 * after a 5s force-exit deadline. Long-form POSIX signals (SIGTERM,
 * SIGHUP) are handled by command-level shutdown logic, not here.
 */
function installSignalHandler(): void {
  if (shutdownHandle) return;

  shutdownHandle = registerShutdownHandler({
    handler: () => {
      const forceExit = setTimeout(() => Deno.exit(130), 5_000);
      const releases = [...entries.values()]
        .filter((e) => e.lock)
        .map((e) => e.lock!.release().catch(() => {}));
      Promise.all(releases).finally(() => {
        clearTimeout(forceExit);
        Deno.exit(130);
      });
    },
    includePosixSignals: false,
  });
}

/**
 * Removes the SIGINT handler if no entries remain.
 */
function maybeRemoveSignalHandler(): void {
  if (entries.size > 0 || !shutdownHandle) return;
  shutdownHandle.dispose();
  shutdownHandle = null;
}

/**
 * Runs a sync operation with a hard deadline.
 *
 * Single-AbortController design: one `setTimeout` fires
 * `controller.abort(SyncTimeoutError)`, which both (a) aborts the signal
 * passed to the extension so signal-compliant implementations can unwind
 * cleanly, and (b) rejects the race so non-compliant implementations do
 * not block the CLI beyond the deadline. One source of truth, no
 * ms-level drift between two independent timers.
 *
 * While the operation is in flight, a progress log fires every
 * {@link PROGRESS_LOG_INTERVAL_MS} so CI logs don't go silent during
 * long syncs. The interval is cleared in the `finally` so it never
 * outlives the operation.
 *
 * The losing branch of `Promise.race` gets a `.catch(() => {})` so its
 * delayed rejection does not surface as an unhandled rejection.
 *
 * Exported so other entry points into extension sync services (e.g.
 * `datastore setup` migration, `datastore sync` CLI) can apply the same
 * bound — swamp core should never call an extension sync method
 * unbounded, regardless of which code path reaches it.
 */
export async function runBoundedSync<T>(
  label: string,
  direction: SyncDirection,
  timeoutMs: number,
  op: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const logger = getSwampLogger(["datastore", "sync"]);
  const controller = new AbortController();
  const startedAt = Date.now();

  const timer = setTimeout(() => {
    controller.abort(new SyncTimeoutError(label, direction, timeoutMs));
  }, timeoutMs);

  const verb = direction === "push" ? "pushing" : "pulling";
  const preposition = direction === "push" ? "to" : "from";
  const progress = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const total = Math.round(timeoutMs / 1000);
    logger.info(
      `Still ${verb} ${preposition} {label} (elapsed {elapsed}s of {total}s timeout)`,
      { label, elapsed, total },
    );
  }, PROGRESS_LOG_INTERVAL_MS);

  try {
    // Invoke the op inside the try so a synchronous throw still hits the
    // `finally` that clears the timer and interval — otherwise a sync
    // throw leaks the timers.
    const opPromise = Promise.resolve().then(() => op(controller.signal));
    // Absorb late rejection from the losing branch of the race so the
    // delayed error (typically AbortError from the extension observing
    // signal.aborted) is not reported as an unhandled rejection.
    opPromise.catch(() => {});

    try {
      return await Promise.race([
        opPromise,
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(controller.signal.reason),
            { once: true },
          );
        }),
      ]);
    } catch (err) {
      // If the hard deadline fired, prefer the actionable SyncTimeoutError
      // over whatever the extension rejected with (e.g. a cooperative
      // AbortError from observing signal.aborted). The extension may have
      // rejected first due to microtask listener ordering, but users want
      // the force-release hint in the message.
      if (
        controller.signal.aborted &&
        controller.signal.reason instanceof SyncTimeoutError
      ) {
        throw controller.signal.reason;
      }
      throw err;
    }
  } finally {
    clearTimeout(timer);
    clearInterval(progress);
  }
}

/**
 * Registers the datastore sync lifecycle (global lock).
 *
 * - If `lock` is provided, acquires it and installs a SIGINT handler
 *   for best-effort release on Ctrl-C.
 * - If `service` is provided, pulls changed files from S3.
 * - Either can be used independently (lock-only for filesystem datastores,
 *   or service-only if no lock is needed).
 */
export async function registerDatastoreSync(
  options: RegisterDatastoreSyncOptions,
): Promise<void> {
  await registerDatastoreSyncNamed(GLOBAL_LOCK_KEY, options);
}

/**
 * Registers a named datastore sync lifecycle.
 *
 * Acquires the lock (if provided), pulls from S3 (if service provided),
 * and registers for cleanup on flush/SIGINT.
 */
export async function registerDatastoreSyncNamed(
  key: string,
  options: RegisterDatastoreSyncOptions,
): Promise<void> {
  const { service, lock } = options;
  const label = options.label ?? "datastore";
  const syncTimeoutMs = options.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
  const entry: SyncEntry = { service, lock, label, syncTimeoutMs };
  entries.set(key, entry);

  // Tracks what must be unwound if register fails. Critical: the outer
  // runCli() error handler calls flushDatastoreSync() in its catch block
  // (cli/mod.ts:1066) without try/catch, so an orphaned entry left here
  // would cause the error handler to invoke push on the same hung service
  // and throw again — shadowing the original error and doubling the
  // user-visible timeout wait. See swamp#1216 review (double-timeout bug).
  let lockAcquired = false;

  const unwindOnFailure = async () => {
    entries.delete(key);
    if (lockAcquired && lock) {
      try {
        await lock.release();
      } catch {
        // Best effort — lock expires via TTL if release fails.
      }
    }
    maybeRemoveSignalHandler();
  };

  // Acquire distributed lock if provided
  if (lock) {
    const lockSpan = getTracer().startSpan("swamp.lock.acquire", {
      attributes: { "lock.key": key, "lock.label": label },
    });
    try {
      await lock.acquire();
      lockAcquired = true;
      lockSpan.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      lockSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      await unwindOnFailure();
      throw error;
    } finally {
      lockSpan.end();
    }
    installSignalHandler();
  }

  // Pull changed files if a sync service is registered
  if (service) {
    const syncSpan = getTracer().startSpan("swamp.datastore.sync", {
      attributes: {
        "sync.direction": "pull",
        "sync.label": label,
        "sync.timeoutMs": syncTimeoutMs,
      },
    });
    const logger = getSwampLogger(["datastore", "sync"]);
    try {
      logger.info("Syncing from {label}...", { label });
      const pulled = await runBoundedSync(
        label,
        "pull",
        syncTimeoutMs,
        (signal) => service.pullChanged({ signal }),
      );
      if (pulled && pulled > 0) {
        syncSpan.setAttribute("sync.file_count", pulled);
        logger.info("Synced {count} file(s) from {label}", {
          count: pulled,
          label,
        });
      } else {
        logger.info("{label} sync complete, already up to date", { label });
      }
      syncSpan.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      const { summary, fields } = summarizeSyncError("pull", label, error);
      syncSpan.setStatus({ code: SpanStatusCode.ERROR, message: summary });
      await unwindOnFailure();
      // SyncTimeoutError renders cleanly at the top level (UserError); do
      // not log here and do not rewrap (a generic Error wrapper would lose
      // the clean render and double the output with stack trace).
      if (error instanceof SyncTimeoutError) {
        throw error;
      }
      logger.error("{summary}", { summary, ...fields });
      throw new Error(summary, { cause: error });
    } finally {
      syncSpan.end();
    }
  }
}

/**
 * Flushes the datastore sync lifecycle (global lock).
 *
 * - If a sync service is registered, pushes changed files to S3.
 * - Releases the distributed lock if held.
 * - Clears all references after flushing.
 *
 * If any individual flush throws (e.g. `SyncTimeoutError`), the loop still
 * completes the remaining entries so every lock gets released — otherwise a
 * single timeout would strand later entries with held locks, re-creating
 * the stuck-lock bug this coordinator was hardened against. Once all
 * entries settle, the first collected error is re-thrown, preferring a
 * `SyncTimeoutError` so the actionable message surfaces.
 */
export async function flushDatastoreSync(): Promise<void> {
  // Flush all entries (global + any per-model entries)
  const keys = [...entries.keys()];
  const errors: unknown[] = [];
  for (const key of keys) {
    try {
      await flushDatastoreSyncNamed(key);
    } catch (err) {
      errors.push(err);
    }
  }
  maybeRemoveSignalHandler();
  if (errors.length === 0) return;
  const timeout = errors.find((e): e is SyncTimeoutError =>
    e instanceof SyncTimeoutError
  );
  throw timeout ?? errors[0];
}

/**
 * Flushes a single named sync entry.
 *
 * Pushes to S3 if a service is registered, then releases the lock. Push
 * errors are normally warn-downgraded so a transient S3 blip does not
 * abort the CLI run — BUT `SyncTimeoutError` propagates. A timeout is
 * structurally different from a transient failure (retries mask one,
 * not the other), so the user must see a non-zero exit to know data did
 * not make it to the remote.
 */
export async function flushDatastoreSyncNamed(key: string): Promise<void> {
  const entry = entries.get(key);
  if (!entry) return;

  entries.delete(key);

  if (entry.service) {
    const syncSpan = getTracer().startSpan("swamp.datastore.sync", {
      attributes: {
        "sync.direction": "push",
        "sync.label": entry.label,
        "sync.timeoutMs": entry.syncTimeoutMs,
      },
    });
    const logger = getSwampLogger(["datastore", "sync"]);
    const label = entry.label;
    const service = entry.service;
    try {
      logger.info("Pushing changes to {label}...", { label });
      const pushed = await runBoundedSync(
        label,
        "push",
        entry.syncTimeoutMs,
        (signal) => service.pushChanged({ signal }),
      );
      if (pushed && pushed > 0) {
        syncSpan.setAttribute("sync.file_count", pushed);
        logger.info("Pushed {count} file(s) to {label}", {
          count: pushed,
          label,
        });
      } else {
        logger.info("{label} push complete, no changes", { label });
      }
      syncSpan.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      const { summary, fields } = summarizeSyncError("push", label, error);
      syncSpan.setStatus({ code: SpanStatusCode.ERROR, message: summary });
      // Asymmetric surface per issue #157: timeouts propagate so the user
      // sees a non-zero exit; other push errors warn-downgrade (preserves
      // historical behavior where a transient S3 blip doesn't kill a run).
      //
      // For timeouts we do NOT log here — the error propagates to the
      // top-level renderError which renders the message (SyncTimeoutError
      // extends UserError, so no stack). Logging here as well would double
      // the output with slightly different wording.
      if (error instanceof SyncTimeoutError) {
        if (entry.lock) {
          try {
            await entry.lock.release();
          } catch (releaseError) {
            logger.warn("Failed to release sync lock after timeout: {error}", {
              error: releaseError instanceof Error
                ? releaseError.message
                : String(releaseError),
            });
          }
        }
        maybeRemoveSignalHandler();
        throw error;
      }
      logger.warn("{summary}", { summary, ...fields });
    } finally {
      syncSpan.end();
    }
  }

  // Release distributed lock
  if (entry.lock) {
    try {
      await entry.lock.release();
    } catch (error) {
      const logger = getSwampLogger(["datastore", "sync"]);
      logger.warn("Failed to release sync lock: {error}", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  maybeRemoveSignalHandler();
}

/**
 * Returns all currently registered lock keys.
 */
export function getRegisteredLockKeys(): string[] {
  return [...entries.keys()];
}
