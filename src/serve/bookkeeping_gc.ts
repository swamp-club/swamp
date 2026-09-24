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
 * Reaps ended step-lease and pending-dispatch records (swamp-club#2262).
 *
 * Both models declare `lifetime: "infinite"` and hold one data name per
 * record under a single instance, so without reaping every remote step
 * leaves a record behind forever. `isReapableLease` / `isReapableDispatch`
 * decide what may go; this module removes it.
 *
 * Deletes are sync-safe: each batch deletes locally and then pushes, as one
 * exclusive sync-gate unit, so a poller pull can never land between a delete
 * and its push and restore the record (swamp-club#2247). Batches are small
 * and the gate is released between them, so waiting runs never approach the
 * gate's wait timeout.
 */

import type { DataQueryService } from "../domain/data/data_query_service.ts";
import type { UnifiedDataRepository } from "../domain/data/repositories.ts";
import type { DatastoreSyncService } from "../domain/datastore/datastore_sync_service.ts";
import type { ModelType } from "../domain/models/model_type.ts";
import {
  isReapableDispatch,
  isReapableLease,
} from "../domain/models/worker/bookkeeping_retention.ts";
import {
  PENDING_DISPATCH_INSTANCE_NAME,
  PENDING_DISPATCH_MODEL_TYPE,
} from "../domain/models/worker/pending_dispatch_model.ts";
import {
  STEP_LEASE_INSTANCE_NAME,
  STEP_LEASE_MODEL_TYPE,
} from "../domain/models/worker/step_lease_model.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { ownNamespaceTerm } from "./namespace_predicate.ts";
import { type SyncGate, withSyncGate } from "./sync_gate.ts";

const logger = getSwampLogger(["serve", "bookkeeping-gc"]);

/** Records deleted per exclusive gate hold. */
export const DEFAULT_REAP_BATCH_SIZE = 100;

export interface BookkeepingReapResult {
  readonly leasesDeleted: number;
  readonly dispatchesDeleted: number;
  /** Records whose local delete threw; they are retried next cycle. */
  readonly failed: number;
  /** Records skipped because their body could not be read or parsed. */
  readonly unreadable: number;
  readonly batches: number;
  /** Batches whose push failed; their deletes stay queued as dirty paths. */
  readonly pushFailures: number;
}

/** Identifies one record in the catalog without its body. */
export interface BookkeepingRecordRef {
  readonly modelId: string;
  readonly name: string;
}

export interface BookkeepingGcDeps {
  /**
   * Lists matching records without reading their bodies. Bodies are read one
   * by one afterwards, so a single unreadable record cannot fail the listing.
   * Wire it with {@link createBookkeepingRecordQuery}.
   */
  query(predicate: string): Promise<BookkeepingRecordRef[]>;
  readonly repo: Pick<
    UnifiedDataRepository,
    "namespace" | "getContent" | "listVersions" | "delete"
  >;
  readonly syncService?: Pick<DatastoreSyncService, "pushChanged">;
  /** Datastore namespace passed to `pushChanged`. */
  readonly syncNamespace?: string;
  readonly syncGate?: SyncGate;
  readonly batchSize?: number;
  now?(): number;
}

/**
 * Adapts a catalog query service to {@link BookkeepingGcDeps.query}. A plain
 * query hydrates every matched record's body and fails outright if one cannot
 * be read; a `select` projection over metadata fields reads no bodies.
 */
export function createBookkeepingRecordQuery(
  dataQueryService: Pick<DataQueryService, "query">,
): (predicate: string) => Promise<BookkeepingRecordRef[]> {
  return async (predicate) => {
    const rows = await dataQueryService.query(predicate, {
      select: "[modelId, name]",
    });
    return rows.flatMap((row) =>
      Array.isArray(row) && typeof row[0] === "string" &&
        typeof row[1] === "string"
        ? [{ modelId: row[0], name: row[1] }]
        : []
    );
  };
}

interface ReapCandidate {
  readonly kind: "lease" | "dispatch";
  readonly modelType: ModelType;
  readonly modelId: string;
  readonly dataName: string;
}

interface BatchOutcome {
  leasesDeleted: number;
  dispatchesDeleted: number;
  failed: number;
  pushFailed: boolean;
}

/** Catalog predicate for one bookkeeping instance in the repo's namespace. */
export function bookkeepingListPredicate(
  modelType: ModelType,
  instanceName: string,
  namespace: string,
): string {
  return `modelType == ${JSON.stringify(modelType.normalized)} && ` +
    `modelName == ${JSON.stringify(instanceName)} && ` +
    ownNamespaceTerm(namespace);
}

const decoder = new TextDecoder();

/**
 * Reads one record's JSON body. Returns null when it is missing, unreadable
 * or not JSON, logging why — the record is kept and the sweep continues.
 */
async function readAttributes(
  deps: BookkeepingGcDeps,
  modelType: ModelType,
  record: BookkeepingRecordRef,
): Promise<unknown | null> {
  try {
    const content = await deps.repo.getContent(
      modelType,
      record.modelId,
      record.name,
    );
    if (content === null) return null;
    return JSON.parse(decoder.decode(content));
  } catch (error) {
    logger.warn("Skipping unreadable {kind} record {dataName}: {error}", {
      kind: modelType.normalized,
      dataName: record.name,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

interface BookkeepingKind {
  readonly kind: ReapCandidate["kind"];
  readonly modelType: ModelType;
  readonly instanceName: string;
  isReapable(attrs: unknown, gracePeriodMs: number, nowMs: number): boolean;
}

const BOOKKEEPING_KINDS: readonly BookkeepingKind[] = [
  {
    kind: "lease",
    modelType: STEP_LEASE_MODEL_TYPE,
    instanceName: STEP_LEASE_INSTANCE_NAME,
    isReapable: isReapableLease,
  },
  {
    kind: "dispatch",
    modelType: PENDING_DISPATCH_MODEL_TYPE,
    instanceName: PENDING_DISPATCH_INSTANCE_NAME,
    isReapable: isReapableDispatch,
  },
];

async function listCandidates(
  deps: BookkeepingGcDeps,
  gracePeriodMs: number,
  nowMs: number,
): Promise<{ candidates: ReapCandidate[]; unreadable: number }> {
  const candidates: ReapCandidate[] = [];
  let unreadable = 0;

  for (const spec of BOOKKEEPING_KINDS) {
    const records = await deps.query(
      bookkeepingListPredicate(
        spec.modelType,
        spec.instanceName,
        deps.repo.namespace,
      ),
    );
    for (const record of records) {
      const attrs = await readAttributes(deps, spec.modelType, record);
      if (attrs === null) {
        unreadable++;
        continue;
      }
      if (!spec.isReapable(attrs, gracePeriodMs, nowMs)) continue;
      candidates.push({
        kind: spec.kind,
        modelType: spec.modelType,
        modelId: record.modelId,
        dataName: record.name,
      });
    }
  }

  return { candidates, unreadable };
}

/**
 * Deletes one batch locally, then pushes. Must run inside the exclusive sync
 * gate (`withSyncGate`), so the delete and its push are one unit.
 */
async function reapBatch(
  deps: BookkeepingGcDeps,
  batch: readonly ReapCandidate[],
  isStopping: () => boolean,
): Promise<BatchOutcome> {
  const startedAt = performance.now();
  const outcome: BatchOutcome = {
    leasesDeleted: 0,
    dispatchesDeleted: 0,
    failed: 0,
    pushFailed: false,
  };
  try {
    for (const candidate of batch) {
      if (isStopping()) break;
      try {
        const versions = await deps.repo.listVersions(
          candidate.modelType,
          candidate.modelId,
          candidate.dataName,
        );
        // Delete even when nothing is on disk: it also drops a stale
        // catalog row. Only a real removal counts.
        await deps.repo.delete(
          candidate.modelType,
          candidate.modelId,
          candidate.dataName,
        );
        if (versions.length === 0) continue;
        if (candidate.kind === "lease") outcome.leasesDeleted++;
        else outcome.dispatchesDeleted++;
      } catch (error) {
        outcome.failed++;
        logger.warn("Failed to reap {kind} {dataName}: {error}", {
          kind: candidate.kind,
          dataName: candidate.dataName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    // Guarded so a push rejection never masks an error from the loop.
    try {
      await deps.syncService?.pushChanged({ namespace: deps.syncNamespace });
    } catch (error) {
      outcome.pushFailed = true;
      logger.warn("Failed to push reaped bookkeeping records: {error}", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  logger.debug(
    "Reaped batch of {count} record(s), gate held {heldMs}ms",
    {
      count: outcome.leasesDeleted + outcome.dispatchesDeleted,
      heldMs: Math.round(performance.now() - startedAt),
    },
  );
  return outcome;
}

/**
 * Deletes every ended lease and dispatch whose `endedAt` is at least
 * `gracePeriodMs` old. Active leases and waiting dispatches are never
 * touched. Stops between records and batches once `isStopping` returns true.
 */
export async function reapEndedBookkeepingRecords(
  deps: BookkeepingGcDeps,
  gracePeriodMs: number,
  isStopping: () => boolean = () => false,
): Promise<BookkeepingReapResult> {
  const nowMs = (deps.now ?? Date.now)();
  const { candidates, unreadable } = await listCandidates(
    deps,
    gracePeriodMs,
    nowMs,
  );
  const batchSize = Math.max(1, deps.batchSize ?? DEFAULT_REAP_BATCH_SIZE);

  let leasesDeleted = 0;
  let dispatchesDeleted = 0;
  let failed = 0;
  let batches = 0;
  let pushFailures = 0;

  for (let i = 0; i < candidates.length; i += batchSize) {
    if (isStopping()) break;
    const batch = candidates.slice(i, i + batchSize);
    const outcome = await withSyncGate(
      deps.syncGate,
      () => reapBatch(deps, batch, isStopping),
    );
    batches++;
    leasesDeleted += outcome.leasesDeleted;
    dispatchesDeleted += outcome.dispatchesDeleted;
    failed += outcome.failed;
    if (outcome.pushFailed) pushFailures++;
  }

  return {
    leasesDeleted,
    dispatchesDeleted,
    failed,
    unreadable,
    batches,
    pushFailures,
  };
}
