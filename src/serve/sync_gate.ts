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
 *   Shared holders exclude poller pulls and handler mutations. Within the
 *   shared mode, run pulls and run pushes are two lanes that exclude each
 *   other ({@link RunSyncLanes}, swamp-club#3146), so fan-out workflows keep
 *   their parallel uploads and step-start pulls run side by side, but a pull
 *   never lands inside another run's push. A model lock's last publish
 *   attempt, after other syncs undid the earlier ones, takes the exclusive
 *   mode instead ({@link withRunSyncGate}).
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
 * ever waits on a model lock. The datastore global lock always comes after
 * the gate: a run's flush takes it inside the shared gate (`wrapSync` wraps
 * the whole flush), and an extension handler takes it inside its exclusive
 * gate to change the shared extension lockfile (swamp-club#2838). Never
 * wait on the gate while holding the global lock.
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
import { type RunSyncLane, RunSyncLanes } from "./run_sync_lanes.ts";
import { runBoundedSync } from "../infrastructure/persistence/datastore_sync_coordinator.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { getTracer, SpanStatusCode } from "../infrastructure/tracing/mod.ts";
import { SyncTimeoutError } from "../domain/datastore/datastore_sync_service.ts";
import {
  diagnosticSpanAttributes,
  type PhaseTally,
  startDiagnosticPhase,
} from "../domain/diagnostics/diagnostic_phase.ts";

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
 * `workflow.cancel` is absent on purpose: it waits for an aborted run, which
 * needs the gate for its final push, so it gates only its persisted cancel
 * and push, not the whole handler. `cancelSuspendedRunAndPush` locates the
 * run and authorizes the caller before taking the gate, so an unknown or
 * refused run id never holds it (swamp-club#2648); only the reserve, re-read,
 * save and push run under it.
 *
 * `vault.put` is absent on purpose: `acquireVaultSync`'s flush is a documented
 * no-op because vault secrets live in always-local `.swamp/secrets` and never
 * enter the datastore. `vault.annotate` and `vault.delete` no longer push
 * either, for the same reason (swamp-club#2415); they stay gated only because
 * ungating them is a separate change. `vault.edit` pushes: it writes the vault
 * config, which is in the datastore's config tier under managedConfig
 * (swamp-club#2426).
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
  // gated handler routes through. Its callers take the gate: dispatch-gated
  // handlers at dispatch, run paths around the call (swamp-club#3035).
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
 * step-start pulls: they exclude poller pulls and handler mutations. Within
 * the shared mode, `lane` keeps run pulls and run pushes apart
 * ({@link RunSyncLanes}, swamp-club#3146): pushes run alongside pushes and
 * pulls alongside pulls, never a pull alongside a push. Run pushes are the
 * default; only a step-start pull passes `"pull"`.
 *
 * Must never be called from inside an exclusively gated handler — the gate is
 * not reentrant. With no gate wired it returns `fn()` directly.
 */
export function withSharedSyncGate<T>(
  gate: SyncGate | undefined,
  fn: () => Promise<T>,
  lane: RunSyncLane = "push",
): Promise<T> {
  if (!gate) return fn();
  return runGated(gate, "shared", () => inRunSyncLane(gate, lane, fn));
}

/**
 * The sync wrapper serve passes `acquireModelLocks` (its `wrapSync`): a
 * step-start pull and a push take the shared mode in their lane, and a push
 * that must run alone (the last publish attempt, swamp-club#3146) takes the
 * exclusive mode, so no other sync overlaps it.
 */
export function withRunSyncGate<T>(
  gate: SyncGate | undefined,
  fn: () => Promise<T>,
  kind: RunSyncLane | "push-alone",
): Promise<T> {
  if (kind === "push-alone") return withSyncGate(gate, fn);
  return withSharedSyncGate(gate, fn, kind);
}

/** The lanes of each gate, created with its first shared holder. */
const runSyncLanes = new WeakMap<SyncGate, RunSyncLanes>();

/** The run sync lanes of `gate` (test introspection). */
export function runSyncLanesOf(gate: SyncGate): RunSyncLanes {
  let lanes = runSyncLanes.get(gate);
  if (lanes === undefined) {
    lanes = new RunSyncLanes();
    runSyncLanes.set(gate, lanes);
  }
  return lanes;
}

/**
 * Runs `fn` in `lane`, waiting at most {@link GATE_WAIT_TIMEOUT_MS} and then
 * proceeding without it, as the gate itself degrades.
 */
async function inRunSyncLane<T>(
  gate: SyncGate,
  lane: RunSyncLane,
  fn: () => Promise<T>,
): Promise<T> {
  const lanes = runSyncLanesOf(gate);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATE_WAIT_TIMEOUT_MS);
  Deno.unrefTimer(timer);
  let held = false;
  try {
    await lanes.acquire(lane, controller.signal);
    held = true;
  } catch {
    const waitedSec = GATE_WAIT_TIMEOUT_MS / 1000;
    logger
      .warn`Run sync ${lane} lane not acquired within ${waitedSec}s; proceeding without it — a concurrent run sync could undo this one`;
  }
  clearTimeout(timer);
  try {
    return await fn();
  } finally {
    if (held) lanes.release();
  }
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
  // Covers only the wait, not fn, so a slow gated unit shows how much of its
  // time went to queueing behind a pull or another mutation (swamp-club#2417).
  // Inside a diagnostic area the wait is also its `gate_wait` phase
  // (design/enablers/serve-phase-telemetry.md).
  const waitSpan = getTracer().startSpan("swamp.serve.sync_gate.wait", {
    attributes: {
      "sync_gate.mode": mode,
      ...diagnosticSpanAttributes("gate_wait"),
    },
  });
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
  waitSpan.setAttribute("sync_gate.acquired", held);
  waitSpan.setStatus(
    held
      ? { code: SpanStatusCode.OK }
      : { code: SpanStatusCode.ERROR, message: "Sync gate wait timed out" },
  );
  waitSpan.end();
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
  /**
   * Bound on an escalated, queued wait. Defaults to
   * {@link GATE_WAIT_TIMEOUT_MS}; injectable so tests can let it run out.
   */
  queuedWaitMs?: number;
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
 *
 * In the access_poll diagnostic area the wait and the pull are the
 * `gate_wait` and `remote_pull` phases (design/enablers/serve-phase-telemetry.md).
 * A gated pull has no `swamp.serve.sync_gate.wait` span to tag, so its
 * `gate_wait` is an observation of its own. Outside any area they export
 * nothing.
 */
export async function gatedPull(
  gate: SyncGate | undefined,
  label: string,
  pull: (signal: AbortSignal) => Promise<number | void>,
  options: GatedPullOptions = {},
): Promise<number | void> {
  const runPull = async () => {
    const phase = startDiagnosticPhase("remote_pull");
    try {
      const changed = await phase.run(() =>
        runBoundedSync(label, "pull", POLLER_PULL_TIMEOUT_MS, pull)
      );
      const reported = typeof changed === "number";
      phase.attributes({ "swamp.diagnostic.count_reported": reported });
      if (reported) phase.tally.add("changed", changed);
      phase.end();
      return changed;
    } catch (error) {
      if (error instanceof SyncTimeoutError) phase.end("timeout");
      else phase.fail(error);
      throw error;
    }
  };
  if (!gate) return runPull();

  const state = options.state ?? { consecutiveSkips: 0 };
  const escalate = state.consecutiveSkips >= POLLER_ESCALATE_AFTER_SKIPS;
  if (escalate) {
    const skips = state.consecutiveSkips;
    logger
      .info`${label} queueing for the sync gate after ${skips} skipped cycles; run syncs wait behind it until it pulls`;
  }
  const wait = startDiagnosticPhase("gate_wait", {
    "swamp.diagnostic.gate_mode": escalate ? "queued" : "opportunistic",
    "swamp.diagnostic.consecutive_skips": state.consecutiveSkips,
  });
  let acquired: boolean;
  try {
    acquired = escalate
      ? await acquireQueued(gate, options.signal, options.queuedWaitMs)
      : await acquireOpportunistically(gate, options, wait.tally);
  } catch (error) {
    wait.fail(error);
    throw error;
  }
  wait.attributes({ "swamp.diagnostic.acquired": acquired });
  // A busy gate is a skip, not a failure; a stop ends the wait cancelled,
  // and a queued wait that runs out its bound is a timeout.
  wait.end(
    acquired
      ? "ok"
      : options.signal?.aborted
      ? "cancelled"
      : escalate
      ? "timeout"
      : "ok",
  );

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
  tally: PhaseTally,
): Promise<boolean> {
  const { retryMs, windowMs } = options.timing ?? pollerGateTiming(30_000);
  const delay = options.delay ?? unrefDelay;
  for (let waited = 0;; waited += retryMs) {
    if (options.signal?.aborted) return false;
    tally.add("attempts");
    if (gate.tryAcquire()) return true;
    if (waited >= windowMs) return false;
    await delay(retryMs, options.signal);
  }
}

async function acquireQueued(
  gate: SyncGate,
  signal: AbortSignal | undefined,
  waitMs = GATE_WAIT_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), waitMs);
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
