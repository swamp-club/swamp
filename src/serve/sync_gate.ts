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
 * Serve's in-process sync gate.
 *
 * Serve shares ONE `DatastoreSyncService` instance across its pollers, its
 * handlers and every run, and a datastore pull is not safe to overlap any
 * other sync call on that instance:
 *
 * - A handler mutation is a two-step unit — the local cache write or removal
 *   (which emits `markDirty`), then the `pushChanged` that commits it. The
 *   push decides delete-vs-upload by looking at the file on disk
 *   (`DatastoreSyncService.markDirty` rule 2), so a pull that downloads the
 *   item between those steps undoes the delete (swamp-club#2247).
 * - A pull prunes index entries whose objects were missing from a listing it
 *   took earlier. A run push that commits entries into the shared in-memory
 *   index while that listing is in flight gets its new entries pruned and
 *   CAS-removed from the remote index (swamp-club#2405).
 *
 * The gate is a read/write lock with two modes:
 *
 * - **Exclusive** — each handler mutation+push unit (whole handler, at its
 *   dispatch site in `connection.ts`), the server-token mint in
 *   `device_auth_handler.ts`, and each poller pull via {@link gatedPull}.
 * - **Shared** — every run push unit and step-start pull, via
 *   {@link withSharedSyncGate}: the per-step model-lock pull and flush
 *   (`acquireModelLocks` `wrapSync`), and the post-run / post-resume pushes.
 *   Shared holders exclude pulls and handler mutations but not each other,
 *   so fan-out workflows keep their parallel uploads.
 *
 * Pollers acquire opportunistically (see {@link gatedPull}), so runs never
 * queue behind a waiting poller except during a bounded escalation. Handler
 * mutation units, being exclusive, do wait for in-flight run push units.
 *
 * The gate is NOT reentrant: acquiring it from inside an exclusively gated
 * handler self-deadlocks until {@link GATE_WAIT_TIMEOUT_MS}. The fitness test
 * in `integration/serve_deps_rules_test.ts` forbids a dispatch-gated handler
 * from taking the shared mode. Lock order: a run takes its model lock before
 * the gate, never the reverse — which is safe only because no gate holder
 * ever waits on a model lock.
 *
 * Scope limits, documented in `design/enablers/datastores.md`: the gate is
 * in-process only (it gives no guarantee between HA peers); a run's own
 * version GC can still be resurrected by a poll landing between the local
 * delete and the run's push; and a request cancelled while queued on the
 * gate still performs its mutation before reporting `cancelled` — the cancel
 * signal is deliberately not passed to the acquisition, because a rejected
 * acquisition would leave the client with no response frame.
 */

import { ReadWriteLock } from "../infrastructure/stream/read_write_lock.ts";
import { runBoundedSync } from "../infrastructure/persistence/datastore_sync_coordinator.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "sync-gate"]);

/**
 * Read/write gate shared by serve's pollers, handlers and runs. FIFO among
 * queued acquirers, so a queued exclusive acquirer cannot be starved.
 */
export type SyncGate = ReadWriteLock;

/** Creates the single gate a serve process shares across pollers and handlers. */
export function createSyncGate(): SyncGate {
  return new ReadWriteLock();
}

/**
 * Hard deadline for a poller pull, passed to `runBoundedSync` so the gate is
 * released even when an extension ignores the AbortSignal.
 *
 * Deliberately BELOW {@link GATE_WAIT_TIMEOUT_MS}: a handler waiting behind a
 * pull that is merely slow must get the gate before its own wait expires,
 * because an expired handler wait proceeds ungated and reopens the race the
 * gate exists to close. Change one of these two constants and you must
 * change the other.
 */
export const POLLER_PULL_TIMEOUT_MS = 120_000;

/**
 * How long a handler mutation or run push unit waits for the gate before
 * proceeding WITHOUT it, and how long an escalated poller waits before
 * skipping.
 *
 * Serve has no per-request timeout (`MAX_ACTIVE_REQUESTS` is the only
 * backstop), so a wedged gate holder would otherwise stall every mutation,
 * every run and all three pollers indefinitely. Degrading a mutation or push
 * to ungated is no worse than the pre-gate behaviour; a poller never
 * degrades, it skips. Must stay ABOVE {@link POLLER_PULL_TIMEOUT_MS} — see
 * that constant.
 */
export const GATE_WAIT_TIMEOUT_MS = 150_000;

/**
 * Consecutive skipped cycles after which a poller stops acquiring
 * opportunistically and queues for the gate, so a steady stream of run
 * pushes can delay a poller but never starve it.
 */
export const POLLER_ESCALATE_AFTER_SKIPS = 3;

/** Upper bound on the opportunistic retry period, reached at a 30s interval. */
export const POLLER_RETRY_MS = 1_000;

/** How a poller times its opportunistic gate acquisition. */
export interface PollerGateTiming {
  /** Delay between `tryAcquire` attempts. */
  retryMs: number;
  /** How long to keep retrying before skipping the cycle. */
  windowMs: number;
}

/**
 * Derives a poller's opportunistic timing from its poll interval: retry up
 * to every second, for five sixths of the interval (25s at the default 30s),
 * so a cycle always finishes before the next tick is due.
 */
export function pollerGateTiming(pollIntervalMs: number): PollerGateTiming {
  const windowMs = Math.max(1, Math.floor((pollIntervalMs * 5) / 6));
  const retryMs = Math.max(
    1,
    Math.min(POLLER_RETRY_MS, Math.floor(pollIntervalMs / 30)),
  );
  return { retryMs, windowMs };
}

/**
 * Request types whose handler mutates the local cache and pushes, and so must
 * run as one unit under the gate. Derived from the `pushChanged` /
 * `pushChangedToRemote` call sites in `src/serve/handlers/` — the fitness test
 * in `integration/serve_deps_rules_test.ts` pins the correspondence so a new
 * pushing handler cannot be added without gating it.
 *
 * `vault.put` is absent on purpose: `acquireVaultSync`'s flush is a documented
 * no-op because vault secrets live in always-local `.swamp/secrets` and never
 * enter the datastore.
 */
export const SYNC_GATED_REQUESTS: ReadonlySet<string> = new Set([
  "access.reload",
  "access.token.mint",
  "access.token.revoke",
  "access.token.rotate",
  "data.delete",
  "data.gc",
  "data.prune",
  "data.rename",
  "extension.install",
  "extension.pull",
  "extension.rm",
  "extension.update",
  "model.create",
  "model.delete",
  "model.edit",
  "run.gc",
  "vault.annotate",
  "vault.create",
  "vault.delete",
  "vault.edit",
  "vault.migrate",
  "worker.prune",
  "worker.token.create",
  "worker.token.revoke",
  "workflow.approve",
  "workflow.create",
  "workflow.delete",
  "workflow.edit",
  "workflow.reject",
]);

/**
 * Functions that push without taking the gate in either mode, and why.
 * Pinned so the fitness test can tell a deliberate exemption from a
 * forgotten one. Run paths are not listed: they push under the shared mode.
 */
export const UNGATED_PUSH_HANDLERS: ReadonlySet<string> = new Set([
  // Startup hydration, before the pollers, the scheduler or the listener
  // start — nothing can overlap it.
  "hydrateLocalCache",
  // The gate's own plumbing: this helper contains the pushChanged call every
  // gated handler routes through.
  "pushChangedToRemote",
]);

type GateMode = "exclusive" | "shared";

/**
 * Runs `fn` holding the sync gate exclusively, releasing it however `fn`
 * settles. Used for handler mutation units.
 *
 * Takes the gate rather than the whole `ConnectionContext` so `shared.ts` can
 * declare the field without importing this module's runtime. With no gate
 * wired (filesystem datastores, unit tests) it returns `fn()` directly — same
 * promise, no extra microtask, so timing is unchanged where there is nothing
 * to race.
 */
export function withSyncGate<T>(
  gate: SyncGate | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!gate) return fn();
  return runGated(gate, "exclusive", fn);
}

/**
 * Runs `fn` holding the sync gate in shared mode. Used for run push units and
 * step-start pulls: they exclude pulls and handler mutations, but run
 * alongside each other.
 *
 * Must never be called from inside an exclusively gated handler — the gate is
 * not reentrant. With no gate wired it returns `fn()` directly.
 */
export function withSharedSyncGate<T>(
  gate: SyncGate | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!gate) return fn();
  return runGated(gate, "shared", fn);
}

