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

import { useCallback, useEffect, useRef, useState } from "react";
import { useSwamp } from "./SwampProvider";
import { createRequestSequence } from "./request_sequence";
import {
  activeDispatchIds,
  chunk,
  COALESCE_MS,
  ENDED_WITHIN_MS,
  FALLBACK_MS,
  LEASE_BATCH,
  workerSignature,
  type WorkerSnapshotLike,
} from "./fleet_refresh.ts";
import type { FleetLease, FleetWorker } from "../lib/host_map_model.ts";

export interface FleetData {
  workers: FleetWorker[];
  leases: FleetLease[];
  /** True until the first fetch settles. */
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

function listOf<T>(payload: unknown, key: string): T[] {
  const data = (payload as { data?: Record<string, unknown> } | null)?.data;
  const value = data?.[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

function tabVisible(): boolean {
  const doc = (globalThis as { document?: { visibilityState?: string } })
    .document;
  return doc?.visibilityState !== "hidden";
}

/**
 * Workers (including those disconnected within the TTL) and the step leases
 * on their slots. Keeps the last data while refreshing, so the map never
 * flashes back to a skeleton; refreshes on health-stream worker changes and
 * on a slow fallback while the tab is visible.
 */
export function useFleetData(
  healthWorkers: readonly WorkerSnapshotLike[] | undefined,
  ttlMinutes: number,
): FleetData {
  const { connected, request } = useSwamp();
  const [workers, setWorkers] = useState<FleetWorker[]>([]);
  const [leases, setLeases] = useState<FleetLease[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(createRequestSequence());

  const fetchAll = useCallback(async () => {
    if (!connected) return;
    const ticket = sequence.current.next();
    let nextWorkers: FleetWorker[];
    try {
      const listed = await request("worker.list", {
        disconnectedWithinMs: ttlMinutes * 60_000,
      });
      nextWorkers = listOf<FleetWorker>(listed, "workers");
    } catch (err) {
      if (!sequence.current.isCurrent(ticket)) return;
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
      return;
    }
    // Workers and their leases are committed in one render: a slot whose
    // dispatch just ended must see the lease's outcome in the same pass, or
    // it is freed against the stale active lease and the outcome never shows.
    // A failed lease read commits the workers with the previous leases (slot
    // detail goes stale) and never raises `error`.
    let nextLeases: FleetLease[] | null = null;
    try {
      const batches = chunk(activeDispatchIds(nextWorkers), LEASE_BATCH);
      const leases: FleetLease[] = [];
      for (const [i, ids] of (batches.length ? batches : [[]]).entries()) {
        const leased = await request("worker.lease.list", {
          dispatchIds: ids,
          ...(i === 0 ? { endedWithinMs: ENDED_WITHIN_MS } : {}),
        });
        for (const lease of listOf<FleetLease>(leased, "leases")) {
          leases.push(lease);
        }
      }
      nextLeases = leases;
    } catch {
      // Keep the previous leases; the next refresh retries.
    }
    if (!sequence.current.isCurrent(ticket)) return;
    setWorkers(nextWorkers);
    if (nextLeases !== null) setLeases(nextLeases);
    setError(null);
    setLoading(false);
  }, [connected, request, ttlMinutes]);

  const refetch = useCallback(() => {
    fetchAll().catch(() => {});
  }, [fetchAll]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useCoalescedRefetch(healthWorkers, refetch);

  useEffect(() => {
    const timer = setInterval(() => {
      if (tabVisible()) refetch();
    }, FALLBACK_MS);
    return () => clearInterval(timer);
  }, [refetch]);

  useEffect(() => {
    const seq = sequence.current;
    return () => seq.invalidate();
  }, []);

  return { workers, leases, loading, error, refetch };
}

/**
 * Refetches when the health stream's worker set changes, at most once per
 * COALESCE_MS (a throttle, not a debounce): a busy fleet changes it on every
 * dispatch and the reads it triggers are audited, but a steady stream of
 * changes must still refresh. The first signature seen does not refetch.
 */
export function useCoalescedRefetch(
  healthWorkers: readonly WorkerSnapshotLike[] | undefined,
  refetch: () => void,
): void {
  const signature = workerSignature(healthWorkers);
  const lastFetched = useRef(signature);
  const latest = useRef({ signature, refetch });
  latest.current = { signature, refetch };
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (signature === lastFetched.current || pending.current !== null) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      lastFetched.current = latest.current.signature;
      latest.current.refetch();
    }, COALESCE_MS);
  }, [signature]);
  useEffect(() => () => {
    if (pending.current !== null) clearTimeout(pending.current);
  }, []);
}
