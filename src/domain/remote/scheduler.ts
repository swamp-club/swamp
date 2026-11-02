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
 * matching order is direct target, labels, platform; ties among idle eligible
 * workers break by name; a step queues, never fails, when every eligible worker
 * is busy
 */

import type {
  FanOutMember,
  FanOutPlan,
  FanOutPolicy,
  FanOutSelector,
} from "./fan_out.ts";
import { hasLane, resolveMaxFailures } from "./fan_out.ts";
import type { PoolWorker } from "./worker_pool.ts";

export interface StepPlacement {
  target?: string;
  labels?: Record<string, string>;
  platform?: string;
  queueTimeoutMs?: number;
  /**
   * steps sharing a key are pinned to the worker that ran the first; the
   * dispatch service keeps the key-to-worker mapping and fails steps whose
   * pinned worker disconnects
   */
  affinityKey?: string;
}

export interface SchedulableWorker {
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

export type ScheduleDecision =
  | { kind: "dispatch"; worker: SchedulableWorker }
  | { kind: "queue" };

export function describePlacement(placement: StepPlacement): string {
  if (placement.target !== undefined) {
    return `target '${placement.target}'`;
  }
  const parts = [
    placement.labels && Object.keys(placement.labels).length > 0
      ? `labels ${
        Object.entries(placement.labels).map(([k, v]) => `${k}=${v}`)
          .join(",")
      }`
      : null,
    placement.platform ? `platform '${placement.platform}'` : null,
  ].filter((part) => part !== null).join(" and ");
  return parts || "any worker";
}

export function hasPlacement(placement: StepPlacement | undefined): boolean {
  return placement !== undefined && (
    placement.target !== undefined ||
    (placement.labels !== undefined &&
      Object.keys(placement.labels).length > 0) ||
    placement.platform !== undefined
  );
}

function matchesPlatform(
  worker: Pick<SchedulableWorker, "platform" | "arch">,
  required: string,
): boolean {
  const [platform, arch] = required.split("/");
  if (platform && worker.platform !== platform) {
    return false;
  }
  return arch === undefined || worker.arch === arch;
}

function matchesLabels(
  worker: Pick<SchedulableWorker, "labels">,
  required: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(required).every(
    ([key, value]) => worker.labels[key] === value,
  );
}

export function eligibleWorkers(
  placement: StepPlacement,
  pool: SchedulableWorker[],
): SchedulableWorker[] {
  return pool.filter((worker) => {
    if (!worker.connected) {
      return false;
    }
    if (placement.target !== undefined) {
      if (worker.status === "draining") return false;
      return worker.name === placement.target ||
        worker.instanceUuid === placement.target;
    }
    if (worker.status === "unverified" || worker.status === "draining") {
      return false;
    }
    if (
      placement.labels !== undefined && !matchesLabels(worker, placement.labels)
    ) {
      return false;
    }
    if (
      placement.platform !== undefined &&
      !matchesPlatform(worker, placement.platform)
    ) {
      return false;
    }
    return true;
  });
}

/**
 * a target stands in for labels and platform; ignores connection and status,
 * which decide whether the worker can take a dispatch now, not whether it may
 */
export function unmetPlacement(
  placement: StepPlacement,
  worker: SchedulableWorker,
): string | null {
  if (placement.target !== undefined) {
    return worker.name === placement.target ||
        worker.instanceUuid === placement.target
      ? null
      : `target '${placement.target}'`;
  }
  // Not matchesLabels: the message names the first label that fails.
  for (const [key, value] of Object.entries(placement.labels ?? {})) {
    if (worker.labels[key] !== value) {
      return `label ${key}=${value}`;
    }
  }
  if (
    placement.platform !== undefined &&
    !matchesPlatform(worker, placement.platform)
  ) {
    return `platform '${placement.platform}'`;
  }
  return null;
}

/**
 * queue means every eligible worker is at capacity or no connected worker
 * matches; tiebreak is most free slots first, then name for determinism
 */
export function scheduleStep(
  placement: StepPlacement,
  pool: SchedulableWorker[],
): ScheduleDecision {
  const eligible = eligibleWorkers(placement, pool);
  if (eligible.length === 0) {
    return { kind: "queue" };
  }
  const schedulable = eligible
    .filter((worker) =>
      worker.status !== "unverified" &&
      worker.activeDispatchIds.length < worker.capacity
    )
    .sort((a, b) => {
      const freeA = a.capacity - a.activeDispatchIds.length;
      const freeB = b.capacity - b.activeDispatchIds.length;
      if (freeA !== freeB) return freeB - freeA;
      return a.name.localeCompare(b.name);
    });
  if (schedulable.length === 0) {
    return { kind: "queue" };
  }
  return { kind: "dispatch", worker: schedulable[0] };
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function fanOutMember(
  worker: PoolWorker,
  offline: FanOutPolicy["offline"],
): FanOutMember {
  const base = { worker: worker.name, instanceUuid: worker.instanceUuid };
  // last known status beats the connection: draining is leaving, unverified is unproven
  if (worker.status === "unverified" || worker.status === "draining") {
    return { ...base, disposition: "excluded", reason: worker.status };
  }
  if (!worker.connected || worker.status === "disconnected") {
    const disposition = offline === "wait"
      ? "waiting"
      : offline === "skip"
      ? "skipped"
      : "failed";
    return { ...base, disposition, reason: "disconnected" };
  }
  return { ...base, disposition: "dispatch" };
}

export function planFanOut(
  selector: FanOutSelector,
  policy: FanOutPolicy,
  pool: readonly PoolWorker[],
): FanOutPlan {
  // a repeated name breaks the port's contract, so it throws rather than picking one
  const seen = new Set<string>();
  for (const worker of pool) {
    if (seen.has(worker.name)) {
      throw new Error(`Worker pool lists '${worker.name}' more than once`);
    }
    seen.add(worker.name);
  }
  const members = pool
    .filter((worker) =>
      (selector.labels === undefined ||
        matchesLabels(worker, selector.labels)) &&
      (selector.platform === undefined ||
        matchesPlatform(worker, selector.platform))
    )
    .sort((a, b) => byCodeUnit(a.name, b.name))
    .map((worker) => fanOutMember(worker, policy.offline));
  const plannedLanes = members.filter(hasLane).length;
  if (plannedLanes < policy.minWorkers) {
    return {
      kind: "refused",
      reason: "min_workers",
      live: plannedLanes,
      minWorkers: policy.minWorkers,
    };
  }
  return {
    kind: "planned",
    members,
    plannedLanes,
    maxFailures: resolveMaxFailures(policy.rollout?.maxFailures, plannedLanes),
  };
}
