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

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";
import type { DataQueryService } from "../../domain/data/data_query_service.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import {
  PENDING_DISPATCH_MODEL_TYPE,
  PendingDispatchSchema,
} from "../../domain/models/worker/pending_dispatch_model.ts";

export interface WorkerQueueListItem {
  queueId: string;
  requirement: string;
  workflowName: string | undefined;
  jobName: string | undefined;
  stepName: string | undefined;
  modelType: string;
  methodName: string;
  queuedAt: string;
  ageMs: number;
}

export interface WorkerQueueListData {
  items: WorkerQueueListItem[];
  count: number;
}

export type WorkerQueueListEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkerQueueListData }
  | { kind: "error"; error: SwampError };

export interface WorkerQueueListDeps {
  query: (predicate: string) => Promise<DataRecord[]>;
  now?: () => number;
}

export function createWorkerQueueListDeps(
  dataQueryService: DataQueryService,
): WorkerQueueListDeps {
  return {
    query: async (predicate) => {
      const results = await dataQueryService.query(predicate, {
        loadAttributes: true,
      });
      return results as DataRecord[];
    },
  };
}

function formatRequirement(record: {
  target?: string;
  labels?: Record<string, string>;
  platform?: string;
}): string {
  const parts: string[] = [];
  if (record.target) parts.push(`target=${record.target}`);
  if (record.labels) {
    for (const [k, v] of Object.entries(record.labels)) {
      parts.push(`${k}=${v}`);
    }
  }
  if (record.platform) parts.push(`platform=${record.platform}`);
  return parts.length > 0 ? parts.join(", ") : "any worker";
}

export async function* workerQueueList(
  _ctx: LibSwampContext,
  deps: WorkerQueueListDeps,
): AsyncGenerator<WorkerQueueListEvent> {
  yield* withGeneratorSpan(
    "swamp.worker.queue.list",
    {},
    (async function* () {
      yield { kind: "resolving" as const };
      try {
        const records = await deps.query(
          `modelType == "${PENDING_DISPATCH_MODEL_TYPE.normalized}" && ` +
            `attributes.state == "waiting"`,
        );
        const nowMs = (deps.now ?? Date.now)();
        const items: WorkerQueueListItem[] = [];
        for (const record of records) {
          const parsed = PendingDispatchSchema.safeParse(record.attributes);
          if (!parsed.success) continue;
          const pd = parsed.data;
          items.push({
            queueId: pd.queueId,
            requirement: formatRequirement(pd),
            workflowName: pd.workflowName,
            jobName: pd.jobName,
            stepName: pd.stepName,
            modelType: pd.modelType,
            methodName: pd.methodName,
            queuedAt: pd.queuedAt,
            ageMs: nowMs - Date.parse(pd.queuedAt),
          });
        }
        items.sort(
          (a, b) => Date.parse(a.queuedAt) - Date.parse(b.queuedAt),
        );
        yield {
          kind: "completed" as const,
          data: { items, count: items.length },
        };
      } catch (error) {
        yield {
          kind: "error" as const,
          error: {
            code: "worker_queue_list_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    })(),
  );
}
