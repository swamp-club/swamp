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
 * List server tokens for the `swamp access token list` command.
 */

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";
import type { DataQueryService } from "../../domain/data/data_query_service.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import {
  SERVER_TOKEN_MODEL_TYPE,
  ServerTokenSchema,
  type ServerTokenState,
} from "../../domain/models/access/server_token_model.ts";

const TOKEN_DATA_NAME = "token-main";

export interface ServerTokenListItem {
  name: string;
  state: ServerTokenState;
  effectiveState: ServerTokenState;
  principalId: string;
  principalEmail: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
}

export interface ServerTokenListData {
  tokens: ServerTokenListItem[];
  count: number;
}

export type ServerTokenListEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: ServerTokenListData }
  | { kind: "error"; error: SwampError };

export interface ServerTokenListDeps {
  query: (predicate: string) => Promise<DataRecord[]>;
  now?: () => number;
}

export function createServerTokenListDeps(
  dataQueryService: DataQueryService,
): ServerTokenListDeps {
  return {
    query: async (predicate) => {
      const results = await dataQueryService.query(predicate, {
        loadAttributes: true,
      });
      return results as DataRecord[];
    },
  };
}

function effectiveTokenState(
  state: ServerTokenState,
  expiresAt: string,
  nowMs: number,
): ServerTokenState {
  if (state === "active" && Date.parse(expiresAt) <= nowMs) {
    return "expired";
  }
  return state;
}

export async function* serverTokenList(
  _ctx: LibSwampContext,
  deps: ServerTokenListDeps,
): AsyncGenerator<ServerTokenListEvent> {
  yield* withGeneratorSpan(
    "swamp.access.token.list",
    {},
    (async function* () {
      yield { kind: "resolving" as const };
      try {
        const records = await deps.query(
          `modelType == "${SERVER_TOKEN_MODEL_TYPE.normalized}" && ` +
            `name == "${TOKEN_DATA_NAME}"`,
        );
        const nowMs = (deps.now ?? Date.now)();
        const tokens: ServerTokenListItem[] = [];
        for (const record of records) {
          const parsed = ServerTokenSchema.safeParse(record.attributes);
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
            principalId: token.principalId,
            principalEmail: token.principalEmail,
            createdAt: token.createdAt,
            expiresAt: token.expiresAt,
            lastUsedAt: token.lastUsedAt,
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
            code: "server_token_list_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    })(),
  );
}
