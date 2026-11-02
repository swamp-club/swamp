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
 * deletes are sync-safe: each batch deletes locally then pushes as one
 * exclusive gate unit, so a poller pull cannot land between and restore the
 * record; small batches keep gate waits short
 */

import type { DataQueryService } from "../domain/data/data_query_service.ts";
import type { UnifiedDataRepository } from "../domain/data/repositories.ts";
import type {
  DatastoreSyncService,
  MarkDirtyHook,
} from "../domain/datastore/datastore_sync_service.ts";
import type { ModelType } from "../domain/models/model_type.ts";
import {
  isReapableDispatch,
  isReapableEnrollmentToken,
  isReapableLease,
} from "../domain/models/worker/bookkeeping_retention.ts";
import { ENROLLMENT_TOKEN_MODEL_TYPE } from "../domain/models/worker/enrollment_token_model.ts";
import { WORKER_MODEL_TYPE } from "../domain/models/worker/worker_model.ts";
import {
  PENDING_DISPATCH_INSTANCE_NAME,
  PENDING_DISPATCH_MODEL_TYPE,
} from "../domain/models/worker/pending_dispatch_model.ts";
import {
  STEP_LEASE_INSTANCE_NAME,
  STEP_LEASE_MODEL_TYPE,
} from "../domain/models/worker/step_lease_model.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { runInRootUnitOfWork } from "../infrastructure/persistence/repo_unit_of_work.ts";
import { ownNamespaceTerm } from "./namespace_predicate.ts";
import { type SyncGate, withSyncGate } from "./sync_gate.ts";

const logger = getSwampLogger(["serve", "bookkeeping-gc"]);

export const DEFAULT_REAP_BATCH_SIZE = 100;

export interface BookkeepingReapResult {
  readonly leasesDeleted: number;
  readonly dispatchesDeleted: number;
  readonly tokensDeleted: number;
  readonly failed: number;
  readonly unreadable: number;
  readonly batches: number;
  readonly pushFailures: number;
}

export interface BookkeepingRecordRef {
  readonly modelId: string;
  readonly name: string;
}

export interface BookkeepingGcDeps {
  /**
   * lists records without reading bodies; bodies are read one by one afterwards
   * so one unreadable record cannot fail the listing
   */
  query(predicate: string): Promise<BookkeepingRecordRef[]>;
  readonly repo: Pick<
    UnifiedDataRepository,
    "namespace" | "getContent" | "listVersions" | "delete"
  >;
  /**
   * each batch runs in a root unit of work over this hook, so the deletes stage
   * into the root
   */
  readonly markDirty?: MarkDirtyHook;
  readonly syncService?: Pick<DatastoreSyncService, "pushChanged">;
  readonly syncNamespace?: string;
  readonly syncGate?: SyncGate;
  readonly batchSize?: number;
  /**
   * tokens are reaped only when this is wired, and a token any worker record
   * names is kept; when it throws, no token is reaped that cycle
   */
  listWorkerTokenNames?(): Promise<ReadonlySet<string>>;
  now?(): number;
}

/**
 * a plain query hydrates every body and fails if one is unreadable; a select
 * over metadata fields reads no bodies
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

/**
 * throws when a worker record has no readable token name, so an unknown
 * reference never lets a token go
 */
export function createWorkerTokenNameQuery(
  dataQueryService: Pick<DataQueryService, "query">,
  namespace: string,
): () => Promise<ReadonlySet<string>> {
  return async () => {
    const rows = await dataQueryService.query(
      `modelType == ${JSON.stringify(WORKER_MODEL_TYPE.normalized)} && ` +
        `name == "state-main" && ${ownNamespaceTerm(namespace)}`,
      { select: "attributes.tokenName" },
    );
    const names = new Set<string>();
    for (const row of rows) {
      if (typeof row !== "string" || row.length === 0) {
        throw new Error("a worker record has no readable token name");
      }
      names.add(row);
    }
    return names;
  };
}

interface ReapCandidate {
  readonly kind: "lease" | "dispatch" | "token";
  readonly modelType: ModelType;
  readonly modelId: string;
  readonly dataName: string;
}

interface BatchOutcome {
  leasesDeleted: number;
  dispatchesDeleted: number;
  tokensDeleted: number;
  failed: number;
  pushFailed: boolean;
}

const ENROLLMENT_TOKEN_DATA_NAME = "token-main";

