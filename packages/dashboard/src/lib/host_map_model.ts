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
 * Pure model for the fleet host map: joins workers to their step leases as
 * per-slot state, groups workers by a label key, applies the visibility TTL,
 * and evaluates placement selectors with the scheduler's eligibility rules
 * (src/domain/remote/scheduler.ts, kept in step by an integration test).
 */

export type WorkerStatus =
  | "idle"
  | "busy"
  | "disconnected"
  | "unverified"
  | "draining";

/** A worker as `worker.list` returns it. */
export interface FleetWorker {
  name: string;
  tokenName: string;
  status: WorkerStatus;
  labels: Record<string, string>;
  platform: string;
  arch: string;
  instanceUuid: string;
  enrolledAt: string;
  lastSeenAt: string;
  capacity: number;
  activeDispatchIds: string[];
  disconnectedAt?: string;
}

export type LeaseState = "active" | "completed" | "failed" | "expired";

/** A step lease as `worker.lease.list` returns it. */
export interface FleetLease {
  leaseId: string;
  dispatchId: string;
  workerName: string;
  state: LeaseState;
  workflowName?: string;
  workflowRunId?: string;
  jobName?: string;
  stepName?: string;
  modelType: string;
  methodName: string;
  createdAt: string;
  endedAt?: string;
}

export type SlotState = "free" | LeaseState;

/** One dispatch slot. `dispatchId` stays put while the lease occupies it. */
export interface Slot {
  state: SlotState;
  dispatchId?: string;
  lease?: FleetLease;
  /** For an ended lease, when its outcome stops showing and the slot frees. */
  until?: number;
}

/** How long an ended lease's outcome shows before its slot frees. */
export const OUTCOME_MS = 6_000;

/**
 * Assigns this refresh's leases to slots, keeping each lease in the slot it
 * already had. A lease seen active before and gone now shows its outcome for
 * {@link OUTCOME_MS}; a new active lease takes the first free slot.
 */
export function assignSlots(
  previous: readonly Slot[] | undefined,
  worker: FleetWorker,
  leasesByDispatch: ReadonlyMap<string, FleetLease>,
  nowMs: number,
): Slot[] {
  const capacity = Math.max(1, worker.capacity);
  const active = new Set(worker.activeDispatchIds);
  const slots: Slot[] = [];
  for (let i = 0; i < capacity; i++) {
    const prev = previous?.[i];
    if (prev?.dispatchId === undefined) {
      slots.push({ state: "free" });
    } else if (active.has(prev.dispatchId)) {
      const lease = leasesByDispatch.get(prev.dispatchId) ?? prev.lease;
      slots.push({ state: "active", dispatchId: prev.dispatchId, lease });
    } else if (prev.state !== "active") {
      slots.push(
        prev.until !== undefined && nowMs < prev.until
          ? prev
          : { state: "free" },
      );
    } else {
      const lease = leasesByDispatch.get(prev.dispatchId) ?? prev.lease;
      const ended = lease !== undefined && lease.state !== "active";
      slots.push(
        ended
          ? {
            state: lease.state,
            dispatchId: prev.dispatchId,
            lease,
            until: nowMs + OUTCOME_MS,
          }
          : { state: "free" },
      );
    }
  }
  const placed = new Set(
    slots.filter((s) => s.state === "active").map((s) => s.dispatchId),
  );
  for (const dispatchId of worker.activeDispatchIds) {
    if (placed.has(dispatchId)) continue;
    let index = slots.findIndex((s) => s.state === "free");
    if (index < 0) index = slots.findIndex((s) => s.state !== "active");
    if (index < 0) break;
    slots[index] = {
      state: "active",
      dispatchId,
      lease: leasesByDispatch.get(dispatchId),
    };
    placed.add(dispatchId);
  }
  return slots;
}

/**
 * How the host map draws a render. `skip` while the tab is hidden: browsers
 * pause animation frames there, so a transition scheduled then never starts
 * and is never freed (swamp-club#3660). `snap` on the first draw after a
 * skipped one: straight to the current layout, without replaying what
 * changed while hidden. `animate` otherwise.
 */
