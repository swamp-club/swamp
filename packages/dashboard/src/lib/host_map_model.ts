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
 * placement selectors use the scheduler's eligibility rules
 * (src/domain/remote/scheduler.ts), kept in step by an integration test
 */

export type WorkerStatus =
  | "idle"
  | "busy"
  | "disconnected"
  | "unverified"
  | "draining";

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
  until?: number;
}

export const OUTCOME_MS = 6_000;

/**
 * keeps each lease in the slot it already had; a lease seen active before and
 * gone now shows its outcome for OUTCOME_MS, and a new active lease takes the
 * first free slot
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
 * skip while the tab is hidden, since paused animation frames would leave a
 * transition never started or freed; snap on the first draw after a skip,
 * without replaying what changed; animate otherwise
 */
export type HostMapDrawMode = "skip" | "snap" | "animate";

export function hostMapDrawMode(
  { hidden, skipped }: { hidden: boolean; skipped: boolean },
): HostMapDrawMode {
  if (hidden) return "skip";
  return skipped ? "snap" : "animate";
}

export function isUp(worker: FleetWorker): boolean {
  return worker.status === "idle" || worker.status === "busy";
}

/**
 * wider than isUp: a draining or unverified worker is connected but takes no
 * new work
 */
export function isConnected(worker: FleetWorker): boolean {
  return worker.status !== "disconnected";
}

export interface FleetCounts {
  connected: number;
  byStatus: Record<WorkerStatus, number>;
  usedSlots: number;
  totalSlots: number;
}

export function fleetCounts(workers: readonly FleetWorker[]): FleetCounts {
  const counts: FleetCounts = {
    connected: 0,
    byStatus: {
      unverified: 0,
      idle: 0,
      busy: 0,
      draining: 0,
      disconnected: 0,
    },
    usedSlots: 0,
    totalSlots: 0,
  };
  for (const worker of workers) {
    counts.byStatus[worker.status]++;
    if (isConnected(worker)) counts.connected++;
    if (isUp(worker)) {
      counts.usedSlots += worker.activeDispatchIds.length;
      counts.totalSlots += worker.capacity;
    }
  }
  return counts;
}

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

export function groupValue(worker: FleetWorker, key: string): string {
  if (key === PLATFORM_GROUP) return `${worker.platform}/${worker.arch}`;
  if (key === "fleet") return worker.labels.fleet ?? worker.tokenName;
  return worker.labels[key] ?? UNLABELED;
}

export function groupKeys(workers: readonly FleetWorker[]): string[] {
  const labels = new Set<string>();
  for (const worker of workers) {
    for (const key of Object.keys(worker.labels)) {
      if (key !== "fleet") labels.add(key);
    }
  }
  return ["fleet", ...[...labels].sort(), PLATFORM_GROUP];
}

export interface GroupStats extends FleetCounts {
  key: string;
  workers: FleetWorker[];
}

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
    stats.push({ key: value, workers: members, ...fleetCounts(members) });
  }
  const weight = (g: GroupStats) =>
    g.workers.reduce((sum, w) => sum + w.capacity, 0);
  return stats.sort((a, b) => {
    if (a.key === UNLABELED) return 1;
    if (b.key === UNLABELED) return -1;
    return weight(b) - weight(a) || a.key.localeCompare(b.key);
  });
}

export const CAPTION_FULL_MIN_WIDTH = 190;

/**
 * counts connected workers rather than up out of all listed, so disconnected
 * records inside the visibility TTL never read as workers that are down
 */
export function groupCaption(stats: FleetCounts, width: number): string {
  const slots = `${stats.usedSlots}/${stats.totalSlots} slots`;
  if (width < CAPTION_FULL_MIN_WIDTH) return slots;
  return `${stats.connected} connected · ${slots}`;
}

export interface WorkerSummary {
  busy: number;
  idle: number;
  unavailable: number;
}

/**
 * disconnected workers are left out: they are history, shown on the Workers
 * view until the visibility TTL ends
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

export interface Selector {
  labels: Record<string, string>;
  platform?: string;
  target?: string;
}

export interface ParsedSelector {
  selector: Selector;
  invalid: string[];
}

/**
 * pairs split on commas or whitespace; platform and target are the placement
 * fields of the same names, every other key is a label
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
