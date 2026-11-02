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
 * When the Workers view refetches. `worker.list` and `worker.lease.list` are
 * audited admin reads, so the view refetches only when the health stream
 * shows a worker change on this instance, plus a slow fallback while the tab
 * is visible for changes on other cluster instances.
 */

/** Fallback refresh interval while the tab is visible. */
export const FALLBACK_MS = 60_000;
/** Window of recently ended leases to fetch, so outcomes can show. */
export const ENDED_WITHIN_MS = 15_000;
/** Health-stream worker changes inside this window share one refetch. */
export const COALESCE_MS = 3_000;
/** Most dispatch ids one `worker.lease.list` request accepts. */
export const LEASE_BATCH = 2_000;

export const TTL_STEP_MINUTES = 30;
export const TTL_DEFAULT_MINUTES = 120;
/** Worker records are pruned 24h after disconnect (the worker GC default). */
export const TTL_MAX_MINUTES = 24 * 60;

/** The slice of a health-stream worker the refresh logic reads. */
export interface WorkerSnapshotLike {
  name: string;
  status: string;
  activeDispatchIds: readonly string[];
}

/**
 * A stable signature of the health stream's workers. It changes only when a
 * worker joins or leaves, changes status, or gains or loses a dispatch.
 */
export function workerSignature(
  workers: readonly WorkerSnapshotLike[] | undefined,
): string {
  if (!workers) return "";
  return workers
    .map((w) =>
      `${w.name}:${w.status}:${[...w.activeDispatchIds].sort().join(",")}`
    )
    .sort()
    .join("|");
}

/**
 * What a health-stream update does to the coalesced fleet refetch. While the
 * tab is hidden nothing is read, and a refetch already waiting is dropped;
 * on coming back into view the fleet is read once, at once; otherwise a
 * changed worker set arms one refetch unless one is already waiting.
 */
export type CoalesceStep = "now" | "later" | "cancel" | "none";

export function coalesceStep(
  { visible, cameBack, changed, pending }: {
    visible: boolean;
    cameBack: boolean;
    changed: boolean;
    pending: boolean;
  },
): CoalesceStep {
  if (!visible) return pending ? "cancel" : "none";
  if (cameBack) return "now";
  return changed && !pending ? "later" : "none";
}

/** Clamps a TTL in minutes to the stepper's range. */
export function clampTtlMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return TTL_DEFAULT_MINUTES;
  const stepped = Math.round(minutes / TTL_STEP_MINUTES) * TTL_STEP_MINUTES;
  return Math.min(TTL_MAX_MINUTES, Math.max(TTL_STEP_MINUTES, stepped));
}

/** "2h", "1h 30m", "30m". */
export function formatTtl(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** Splits `items` into runs of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Dispatch ids to ask leases for: every active dispatch on the listed workers. */
export function activeDispatchIds(
  workers: readonly { activeDispatchIds: readonly string[] }[],
): string[] {
  const ids = new Set<string>();
  for (const worker of workers) {
    for (const id of worker.activeDispatchIds) ids.add(id);
  }
  return [...ids].sort();
}
