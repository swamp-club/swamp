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
  type Binding,
  ENROLLMENT_TOKEN_MODEL_TYPE,
  EnrollmentTokenSchema,
  type MaxEnrollments,
  type TokenState,
} from "../../domain/models/worker/enrollment_token_model.ts";
import {
  WORKER_MODEL_TYPE,
  WorkerStateSchema,
  type WorkerStatus,
} from "../../domain/models/worker/worker_model.ts";

const TOKEN_DATA_NAME = "token-main";
const WORKER_STATE_DATA_NAME = "state-main";

export interface WorkerTokenListItem {
  name: string;
  state: TokenState;
  /**
   * display state: unused or enrolled tokens past expiresAt show as expired;
   * the recorded state changes only when the orchestrator runs the expire
   * method
   */
  effectiveState: TokenState;
  createdAt: string;
  expiresAt: string;
  maxEnrollments: MaxEnrollments;
  bindingCount: number;
  bindings: Binding[];
  vaultName: string;
  secretKey: string;
}

export interface WorkerTokenListData {
  tokens: WorkerTokenListItem[];
  count: number;
}

export type WorkerTokenListEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkerTokenListData }
  | { kind: "error"; error: SwampError };

export interface WorkerListItem {
  name: string;
  tokenName: string;
  status: WorkerStatus;
  labels: Record<string, string>;
  platform: string;
  arch: string;
  instanceUuid: string;
  enrolledAt: string;
  lastSeenAt: string;
  capacity: number;
  activeDispatchIds: string[];
  disconnectedAt?: string;
}

export interface WorkerListData {
  workers: WorkerListItem[];
  count: number;
  filteredDisconnectedCount?: number;
}

export interface WorkerListOptions {
  includeDisconnected?: boolean;
  /**
   * Also keep disconnected workers whose `disconnectedAt` is no older than
   * this many milliseconds. Ignored when `includeDisconnected` is set; a
   * disconnected worker without `disconnectedAt` is never kept by the window.
   */
  disconnectedWithinMs?: number;
}

export type WorkerListEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkerListData }
  | { kind: "error"; error: SwampError };

export interface WorkerListDeps {
  query: (predicate: string) => Promise<DataRecord[]>;
  now?: () => number;
}

export function createWorkerListDeps(
  dataQueryService: DataQueryService,
): WorkerListDeps {
  return {
    query: async (predicate) => {
      const results = await dataQueryService.query(predicate, {
        loadAttributes: true,
      });
      return results as DataRecord[];
    },
  };
}

export function effectiveTokenState(
  state: TokenState,
  expiresAt: string,
  nowMs: number,
): TokenState {
  if (
    (state === "unused" || state === "enrolled") &&
    Date.parse(expiresAt) <= nowMs
  ) {
    return "expired";
  }
  return state;
}

export async function* workerTokenList(
  _ctx: LibSwampContext,
  deps: WorkerListDeps,
): AsyncGenerator<WorkerTokenListEvent> {
  yield* withGeneratorSpan(
    "swamp.worker.token.list",
    {},
    (async function* () {
      yield { kind: "resolving" as const };
      try {
        const records = await deps.query(
          `modelType == "${ENROLLMENT_TOKEN_MODEL_TYPE.normalized}" && ` +
            `name == "${TOKEN_DATA_NAME}"`,
        );
        const nowMs = (deps.now ?? Date.now)();
        const tokens: WorkerTokenListItem[] = [];
        for (const record of records) {
          const parsed = EnrollmentTokenSchema.safeParse(record.attributes);
          if (!parsed.success) continue;
          const token = parsed.data;
          tokens.push({
            name: token.name,
            state: token.state,
            effectiveState: effectiveTokenState(
              token.state,
              token.expiresAt,
              nowMs,
            ),
            createdAt: token.createdAt,
            expiresAt: token.expiresAt,
            maxEnrollments: token.maxEnrollments,
            bindingCount: token.bindings.length,
            bindings: token.bindings,
            vaultName: token.vaultName,
            secretKey: token.secretKey,
          });
        }
        tokens.sort((a, b) => a.name.localeCompare(b.name));
        yield {
          kind: "completed" as const,
          data: { tokens, count: tokens.length },
        };
      } catch (error) {
        yield {
          kind: "error" as const,
          error: {
            code: "worker_token_list_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    })(),
  );
}

export async function* workerList(
  _ctx: LibSwampContext,
  deps: WorkerListDeps,
  options?: WorkerListOptions,
): AsyncGenerator<WorkerListEvent> {
  yield* withGeneratorSpan(
    "swamp.worker.list",
    {},
    (async function* () {
      yield { kind: "resolving" as const };
      try {
        const records = await deps.query(
          `modelType == "${WORKER_MODEL_TYPE.normalized}" && ` +
            `name == "${WORKER_STATE_DATA_NAME}"`,
        );
        const allWorkers: WorkerListItem[] = [];
        for (const record of records) {
          const parsed = WorkerStateSchema.safeParse(record.attributes);
          if (!parsed.success) continue;
          const state = parsed.data;
          allWorkers.push({
            name: state.name,
            tokenName: state.tokenName,
            status: state.status,
            labels: state.labels,
            platform: state.platform,
            arch: state.arch,
            instanceUuid: state.instanceUuid,
            enrolledAt: state.enrolledAt,
            lastSeenAt: state.lastSeenAt,
            capacity: state.capacity ?? 1,
            activeDispatchIds: state.activeDispatchIds ?? [],
            // A reconnected worker can carry a stale disconnectedAt; only a
            // disconnected one reports it.
            ...(state.status === "disconnected" &&
                state.disconnectedAt !== undefined
              ? { disconnectedAt: state.disconnectedAt }
              : {}),
          });
        }
        allWorkers.sort((a, b) => a.name.localeCompare(b.name));

        const includeDisconnected = options?.includeDisconnected ?? false;
        const windowMs = options?.disconnectedWithinMs;
        const nowMs = (deps.now ?? Date.now)();
        const keepDisconnected = (w: WorkerListItem): boolean =>
          windowMs !== undefined && w.disconnectedAt !== undefined &&
          nowMs - Date.parse(w.disconnectedAt) <= windowMs;
        const workers = includeDisconnected
          ? allWorkers
          : allWorkers.filter((w) =>
            w.status !== "disconnected" || keepDisconnected(w)
          );
        const filteredDisconnectedCount = allWorkers.length - workers.length;

        yield {
          kind: "completed" as const,
          data: {
            workers,
            count: workers.length,
            ...(filteredDisconnectedCount > 0
              ? { filteredDisconnectedCount }
              : {}),
          },
        };
      } catch (error) {
        yield {
          kind: "error" as const,
          error: {
            code: "worker_list_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    })(),
  );
}
