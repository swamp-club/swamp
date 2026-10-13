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
 * List the step leases that occupy worker dispatch slots: the leases behind
 * a set of active dispatch ids, plus leases recently written (and so
 * recently ended). Read-only over the records DispatchService writes.
 */

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";
import type { DataQueryService } from "../../domain/data/data_query_service.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import {
  leaseDataName,
  type LeaseState,
  STEP_LEASE_INSTANCE_NAME,
  STEP_LEASE_MODEL_TYPE,
  StepLeaseSchema,
} from "../../domain/models/worker/step_lease_model.ts";

/** One step lease occupying, or recently occupying, a worker slot. */
export interface WorkerLeaseListItem {
  leaseId: string;
  dispatchId: string;
  workerName: string;
  state: LeaseState;
  workflowName?: string;
  workflowRunId?: string;
  jobName?: string;
  stepName?: string;
  modelType: string;
  methodName: string;
  createdAt: string;
  endedAt?: string;
}

export interface WorkerLeaseListData {
  leases: WorkerLeaseListItem[];
  count: number;
}

export type WorkerLeaseListEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkerLeaseListData }
  | { kind: "error"; error: SwampError };

export interface WorkerLeaseListOptions {
  /** Dispatch ids whose leases to return; a lease is named by its dispatch id. */
  dispatchIds?: readonly string[];
  /** Also return leases whose latest version was written this recently. */
  endedWithinMs?: number;
}

export interface WorkerLeaseListDeps {
  query: (predicate: string) => Promise<DataRecord[]>;
  /** The repo's datastore namespace; rows pulled from other namespaces are ignored. */
  namespace: string;
  now?: () => number;
}

export function createWorkerLeaseListDeps(
  dataQueryService: DataQueryService,
  namespace: string,
): WorkerLeaseListDeps {
  return {
    namespace,
    query: async (predicate) => {
      const results = await dataQueryService.query(predicate, {
        loadAttributes: true,
      });
      return results as DataRecord[];
    },
  };
}

/**
 * Builds the catalog predicate. Every term is metadata (type, instance,
 * namespace, name, version time). The data query service loads attributes
 * lazily, only for rows that match (swamp-club#2122), so this stays cheap
 * even with `loadAttributes: true`; if that loading turned eager, this query
 * would read every lease kept for the GC window. Values are JSON-quoted,
 * never spliced in raw.
 */
export function leaseListPredicate(
  namespace: string,
  dispatchIds: readonly string[],
  endedSinceIso: string | undefined,
): string | undefined {
  const selectors: string[] = [];
  if (dispatchIds.length > 0) {
    const names = dispatchIds.map((id) => JSON.stringify(leaseDataName(id)));
    selectors.push(`name in [${names.join(", ")}]`);
  }
  if (endedSinceIso !== undefined) {
    selectors.push(`createdAt >= ${JSON.stringify(endedSinceIso)}`);
  }
  if (selectors.length === 0) return undefined;
  return `modelType == ${
    JSON.stringify(STEP_LEASE_MODEL_TYPE.normalized)
  } && ` +
    `modelName == ${JSON.stringify(STEP_LEASE_INSTANCE_NAME)} && ` +
    `ns == ${JSON.stringify(namespace)} && ` +
    `(${selectors.join(" || ")})`;
}

export async function* workerLeaseList(
  _ctx: LibSwampContext,
  deps: WorkerLeaseListDeps,
  options?: WorkerLeaseListOptions,
): AsyncGenerator<WorkerLeaseListEvent> {
  yield* withGeneratorSpan(
    "swamp.worker.lease.list",
    {},
    (async function* () {
      yield { kind: "resolving" as const };
      try {
        const nowMs = (deps.now ?? Date.now)();
        const endedSinceIso = options?.endedWithinMs === undefined
          ? undefined
          : new Date(nowMs - options.endedWithinMs).toISOString();
        const predicate = leaseListPredicate(
          deps.namespace,
          options?.dispatchIds ?? [],
          endedSinceIso,
        );
        const records = predicate === undefined
          ? []
          : await deps.query(predicate);
        const leases: WorkerLeaseListItem[] = [];
        for (const record of records) {
          const parsed = StepLeaseSchema.safeParse(record.attributes);
          if (!parsed.success) continue;
          const lease = parsed.data;
          leases.push({
            leaseId: lease.leaseId,
            dispatchId: lease.dispatchId,
            workerName: lease.workerName,
            state: lease.state,
            workflowName: lease.workflowName,
            workflowRunId: lease.workflowRunId,
            jobName: lease.jobName,
            stepName: lease.stepName,
            modelType: lease.modelType,
            methodName: lease.methodName,
            createdAt: lease.createdAt,
            endedAt: lease.endedAt,
          });
        }
        leases.sort((a, b) =>
          a.workerName.localeCompare(b.workerName) ||
          a.createdAt.localeCompare(b.createdAt)
        );
        yield {
          kind: "completed" as const,
          data: { leases, count: leases.length },
        };
      } catch (error) {
        yield {
          kind: "error" as const,
          error: {
            code: "worker_lease_list_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    })(),
  );
}
