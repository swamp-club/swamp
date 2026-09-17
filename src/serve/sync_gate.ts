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
 * A handler mutation is a two-step unit of work: the local cache write or
 * removal (which emits `markDirty`), and the `pushChanged` that commits it to
 * the remote datastore. The sync contract decides delete-vs-upload by looking
 * at the file on disk (`DatastoreSyncService.markDirty` rule 2,
 * "absence-on-disk = delete"), so a poller pull that downloads the item
 * between those two steps puts it back on disk and the push re-uploads it
 * instead of deleting it — the delete is silently undone (swamp-club#2247).
 *
 * The gate closes that window by serializing poller pulls against whole
 * mutation+push units. It is acquired in exactly three places:
 *
 * 1. The mutating request cases in `connection.ts` (whole handler).
 * 2. The server-token mint path in `device_auth_handler.ts`.
 * 3. Each poller's `pullChanged` (`config_poller.ts`,
 *    `access_data_poller.ts`, `runtime_data_poller.ts`).
 *
 * It is NOT reentrant — acquiring it from inside an already-gated handler
 * self-deadlocks, which is why the long-running run paths (and the post-run
 * push in `deps.ts`) stay ungated and are pinned in
 * {@link UNGATED_PUSH_HANDLERS}.
 *
 * Scope limits, documented in `design/enablers/datastores.md`: the gate is
 * in-process only (it gives no guarantee between HA peers), pushes are not
 * globally serial (ungated run paths still push concurrently), and a request
 * cancelled while queued on the gate still performs its mutation before
 * reporting `cancelled` — the cancel signal is deliberately not passed to
 * `acquire`, because a rejected acquisition would leave the client with no
 * response frame.
 */

import { Semaphore } from "../infrastructure/stream/semaphore.ts";
import { runBoundedSync } from "../infrastructure/persistence/datastore_sync_coordinator.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "sync-gate"]);

/**
 * Mutual-exclusion gate shared by serve's pollers and mutation handlers.
 * A counting semaphore with one permit — FIFO waiters, so a queued mutation
 * cannot be starved by a poll cycle.
 */
export type SyncGate = Semaphore;

/** Creates the single gate a serve process shares across pollers and handlers. */
export function createSyncGate(): SyncGate {
  return new Semaphore(1);
}

/**
 * Hard deadline for a poller pull, passed to `runBoundedSync` so the gate is
 * released even when an extension ignores the AbortSignal.
 *
 * Poller-scoped rather than the CLI's `DEFAULT_SYNC_TIMEOUT_MS` (5 minutes)
 * and deliberately BELOW {@link GATE_WAIT_TIMEOUT_MS}: a pull that is merely
 * slow must finish inside the gate rather than push waiting mutations onto
 * the ungated fallback path, which would reopen the race it exists to close.
 * Change one of these two constants and you must change the other.
 */
export const POLLER_PULL_TIMEOUT_MS = 120_000;

/**
 * How long a mutation waits for the gate before proceeding WITHOUT it.
 *
 * Serve has no per-request timeout (`MAX_ACTIVE_REQUESTS` is the only
 * backstop), so a wedged gate holder would otherwise stall every mutation and
 * all three pollers indefinitely. Degrading to ungated is no worse than the
 * pre-gate behaviour. Must stay ABOVE {@link POLLER_PULL_TIMEOUT_MS} — see
 * that constant.
 */
export const GATE_WAIT_TIMEOUT_MS = 150_000;

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
  "worker.token.create",
  "worker.token.revoke",
  "workflow.approve",
  "workflow.create",
  "workflow.delete",
  "workflow.edit",
  "workflow.reject",
]);

/**
 * Functions that push without taking the gate, and why. Pinned so the fitness
 * test can tell a deliberate exemption from a forgotten one.
 */
export const UNGATED_PUSH_HANDLERS: ReadonlySet<string> = new Set([
  // Long-running: holding the gate for a whole model or workflow run would
  // starve the pollers for minutes. A run's own version GC can still be
  // resurrected by an overlapping poll — a documented ceiling.
  "handleModelMethodRun",
  "handleWorkflowResume",
  // Post-run push for scheduled, webhook and resumed runs. Called from
  // ungated run paths, and gating it would deadlock any gated handler that
  // ever comes to trigger a run — the gate is not reentrant.
  "executeWorkflowWithLocks",
  // Startup hydration, before the listener accepts connections.
  "hydrateLocalCache",
  // The gate's own plumbing: this helper contains the pushChanged call every
  // gated handler routes through.
  "pushChangedToRemote",
]);

/**
 * Runs `fn` holding the sync gate, releasing it however `fn` settles.
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
  return runGated(gate, fn);
}

async function runGated<T>(gate: SyncGate, fn: () => Promise<T>): Promise<T> {
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
    await gate.acquire(controller.signal);
    held = true;
  } catch {
    // Degraded, not failed: a wedged holder must not take the server with it.
    const waitedSec = GATE_WAIT_TIMEOUT_MS / 1000;
    logger
      .warn`Sync gate not acquired within ${waitedSec}s; proceeding without it — a concurrent datastore pull could undo this mutation`;
  }
  clearTimeout(timer);
  try {
    return await fn();
  } finally {
    if (held) gate.release();
  }
}

/**
 * Runs a poller pull under the gate, hard-bounded by
 * {@link POLLER_PULL_TIMEOUT_MS}.
 *
 * `runBoundedSync` is the same wrapper the CLI sync coordinator uses: it
 * passes an AbortSignal AND races a deadline, so the gate is released even
 * when an extension ignores the signal — otherwise one hung pull would stall
 * every mutating request on the server.
 */
export function gatedPull(
  gate: SyncGate | undefined,
  label: string,
  pull: (signal: AbortSignal) => Promise<number | void>,
): Promise<number | void> {
  return withSyncGate(
    gate,
    () => runBoundedSync(label, "pull", POLLER_PULL_TIMEOUT_MS, pull),
  );
}
