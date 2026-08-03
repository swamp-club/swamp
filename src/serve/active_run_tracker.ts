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
import type { RunKind } from "./active_run_registry.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "active-run-tracker"]);

export interface ActiveRunRecord {
  instanceId: string;
  resourceName: string;
  runKind: RunKind;
  startedAt: string;
}

function activeRunKey(instanceId: string, runId: string): string {
  return `active-runs/${instanceId}/${runId}`;
}

const encoder = new TextEncoder();

export function writeActiveRun(
  store: ControlPlaneStore,
  instanceId: string,
  runId: string,
  record: Omit<ActiveRunRecord, "instanceId">,
): void {
  const full: ActiveRunRecord = { instanceId, ...record };
  store.put(
    activeRunKey(instanceId, runId),
    encoder.encode(JSON.stringify(full)),
  )
    .catch((err: unknown) => {
      logger.warn("Failed to write active-run record for {runId}: {error}", {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

export function deleteActiveRun(
  store: ControlPlaneStore,
  instanceId: string,
  runId: string,
): void {
  store.delete(activeRunKey(instanceId, runId))
    .catch((err: unknown) => {
      logger.warn("Failed to delete active-run record for {runId}: {error}", {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

export function rekeyActiveRun(
  store: ControlPlaneStore,
  instanceId: string,
  oldRunId: string,
  newRunId: string,
  record: Omit<ActiveRunRecord, "instanceId">,
): void {
  const full: ActiveRunRecord = { instanceId, ...record };
  Promise.all([
    store.delete(activeRunKey(instanceId, oldRunId)),
    store.put(
      activeRunKey(instanceId, newRunId),
      encoder.encode(JSON.stringify(full)),
    ),
  ]).catch((err: unknown) => {
    logger.warn(
      "Failed to rekey active-run record from {oldRunId} to {newRunId}: {error}",
      {
        oldRunId,
        newRunId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  });
}

const decoder = new TextDecoder();

export async function findActiveRunByRunId(
  store: ControlPlaneStore,
  runId: string,
): Promise<{ record: ActiveRunRecord; instanceId: string } | null> {
  const keys = await store.list("active-runs/");
  const suffix = `/${runId}`;
  for (const key of keys) {
    if (key.endsWith(suffix)) {
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