export function enrollmentTokenListPredicate(namespace: string): string {
  return `modelType == ${
    JSON.stringify(ENROLLMENT_TOKEN_MODEL_TYPE.normalized)
  } && ` +
    `name == ${JSON.stringify(ENROLLMENT_TOKEN_DATA_NAME)} && ` +
    ownNamespaceTerm(namespace);
}

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
 * null when the body is missing, unreadable or not JSON, logged; the record is
 * kept and the sweep continues
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
  predicate(namespace: string): string;
  isReapable(attrs: unknown, gracePeriodMs: number, nowMs: number): boolean;
}

const BOOKKEEPING_KINDS: readonly BookkeepingKind[] = [
  {
    kind: "lease",
    modelType: STEP_LEASE_MODEL_TYPE,
    predicate: (namespace) =>
      bookkeepingListPredicate(
        STEP_LEASE_MODEL_TYPE,
        STEP_LEASE_INSTANCE_NAME,
        namespace,
      ),
    isReapable: isReapableLease,
  },
  {
    kind: "dispatch",
    modelType: PENDING_DISPATCH_MODEL_TYPE,
    predicate: (namespace) =>
      bookkeepingListPredicate(
        PENDING_DISPATCH_MODEL_TYPE,
        PENDING_DISPATCH_INSTANCE_NAME,
        namespace,
      ),
    isReapable: isReapableDispatch,
  },
];

function tokenNameOf(attrs: unknown): string | undefined {
  if (typeof attrs !== "object" || attrs === null) return undefined;
  const name = (attrs as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

async function enrollmentTokenKind(
  deps: BookkeepingGcDeps,
): Promise<BookkeepingKind | null> {
  if (!deps.listWorkerTokenNames) return null;
  let referenced: ReadonlySet<string>;
  try {
    referenced = await deps.listWorkerTokenNames();
  } catch (error) {
    logger.warn(
      "Skipping enrollment token reaping: cannot list worker token references: {error}",
      { error: error instanceof Error ? error.message : String(error) },
    );
    return null;
  }
  return {
    kind: "token",
    modelType: ENROLLMENT_TOKEN_MODEL_TYPE,
    predicate: enrollmentTokenListPredicate,
    isReapable: (attrs, gracePeriodMs, nowMs) => {
      const name = tokenNameOf(attrs);
      if (name === undefined || referenced.has(name)) return false;
      return isReapableEnrollmentToken(attrs, gracePeriodMs, nowMs);
    },
  };
}

async function listCandidates(
  deps: BookkeepingGcDeps,
  gracePeriodMs: number,
  nowMs: number,
): Promise<{ candidates: ReapCandidate[]; unreadable: number }> {
  const candidates: ReapCandidate[] = [];
  let unreadable = 0;

  const tokenKind = await enrollmentTokenKind(deps);
  const kinds = tokenKind
    ? [...BOOKKEEPING_KINDS, tokenKind]
    : BOOKKEEPING_KINDS;
  for (const spec of kinds) {
    const records = await deps.query(spec.predicate(deps.repo.namespace));
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
 * must run inside the exclusive sync gate so delete and push are one unit; the
 * root unit of work flushes by pushing, on every outcome
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
    tokensDeleted: 0,
    failed: 0,
    pushFailed: false,
  };
  await runInRootUnitOfWork({ markDirty: deps.markDirty }, {
    flush: async () => {
      // Guarded so a push rejection never masks an error from the loop.
      try {
        await deps.syncService?.pushChanged({ namespace: deps.syncNamespace });
      } catch (error) {
        outcome.pushFailed = true;
        logger.warn("Failed to push reaped bookkeeping records: {error}", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  }, async () => {
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
        else if (candidate.kind === "dispatch") outcome.dispatchesDeleted++;
        else outcome.tokensDeleted++;
      } catch (error) {
        outcome.failed++;
        logger.warn("Failed to reap {kind} {dataName}: {error}", {
          kind: candidate.kind,
          dataName: candidate.dataName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });
  logger.debug(
    "Reaped batch of {count} record(s), gate held {heldMs}ms",
    {
      count: outcome.leasesDeleted + outcome.dispatchesDeleted +
        outcome.tokensDeleted,
      heldMs: Math.round(performance.now() - startedAt),
    },
  );
  return outcome;
}

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
  let tokensDeleted = 0;
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
    tokensDeleted += outcome.tokensDeleted;
    failed += outcome.failed;
    if (outcome.pushFailed) pushFailures++;
  }

  return {
    leasesDeleted,
    dispatchesDeleted,
    tokensDeleted,
    failed,
    unreadable,
    batches,
    pushFailures,
  };
}
