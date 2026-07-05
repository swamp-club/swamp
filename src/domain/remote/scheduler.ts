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
 * Worker scheduling (see design/remote-execution.md, "Scheduling, fan-out,
 * and provisioning").
 *
 * A pure domain service: given a step's placement requirements and a pool
 * snapshot, decide where the dispatch goes. Matching order is direct target
 * → labels → platform; the tiebreak among idle eligible workers is the name
 * ordering (deterministic round-robin emerges from busy/idle rotation), and
 * a step queues — never fails — when every eligible worker is busy.
 */

/** A step's placement requirements, from workflow YAML. */
export interface StepPlacement {
  /** Pin to a specific worker by name or instance UUID. */
  target?: string;
  /** Labels the worker must carry (exact key=value match on every entry). */
  labels?: Record<string, string>;
  /** Required platform, e.g. "linux" or "linux/x86_64". */
  platform?: string;
  /** Per-step queue timeout in milliseconds; overrides the serve-level default. */
  queueTimeoutMs?: number;
}

/** The slice of worker state scheduling looks at. */
export interface SchedulableWorker {
  name: string;
  instanceUuid: string;
  labels: Record<string, string>;
  platform: string;
  arch: string;
  status: "idle" | "busy" | "unverified";
  connected: boolean;
}

export type ScheduleDecision =
  | { kind: "dispatch"; worker: SchedulableWorker }
  | { kind: "queue" };

/**
 * Human-readable description of a placement requirement, for use in
 * timeout errors and step_queued events.
 */
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

/** True when a step declares any placement requirement at all. */
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

/** Workers eligible for a placement, ignoring busy/idle. */
export function eligibleWorkers(
  placement: StepPlacement,
  pool: SchedulableWorker[],
): SchedulableWorker[] {
  return pool.filter((worker) => {
    if (!worker.connected) {
      return false;
    }
    if (placement.target !== undefined) {
      return worker.name === placement.target ||
        worker.instanceUuid === placement.target;
    }
    if (worker.status === "unverified") {
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
 * Decide where a step goes right now. `dispatch` names an idle eligible
 * worker; `queue` means every eligible worker is busy, or no connected
 * worker matches the placement at all — the step waits for a pool change
 * either way.
 */
export function scheduleStep(
  placement: StepPlacement,
  pool: SchedulableWorker[],
): ScheduleDecision {
  const eligible = eligibleWorkers(placement, pool);
  if (eligible.length === 0) {
    return { kind: "queue" };
  }
  const dispatchable = eligible
    .filter((worker) =>
      worker.status === "idle" ||
      (worker.status === "unverified" && placement.target !== undefined)
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  if (dispatchable.length === 0) {
    return { kind: "queue" };
  }
  return { kind: "dispatch", worker: dispatchable[0] };
}