export type HostMapDrawMode = "skip" | "snap" | "animate";

export function hostMapDrawMode(
  { hidden, skipped }: { hidden: boolean; skipped: boolean },
): HostMapDrawMode {
  if (hidden) return "skip";
  return skipped ? "snap" : "animate";
}

/** Workers that count as up: connected and able to take work. */
export function isUp(worker: FleetWorker): boolean {
  return worker.status === "idle" || worker.status === "busy";
}

/** Fraction of the visibility TTL a disconnected worker has used, 0..1. */
export function fadeFraction(
  worker: FleetWorker,
  nowMs: number,
  ttlMs: number,
): number {
  if (worker.status !== "disconnected") return 0;
  if (worker.disconnectedAt === undefined || ttlMs <= 0) return 1;
  const age = nowMs - Date.parse(worker.disconnectedAt);
  return Math.min(1, Math.max(0, age / ttlMs));
}

/** Whether the worker stays on the map under the visibility TTL. */
export function isVisible(
  worker: FleetWorker,
  nowMs: number,
  ttlMs: number,
): boolean {
  if (worker.status !== "disconnected") return true;
  if (worker.disconnectedAt === undefined) return false;
  return nowMs - Date.parse(worker.disconnectedAt) <= ttlMs;
}

export const PLATFORM_GROUP = "platform";
export const UNLABELED = "(unlabeled)";

/** The value a worker is grouped under for a group-by key. */
export function groupValue(worker: FleetWorker, key: string): string {
  if (key === PLATFORM_GROUP) return `${worker.platform}/${worker.arch}`;
  if (key === "fleet") return worker.labels.fleet ?? worker.tokenName;
  return worker.labels[key] ?? UNLABELED;
}

/** Group-by keys available for a set of workers: fleet, other labels, platform. */
export function groupKeys(workers: readonly FleetWorker[]): string[] {
  const labels = new Set<string>();
  for (const worker of workers) {
    for (const key of Object.keys(worker.labels)) {
      if (key !== "fleet") labels.add(key);
    }
  }
  return ["fleet", ...[...labels].sort(), PLATFORM_GROUP];
}

export interface GroupStats {
  key: string;
  workers: FleetWorker[];
  up: number;
  usedSlots: number;
  totalSlots: number;
  byStatus: Record<WorkerStatus, number>;
}

/** Groups workers by `key`; largest total capacity first, then name. */
export function groupWorkers(
  workers: readonly FleetWorker[],
  key: string,
): GroupStats[] {
  const groups = new Map<string, FleetWorker[]>();
  for (const worker of workers) {
    const value = groupValue(worker, key);
    const list = groups.get(value);
    if (list) list.push(worker);
    else groups.set(value, [worker]);
  }
  const stats: GroupStats[] = [];
  for (const [value, members] of groups) {
    const byStatus: Record<WorkerStatus, number> = {
      idle: 0,
      busy: 0,
      disconnected: 0,
      unverified: 0,
      draining: 0,
    };
    let up = 0;
    let usedSlots = 0;
    let totalSlots = 0;
    for (const worker of members) {
      byStatus[worker.status]++;
      if (isUp(worker)) {
        up++;
        usedSlots += worker.activeDispatchIds.length;
        totalSlots += worker.capacity;
      }
    }
    stats.push({
      key: value,
      workers: members,
      up,
      usedSlots,
      totalSlots,
      byStatus,
    });
  }
  const weight = (g: GroupStats) =>
    g.workers.reduce((sum, w) => sum + w.capacity, 0);
  return stats.sort((a, b) => {
    if (a.key === UNLABELED) return 1;
    if (b.key === UNLABELED) return -1;
    return weight(b) - weight(a) || a.key.localeCompare(b.key);
  });
}

export interface WorkerSummary {
  busy: number;
  idle: number;
  /** Connected but not taking new work: draining or unverified. */
  unavailable: number;
}

/**
 * The Overview header's three-state pool summary. Disconnected workers are
 * left out: they are history (a worker that finished or crashed and was
 * replaced), shown on the Workers view until its visibility TTL ends.
 */
