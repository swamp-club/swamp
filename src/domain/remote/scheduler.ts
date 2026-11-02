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
  worker: SchedulableWorker,
  required: string,
): boolean {
  const [platform, arch] = required.split("/");
  if (platform && worker.platform !== platform) {
    return false;
  }
  return arch === undefined || worker.arch === arch;
}

function matchesLabels(
  worker: SchedulableWorker,
  required: Record<string, string>,
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
