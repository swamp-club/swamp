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

import { withRunPhase } from "../../domain/remote/run_progress.ts";
import {
  type DatastoreSyncService,
  DEFAULT_SYNC_TIMEOUT_MS,
  type LockScope,
  slowLockAdvice,
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

export interface RegisterDatastoreSyncOptions {
  service?: DatastoreSyncService;
  lock?: DistributedLock;
  label?: string;
  syncTimeoutMs?: number;
  metadataOnly?: boolean;
  namespace?: string;
  slowLockScope?: SlowLockScope;
  /** stops the lock wait; an aborted wait registers nothing */
  signal?: AbortSignal;
}

export interface SlowLockScope {
  scope: LockScope;
  shareable: boolean;
}

/** contains no brace so it can be appended to a LogTape template */
export const SLOW_LOCK_NAMESPACE_ADVICE =
  "if multiple repos share this datastore without namespaces, all writes " +
  "serialize behind a single lock. Run 'swamp datastore namespace set " +
  "<name>' to scope each repo to its own lock and index";

/** contains no brace so it can be appended to a LogTape template */
export const SLOW_LOCK_MODEL_CONTENTION_ADVICE =
  "concurrent runs against one behavior instance take turns on its lock";

interface SyncEntry {
  service?: DatastoreSyncService;
  lock?: DistributedLock;
  label: string;
  syncTimeoutMs: number;
  namespace?: string;
}

export const GLOBAL_LOCK_KEY = "__global__";

const PROGRESS_LOG_INTERVAL_MS = 30_000;

const entries: Map<string, SyncEntry> = new Map();
let shutdownHandle: ShutdownHandlerHandle | null = null;

/**
 * SIGINT only: this fast path runs on Ctrl-C and exits 130 after a 5s
 * force-exit deadline; SIGTERM and SIGHUP are handled by command-level shutdown
 */
function installSignalHandler(): void {
  if (shutdownHandle) return;

  shutdownHandle = registerShutdownHandler({
    handler: releaseLocksOnInterrupt,
    includePosixSignals: false,
  });
}

/**
 * for a forced exit that skips the command's teardown, so a remote lock or
 * lease is not left held until its TTL; bounded by waitMs
 */
export async function releaseRegisteredLocks(waitMs = 2_000): Promise<void> {
  const releases = [...entries.values()]
    .filter((e) => e.lock)
    .map((e) => e.lock!.release().catch(() => {}));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, waitMs);
  });
  try {
    await Promise.race([Promise.all(releases), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * a command that owns shutdown releases its locks in its own teardown, so
 * under suppressSyncExitOnSignal this does nothing: releasing here would hand
 * an in-flight method's lock to a waiter
 */
export function releaseLocksOnInterrupt(): void {
  if (suppressCount > 0) return;
  const forceExit = setTimeout(() => Deno.exit(130), 5_000);
  const releases = [...entries.values()]
    .filter((e) => e.lock)
    .map((e) => e.lock!.release().catch(() => {}));
  Promise.all(releases).finally(() => {
    clearTimeout(forceExit);
    if (suppressCount === 0) {
      Deno.exit(130);
    }
  });
}

function maybeRemoveSignalHandler(): void {
  if (entries.size > 0 || !shutdownHandle) return;
  shutdownHandle.dispose();
  shutdownHandle = null;
}

let suppressCount = 0;

/**
 * reference-counted: the first dispose does not re-enable exit while another
 * caller still suppresses it
 */
export function suppressSyncExitOnSignal(): { dispose(): void } {
  suppressCount++;
  let disposed = false;
  return {
    dispose() {
      if (!disposed) {
        disposed = true;
        suppressCount--;
      }
    },
  };
}

/**
 * one controller aborts the extension signal and rejects the race, so a
 * non-compliant extension cannot block past the deadline; core never calls
 * extension sync unbounded
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
    // invoke op inside the try so a synchronous throw still reaches the finally
    // that clears the timer and interval
    const opPromise = Promise.resolve().then(() => op(controller.signal));
    // absorb the losing branch's late rejection so it is not reported as
    // unhandled
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
      // when the deadline fired, prefer SyncTimeoutError over the extension's
      // own rejection, which can win on listener ordering; users need the
      // force-release hint
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

function logSlowLock(
  logger: ReturnType<typeof getSwampLogger>,
  lockMs: number,
  { scope, shareable }: SlowLockScope,
  namespace: string | undefined,
): void {
  const advice = slowLockAdvice({
    waitedMs: lockMs,
    scope,
    shareable,
    namespace,
  });
  if (advice === "namespace") {
    logger.warn(
      `Lock acquisition took {ms}ms — ${SLOW_LOCK_NAMESPACE_ADVICE}`,
      { ms: lockMs },
    );
  } else if (advice === "model-contention" && scope.kind === "model") {
    logger.warn(
      `Lock on behavior {model} took {ms}ms — ${SLOW_LOCK_MODEL_CONTENTION_ADVICE}`,
      { model: `${scope.modelType}/${scope.modelId}`, ms: lockMs },
    );
  }
}

export async function registerDatastoreSync(
  options: RegisterDatastoreSyncOptions,
): Promise<void> {
  await registerDatastoreSyncNamed(GLOBAL_LOCK_KEY, options);
}

export async function registerDatastoreSyncNamed(
  key: string,
  options: RegisterDatastoreSyncOptions,
): Promise<void> {
  const { service, lock, metadataOnly, namespace } = options;
  const label = options.label ?? "datastore";
  const syncTimeoutMs = options.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
  const entry: SyncEntry = { service, lock, label, syncTimeoutMs, namespace };
  entries.set(key, entry);

  // unwind on failure: the outer error handler flushes without try/catch, so an
  // orphaned entry would push to the same hung service and shadow the original
  // error with a second timeout
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

  if (lock) {
    const logger = getSwampLogger(["datastore", "lock"]);
    logger.debug("Acquiring lock for {label}", { label });
    const lockSpan = getTracer().startSpan("swamp.lock.acquire", {
      attributes: { "lock.key": key, "lock.label": label },
    });
    try {
      const lockStart = Date.now();
      await withRunPhase(
        "waiting_for_lock",
        { resource: key },
        () => lock.acquire(options.signal),
      );
      const lockMs = Date.now() - lockStart;
      if (options.slowLockScope) {
        logSlowLock(logger, lockMs, options.slowLockScope, namespace);
      }
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
        (signal) =>
          service.pullChanged({
            signal,
            ...(metadataOnly ? { metadataOnly } : {}),
            ...(namespace ? { namespace } : {}),
          }),
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
      // SyncTimeoutError renders cleanly as a UserError: do not log it here or
      // rewrap it
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
 * a failing flush must not stop the loop, so every lock is released; the first
 * error is rethrown afterwards, preferring SyncTimeoutError
 */
export async function flushDatastoreSync(): Promise<void> {
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
 * push errors warn-downgrade so a transient blip does not abort the run, but
 * SyncTimeoutError propagates: a timeout means data did not reach the remote
 * and needs a non-zero exit
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
        (signal) =>
          service.pushChanged({
            signal,
            ...(entry.namespace ? { namespace: entry.namespace } : {}),
          }),
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
      // timeouts propagate for a non-zero exit while other push errors warn; a
      // timeout is not logged here because the top-level renderError shows it
      // and logging would double the output
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

export function getRegisteredLockKeys(): string[] {
  return [...entries.keys()];
}