export function workerSummary(workers: readonly FleetWorker[]): WorkerSummary {
  const summary: WorkerSummary = { busy: 0, idle: 0, unavailable: 0 };
  for (const worker of workers) {
    if (worker.status === "busy") summary.busy++;
    else if (worker.status === "idle") summary.idle++;
    else if (worker.status !== "disconnected") summary.unavailable++;
  }
  return summary;
}

// ── Placement selector ──────────────────────────────────────────────────

/** A step's placement, as written in a selector box. */
export interface Selector {
  labels: Record<string, string>;
  platform?: string;
  target?: string;
}

export interface ParsedSelector {
  selector: Selector;
  /** Tokens that were not `key=value`. */
  invalid: string[];
}

/**
 * Parses `gpu=h100, region=us-west-2, platform=linux/x86_64, target=gpu-1`.
 * Pairs split on commas or whitespace; `platform` and `target` are the
 * placement fields of the same names, every other key is a label.
 */
export function parseSelector(text: string): ParsedSelector {
  const selector: Selector = { labels: {} };
  const invalid: string[] = [];
  for (const token of text.split(/[\s,]+/)) {
    if (token === "") continue;
    const eq = token.indexOf("=");
    if (eq <= 0 || eq === token.length - 1) {
      invalid.push(token);
      continue;
    }
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (key === "platform") selector.platform = value;
    else if (key === "target") selector.target = value;
    else selector.labels[key] = value;
  }
  return { selector, invalid };
}

/** Formats a selector back to text; `parseSelector(formatSelector(s))` round-trips. */
export function formatSelector(selector: Selector): string {
  const parts = Object.entries(selector.labels).map(([k, v]) => `${k}=${v}`);
  if (selector.platform !== undefined) {
    parts.push(`platform=${selector.platform}`);
  }
  if (selector.target !== undefined) parts.push(`target=${selector.target}`);
  return parts.join(", ");
}

export function isEmptySelector(selector: Selector): boolean {
  return Object.keys(selector.labels).length === 0 &&
    selector.platform === undefined && selector.target === undefined;
}

/** The scheduler's view of a worker (scheduler.ts `SchedulableWorker`). */
export interface SchedulableView {
  name: string;
  instanceUuid: string;
  labels: Record<string, string>;
  platform: string;
  arch: string;
  status: "idle" | "busy" | "unverified" | "draining";
  connected: boolean;
  capacity: number;
  activeDispatchIds: string[];
}

/** Maps a listed worker to the scheduler's view; disconnected means not connected. */
export function toSchedulable(worker: FleetWorker): SchedulableView {
  return {
    name: worker.name,
    instanceUuid: worker.instanceUuid,
    labels: worker.labels,
    platform: worker.platform,
    arch: worker.arch,
    status: worker.status === "disconnected" ? "idle" : worker.status,
    connected: worker.status !== "disconnected",
    capacity: worker.capacity,
    activeDispatchIds: worker.activeDispatchIds,
  };
}

/** Mirrors scheduler.ts `eligibleWorkers` for a single worker. */
export function isEligible(
  selector: Selector,
  worker: SchedulableView,
): boolean {
  if (!worker.connected) return false;
  if (selector.target !== undefined) {
    if (worker.status === "draining") return false;
    return worker.name === selector.target ||
      worker.instanceUuid === selector.target;
  }
  if (worker.status === "unverified" || worker.status === "draining") {
    return false;
  }
  for (const [key, value] of Object.entries(selector.labels)) {
    if (worker.labels[key] !== value) return false;
  }
  if (selector.platform !== undefined) {
    const [platform, arch] = selector.platform.split("/");
    if (platform && worker.platform !== platform) return false;
    if (arch !== undefined && worker.arch !== arch) return false;
  }
  return true;
}

/** Free slots a step with this selector could take right now (scheduleStep's view). */
export function freeSlots(
  selector: Selector,
  workers: readonly FleetWorker[],
): number {
  let free = 0;
  for (const worker of workers) {
    const view = toSchedulable(worker);
    if (!isEligible(selector, view) || view.status === "unverified") continue;
    free += Math.max(0, view.capacity - view.activeDispatchIds.length);
  }
  return free;
}
