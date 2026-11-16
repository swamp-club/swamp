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
import type { RunHandover } from "../domain/workflows/run_handover.ts";
import type {
  RunParker,
  WorkflowRun,
} from "../domain/workflows/workflow_run.ts";
import { refusalIsRetried } from "../domain/workflows/auto_continuation.ts";
import type { PendingRunOwner } from "../infrastructure/persistence/run_tracker_store.ts";
import { processHostIdentity } from "../infrastructure/runtime/process.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { withStoreDeadline } from "./pending_run_owner.ts";

const logger = getSwampLogger(["serve", "handover"]);

export const PARKED_RUN_PREFIX = "parked/";

export function parkedRunKey(runId: string): string {
  return `${PARKED_RUN_PREFIX}${runId}`;
}

/**
 * one per serve process: a planned restart fires it once, and every run the
 * process drives (API, webhook, cron, resumed) parks at its next step boundary
 */
export class ServeHandover {
  readonly #controller = new AbortController();
  readonly #instanceId: string | undefined;
  #markers: ControlPlaneStore | undefined;

  constructor(instanceId: string | undefined) {
    this.#instanceId = instanceId;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get begun(): boolean {
    return this.#controller.signal.aborted;
  }

  /**
   * where parked runs are listed for a process that started before this one
   * exits; without it the next process finds them only at its boot pass
   */
  useMarkerStore(store: ControlPlaneStore | undefined): void {
    this.#markers = store === undefined ? undefined : withStoreDeadline(store);
  }

  get markerStore(): ControlPlaneStore | undefined {
    return this.#markers;
  }

  begin(): void {
    this.#controller.abort();
  }

  forRun(eventSeq?: () => number): RunHandover {
    const instanceId = this.#instanceId;
    return {
      signal: this.#controller.signal,
      parker: () => ({
        instanceId,
        pid: Deno.pid,
        host: processHostIdentity(),
        eventSeq: eventSeq?.(),
      }),
      parked: (run) => this.#recordParked(run.id, run.workflowId, instanceId),
    };
  }

  async #recordParked(
    runId: string,
    workflowId: string,
    instanceId: string | undefined,
  ): Promise<void> {
    const store = this.#markers;
    if (store === undefined) return;
    const marker: ParkedRunMarker = {
      runId,
      workflowId,
      parker: { instanceId, pid: Deno.pid, host: processHostIdentity() },
    };
    try {
      await store.put(
        parkedRunKey(runId),
        new TextEncoder().encode(JSON.stringify(marker)),
      );
    } catch (error) {
      logger.warn("Failed to list parked run {runId}: {error}", {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export interface ParkedRunMarker {
  readonly runId: string;
  readonly workflowId: string;
  readonly parker: RunParker;
}

function parseMarker(
  key: string,
  data: Uint8Array,
): ParkedRunMarker | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(data));
    if (
      typeof parsed?.runId !== "string" ||
      typeof parsed?.workflowId !== "string" ||
      key !== parkedRunKey(parsed.runId)
    ) {
      return undefined;
    }
    return {
      runId: parsed.runId,
      workflowId: parsed.workflowId,
      parker: {
        instanceId: typeof parsed.parker?.instanceId === "string"
          ? parsed.parker.instanceId
          : undefined,
        pid: Number.isSafeInteger(parsed.parker?.pid)
          ? parsed.parker.pid
          : undefined,
        host: typeof parsed.parker?.host === "string"
          ? parsed.parker.host
          : undefined,
      },
    };
  } catch {
    return undefined;
  }
}

/** a marker that cannot be read is skipped; its run is found at a boot pass */
export async function listParkedRuns(
  store: ControlPlaneStore,
): Promise<ParkedRunMarker[]> {
  const markers: ParkedRunMarker[] = [];
  for (const key of await store.list(PARKED_RUN_PREFIX)) {
    const data = await store.get(key);
    if (!data) continue;
    const marker = parseMarker(key, data);
    if (marker !== undefined) markers.push(marker);
  }
  return markers;
}

// a run id from a client names a key in the store, so it may hold no separator
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;

export async function findParkedRun(
  store: ControlPlaneStore,
  runId: string,
): Promise<ParkedRunMarker | undefined> {
  if (!RUN_ID.test(runId)) return undefined;
  const key = parkedRunKey(runId);
  const data = await store.get(key);
  return data ? parseMarker(key, data) : undefined;
}

export async function forgetParkedRun(
  store: ControlPlaneStore,
  runId: string,
): Promise<void> {
  try {
    await store.delete(parkedRunKey(runId));
  } catch (error) {
    logger.warn("Failed to remove the parked marker of run {runId}: {error}", {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * the marker has done its job once the run reads continued or gone, or carries
 * a refusal for this interruption that nothing retries
 */
export function parkedRunHandled(run: WorkflowRun | null): boolean {
  if (run === null || !run.isParked) return true;
  const refused = run.autoContinuation?.refused;
  return refused !== undefined && !refusalIsRetried(refused.reason) &&
    refused.interruptedAt === run.continuableSince?.toISOString();
}

/**
 * a run parks only where a later process can continue it; elsewhere the drain
 * lets it run to completion, as a run nothing would continue must
 */
export function handsOverRuns(
  drainTimeoutMs: number,
  continuable: boolean,
): boolean {
  return drainTimeoutMs > 0 && continuable;
}

/** a parker that cannot be named counts as gone, as a reaped owner does */
export function parkerAsOwner(parker: RunParker): PendingRunOwner | undefined {
  if (parker.instanceId === undefined || parker.pid === undefined) {
    return undefined;
  }
  return {
    instanceId: parker.instanceId,
    pid: parker.pid,
    ...(parker.host !== undefined ? { host: parker.host } : {}),
  };
}