async function runGated<T>(
  gate: SyncGate,
  mode: GateMode,
  fn: () => Promise<T>,
): Promise<T> {
  let held = false;
  // Hand-rolled rather than AbortSignal.timeout: that timer is ref'd and
  // would hold the event loop open for the full wait on every mutation,
  // delaying process exit and tripping the test timer sanitizer.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    GATE_WAIT_TIMEOUT_MS,
  );
  Deno.unrefTimer(timer);
  try {
    if (mode === "exclusive") await gate.acquire(controller.signal);
    else await gate.acquireShared(controller.signal);
    held = true;
  } catch {
    // Degraded, not failed: a wedged holder must not take the server with it.
    const waitedSec = GATE_WAIT_TIMEOUT_MS / 1000;
    logger
      .warn`Sync gate not acquired within ${waitedSec}s; proceeding without it — a concurrent datastore pull could undo this ${mode} sync`;
  }
  clearTimeout(timer);
  try {
    return await fn();
  } finally {
    if (held) {
      if (mode === "exclusive") gate.release();
      else gate.releaseShared();
    }
  }
}

/** Per-poller state that {@link gatedPull} carries across cycles. */
export interface PollerGateState {
  consecutiveSkips: number;
}

/** Options for {@link gatedPull}. */
export interface GatedPullOptions {
  /** The poller's cross-cycle state. Defaults to a fresh one. */
  state?: PollerGateState;
  /** Aborted by the poller's `stop()`: ends any wait at once, as a skip. */
  signal?: AbortSignal;
  /** Opportunistic timing. Defaults to {@link pollerGateTiming} for 30s. */
  timing?: PollerGateTiming;
  /** Delay between retries. Injectable so tests drive the retry loop. */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Runs a poller pull under the gate, hard-bounded by
 * {@link POLLER_PULL_TIMEOUT_MS}, or skips the cycle. A poller never pulls
 * ungated — a skipped poll only delays visibility by one interval.
 *
 * Acquisition is opportunistic, so a poller never makes runs wait:
 *
 * 1. `tryAcquire` — take the gate only when it is idle and nobody is queued.
 * 2. Retry every `timing.retryMs` for up to `timing.windowMs`, without
 *    holding a queue slot.
 * 3. Still busy: skip the cycle and count it.
 * 4. After {@link POLLER_ESCALATE_AFTER_SKIPS} consecutive skips, queue for
 *    the gate instead, bounded by {@link GATE_WAIT_TIMEOUT_MS}. This is the
 *    only time runs can wait on a poller, and only for as long as the push
 *    units already ahead of it. If even that wait expires, skip again.
 *
 * Acquiring the gate resets the skip count. `runBoundedSync` passes an
 * AbortSignal AND races a deadline, so the gate is released even when an
 * extension ignores the signal — otherwise one hung pull would stall every
 * mutation and run on the server.
 */
export async function gatedPull(
  gate: SyncGate | undefined,
  label: string,
  pull: (signal: AbortSignal) => Promise<number | void>,
  options: GatedPullOptions = {},
): Promise<number | void> {
  const runPull = () =>
    runBoundedSync(label, "pull", POLLER_PULL_TIMEOUT_MS, pull);
  if (!gate) return runPull();

  const state = options.state ?? { consecutiveSkips: 0 };
  const escalate = state.consecutiveSkips >= POLLER_ESCALATE_AFTER_SKIPS;
  if (escalate) {
    const skips = state.consecutiveSkips;
    logger
      .info`${label} queueing for the sync gate after ${skips} skipped cycles; run syncs wait behind it until it pulls`;
  }
  const acquired = escalate
    ? await acquireQueued(gate, options.signal)
    : await acquireOpportunistically(gate, options);

  if (!acquired) {
    if (options.signal?.aborted) return undefined;
    state.consecutiveSkips++;
    const skips = state.consecutiveSkips;
    logger
      .warn`${label} skipped: sync gate busy with datastore syncs (${skips} consecutive)`;
    return undefined;
  }

  state.consecutiveSkips = 0;
  try {
    return await runPull();
  } finally {
    gate.release();
  }
}

async function acquireOpportunistically(
  gate: SyncGate,
  options: GatedPullOptions,
): Promise<boolean> {
  const { retryMs, windowMs } = options.timing ?? pollerGateTiming(30_000);
  const delay = options.delay ?? unrefDelay;
  for (let waited = 0;; waited += retryMs) {
    if (options.signal?.aborted) return false;
    if (gate.tryAcquire()) return true;
    if (waited >= windowMs) return false;
    await delay(retryMs, options.signal);
  }
}

async function acquireQueued(
  gate: SyncGate,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATE_WAIT_TIMEOUT_MS);
  Deno.unrefTimer(timer);
  const onStop = () => controller.abort();
  signal?.addEventListener("abort", onStop, { once: true });
  try {
    if (signal?.aborted) return false;
    await gate.acquire(controller.signal);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onStop);
  }
}

/**
 * Resolves after `ms`, or at once when `signal` aborts. The timer is unref'd
 * so a poller retrying for the gate never holds the process open.
 */
function unrefDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    Deno.unrefTimer(timer);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
