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
 * List worker pool state and enrollment tokens (see
 * design/remote-execution.md, "Worker state is swamp data").
 *
 * Both operations read the latest versions of the built-in models' resource
 * data through the same datastore query primitive workflows use — there is
 * no bespoke pool registry to consult.
 */

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";
import type { DataQueryService } from "../../domain/data/data_query_service.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import {
  ENROLLMENT_TOKEN_MODEL_TYPE,
  EnrollmentTokenSchema,
  type TokenState,
} from "../../domain/models/worker/enrollment_token_model.ts";
import {
  WORKER_MODEL_TYPE,
  WorkerStateSchema,
  type WorkerStatus,
} from "../../domain/models/worker/worker_model.ts";

const TOKEN_DATA_NAME = "token-main";
const WORKER_STATE_DATA_NAME = "state-main";

/** One enrollment token in the list. */
export interface WorkerTokenListItem {
  name: string;
  /** Lifecycle state as recorded in the datastore. */
  state: TokenState;
  /**
   * Display state: recorded `unused`/`enrolled` tokens whose `expiresAt`
   * has passed show as `expired`. Display-level only — the recorded state
   * transitions when the orchestrator runs the `expire` method.
   */
  effectiveState: TokenState;
  createdAt: string;
  expiresAt: string;
  boundMachineId?: string;
  vaultName: string;
  secretKey: string;
}

/** Data payload for the token list completed event. */
export interface WorkerTokenListData {
  tokens: WorkerTokenListItem[];
  count: number;
}

export type WorkerTokenListEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkerTokenListData }
  | { kind: "error"; error: SwampError };

/** One enrolled worker in the list. */
export interface WorkerListItem {
  name: string;
  status: WorkerStatus;
  labels: Record<string, string>;
  platform: string;
  arch: string;
  instanceUuid: string;
  enrolledAt: string;
  lastSeenAt: string;
  currentDispatchId: string | null;
}

/** Data payload for the worker list completed event. */
export interface WorkerListData {
  workers: WorkerListItem[];
  count: number;
}

export type WorkerListEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkerListData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the worker list operations. */
export interface WorkerListDeps {
  /** Returns the latest data records matching a CEL predicate, with
   * JSON attributes loaded. */
  query: (predicate: string) => Promise<DataRecord[]>;
  /** Clock — injectable for the display-level expiry overlay. */
  now?: () => number;
}

/** Wires the repo's data query service into WorkerListDeps. */
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

/**
 * Computes the display state for a token: recorded live states past their
 * expiry render as `expired`.
 */
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

/**
 * Lists all enrollment tokens, newest record first by name.
 */
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
            boundMachineId: token.boundMachineId,
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

/**
 * Lists all workers known to the pool, sorted by name.
 */
export async function* workerList(
  _ctx: LibSwampContext,
  deps: WorkerListDeps,
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
        const workers: WorkerListItem[] = [];
        for (const record of records) {
          const parsed = WorkerStateSchema.safeParse(record.attributes);
          if (!parsed.success) continue;
          const state = parsed.data;
          workers.push({
            name: state.name,
            status: state.status,
            labels: state.labels,
            platform: state.platform,
            arch: state.arch,
            instanceUuid: state.instanceUuid,
            enrolledAt: state.enrolledAt,
            lastSeenAt: state.lastSeenAt,
            currentDispatchId: state.currentDispatchId,
          });
        }
        workers.sort((a, b) => a.name.localeCompare(b.name));
        yield {
          kind: "completed" as const,
          data: { workers, count: workers.length },
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
