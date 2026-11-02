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

import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import type { ActiveRun, RunKind } from "./active_run_registry.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "active-run-tracker"]);

export interface ActiveRunRecord {
  instanceId: string;
  resourceName: string;
  resourceId?: string;
  methodName?: string;
  resourceType?: string;
  runKind: RunKind;
  startedAt: string;
}

function activeRunKey(instanceId: string, runId: string): string {
  return `active-runs/${instanceId}/${runId}`;
}

const encoder = new TextEncoder();

/**
 * writes, rekeys and deletes per instance run in call order on one chain;
 * unordered, a delete can orphan or overtake a write, or remove the directory
 * under one
 */
const pendingByStore = new WeakMap<
  ControlPlaneStore,
  Map<string, Promise<void>>
>();

function enqueue(
  store: ControlPlaneStore,
  instanceId: string,
  op: () => Promise<void>,
  onError: (err: unknown) => void,
): void {
  let pending = pendingByStore.get(store);
  if (!pending) {
    pending = new Map();
    pendingByStore.set(store, pending);
  }
  const queue = pending;
  const tail: Promise<void> = (queue.get(instanceId) ?? Promise.resolve())
    .then(op)
    .catch(onError)
    .then(() => {
      if (queue.get(instanceId) === tail) queue.delete(instanceId);
    });
  queue.set(instanceId, tail);
}

export function activeRunWritesSettled(
  store: ControlPlaneStore,
  instanceId: string,
): Promise<void> {
  return pendingByStore.get(store)?.get(instanceId) ?? Promise.resolve();
}

export function writeActiveRun(
  store: ControlPlaneStore,
  instanceId: string,
  runId: string,
  record: Omit<ActiveRunRecord, "instanceId">,
): void {
  const full: ActiveRunRecord = { instanceId, ...record };
  enqueue(
    store,
    instanceId,
    () =>
      store.put(
        activeRunKey(instanceId, runId),
        encoder.encode(JSON.stringify(full)),
      ),
    (err: unknown) => {
      logger.warn("Failed to write active-run record for {runId}: {error}", {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  );
}

/**
 * queued behind a run's own delete so the record lands after it; a peer finds
 * the runs it must settle only through these records
 */
export async function keepActiveRunRecords(
  store: ControlPlaneStore,
  instanceId: string,
  runs: ReadonlyArray<
    & Pick<ActiveRun, "runId" | "kind" | "resourceName" | "startedAt">
    & Partial<Pick<ActiveRun, "resourceId">>
  >,
  timeoutMs: number,
): Promise<boolean> {
  for (const run of runs) {
    writeActiveRun(store, instanceId, run.runId, {
      resourceName: run.resourceName,
      ...(run.resourceId !== undefined ? { resourceId: run.resourceId } : {}),
      runKind: run.kind,
      startedAt: run.startedAt.toISOString(),
    });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([
      activeRunWritesSettled(store, instanceId).then(() => true),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function deleteActiveRun(
  store: ControlPlaneStore,
  instanceId: string,
  runId: string,
): void {
  enqueue(
    store,
    instanceId,
    () => store.delete(activeRunKey(instanceId, runId)),
    (err: unknown) => {
      logger.warn("Failed to delete active-run record for {runId}: {error}", {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  );
}

export function rekeyActiveRun(
  store: ControlPlaneStore,
  instanceId: string,
  oldRunId: string,
  newRunId: string,
  record: Omit<ActiveRunRecord, "instanceId">,
): void {
  const full: ActiveRunRecord = { instanceId, ...record };
  // Write the new key before deleting the old one, so the run is never
  // without a record and the directory is never empty mid-rekey.
  enqueue(
    store,
    instanceId,
    async () => {
      await store.put(
        activeRunKey(instanceId, newRunId),
        encoder.encode(JSON.stringify(full)),
      );
      await store.delete(activeRunKey(instanceId, oldRunId));
    },
    (err: unknown) => {
      logger.warn(
        "Failed to rekey active-run record from {oldRunId} to {newRunId}: {error}",
        {
          oldRunId,
          newRunId,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    },
  );
}

const decoder = new TextDecoder();

export async function findActiveRunByRunId(
  store: ControlPlaneStore,
  runId: string,
): Promise<{ record: ActiveRunRecord; instanceId: string } | null> {
  const keys = await store.list("active-runs/");
  for (const key of keys) {
    const segments = key.split("/");
    if (segments.length >= 3 && segments[segments.length - 1] === runId) {
      const data = await store.get(key);
      if (!data) continue;
      try {
        const record = JSON.parse(decoder.decode(data)) as ActiveRunRecord;
        return { record, instanceId: record.instanceId };
      } catch {
        continue;
      }
    }
  }
  return null;
}

export async function listActiveRunsForInstance(
  store: ControlPlaneStore,
  instanceId: string,
): Promise<{ runId: string; record: ActiveRunRecord }[]> {
  const prefix = `active-runs/${instanceId}/`;
  const runs: { runId: string; record: ActiveRunRecord }[] = [];
  for (const key of await store.list(prefix)) {
    const data = await store.get(key);
    if (!data) continue;
    try {
      const record = JSON.parse(decoder.decode(data)) as ActiveRunRecord;
      runs.push({ runId: key.slice(prefix.length), record });
    } catch {
      continue;
    }
  }
  return runs;
}

export async function cleanupActiveRunsForInstance(
  store: ControlPlaneStore,
  instanceId: string,
): Promise<number> {
  const keys = await store.list(`active-runs/${instanceId}/`);
  let cleaned = 0;
  for (const key of keys) {
    const deleted = await store.delete(key).then(() => true).catch(
      (err: unknown) => {
        logger.warn(
          "Failed to delete stale active-run record {key}: {error}",
          {
            key,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        return false;
      },
    );
    if (deleted) cleaned++;
  }
  return cleaned;
}
