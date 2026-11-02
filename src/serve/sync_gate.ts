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
 * one DatastoreSyncService is shared, and a pull overlapping another sync can
 * undo a delete before its push or prune a run push's new index entries. Not
 * reentrant; model lock before gate, global lock after.
 */

import {
  createSyncGate,
  type SyncGate,
} from "../infrastructure/persistence/sync_gate_lock.ts";
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

export { createSyncGate, type SyncGate };

/**
 * deliberately below GATE_WAIT_TIMEOUT_MS so a handler behind a slow pull gets
 * the gate before its own wait expires, since an expired wait proceeds ungated
 * and reopens the race. Change one, change the other.
 */
export const POLLER_PULL_TIMEOUT_MS = 120_000;

/**
 * no per-request timeout exists, so a wedged holder would stall everything; a
 * mutation or push degrades to ungated, a poller skips. Must stay above
 * POLLER_PULL_TIMEOUT_MS.
 */
export const GATE_WAIT_TIMEOUT_MS = 150_000;

/**
 * after this many skipped cycles a poller queues for the gate, so a steady
 * stream of run pushes can delay it but never starve it
 */
export const POLLER_ESCALATE_AFTER_SKIPS = 3;

export const POLLER_RETRY_MS = 1_000;

export interface PollerGateTiming {
  retryMs: number;
  windowMs: number;
}

/**
 * retry up to every second for five sixths of the interval, so a cycle always
 * finishes before the next tick is due
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
 * request types that mutate the cache and push run as one gated unit, pinned by
 * a fitness test. workflow.cancel is absent on purpose: it waits for a run that
 * needs the gate, so it gates only its persisted cancel
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
 * pushes that skip the gate in both modes, pinned so the fitness test tells a
 * deliberate exemption from a forgotten one; run paths push under the shared
 * mode
 */
export const UNGATED_PUSH_HANDLERS: ReadonlySet<string> = new Set([
  // Startup hydration, before the pollers, the scheduler or the listener
  // start — nothing can overlap it.
  "hydrateLocalCache",
  // the gate's own plumbing holds the pushChanged call every gated handler
  // routes through; its callers take the gate
  "pushChangedToRemote",
]);

type GateMode = "exclusive" | "shared";

/**
 * with no gate wired (filesystem datastores, tests) returns fn() directly, same
 * promise and no extra microtask, so timing is unchanged where there is nothing
 * to race
 */
export function withSyncGate<T>(
  gate: SyncGate | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!gate) return fn();
  return runGated(gate, "exclusive", fn);
}

/**
 * pushes run alongside pushes and pulls alongside pulls, never a pull alongside
 * a push; only a step-start pull passes pull. Never call from inside an
 * exclusively gated handler: the gate is not reentrant.
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
 * a step-start pull and a push take the shared mode in their lane; a push that
 * must run alone (the last publish attempt) takes the exclusive mode
 */
export function withRunSyncGate<T>(
  gate: SyncGate | undefined,
  fn: () => Promise<T>,
  kind: RunSyncLane | "push-alone",
): Promise<T> {
  if (kind === "push-alone") return withSyncGate(gate, fn);
  return withSharedSyncGate(gate, fn, kind);
}

const runSyncLanes = new WeakMap<SyncGate, RunSyncLanes>();

export function runSyncLanesOf(gate: SyncGate): RunSyncLanes {
  let lanes = runSyncLanes.get(gate);
  if (lanes === undefined) {
    lanes = new RunSyncLanes();
    runSyncLanes.set(gate, lanes);
  }
  return lanes;
}

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
  // covers only the wait, not fn, so a slow gated unit shows how much of its
  // time went to queueing
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

export interface PollerGateState {
  consecutiveSkips: number;
}

export interface GatedPullOptions {
  state?: PollerGateState;
  signal?: AbortSignal;
  timing?: PollerGateTiming;
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
  queuedWaitMs?: number;
}

/**
 * a poller never pulls ungated; it queues only after POLLER_ESCALATE_AFTER_SKIPS
 * skips, bounded by GATE_WAIT_TIMEOUT_MS. runBoundedSync races a deadline so a
 * hung pull cannot stall every mutation and run
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
 * the timer is unref'd so a poller retrying for the gate never holds the
 * process open
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
