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

import type { DataRecord } from "../../domain/data/data_record.ts";
import type { DataQueryService } from "../../domain/data/data_query_service.ts";
import {
  type Integration,
  INTEGRATION_DATA_NAME,
  INTEGRATION_MODEL_TYPE,
  IntegrationSchema,
  type IntegrationState,
} from "../../domain/models/access/integration_model.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

/** the credential's hash stays off every list, as the credential itself does */
export interface IntegrationView {
  readonly id: string;
  readonly name: string;
  readonly state: IntegrationState | "unreadable";
  readonly ceiling: unknown;
  readonly ceilingDigest: string;
  readonly createdAt: string;
  readonly ceilingChangedAt?: string;
  readonly revokedAt?: string;
}

export function integrationView(integration: Integration): IntegrationView {
  return {
    id: integration.id,
    name: integration.name,
    state: integration.state,
    ceiling: integration.ceiling,
    ceilingDigest: integration.ceilingDigest,
    createdAt: integration.createdAt,
    ...(integration.ceilingChangedAt
      ? { ceilingChangedAt: integration.ceilingChangedAt }
      : {}),
    ...(integration.revokedAt ? { revokedAt: integration.revokedAt } : {}),
  };
}

function unreadableView(id: string): IntegrationView {
  return {
    id,
    name: id,
    state: "unreadable",
    ceiling: null,
    ceilingDigest: "",
    createdAt: "",
  };
}

export interface IntegrationListData {
  readonly integrations: readonly IntegrationView[];
  readonly count: number;
}

export type IntegrationListEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: IntegrationListData }
  | { kind: "error"; error: SwampError };

export interface IntegrationListDeps {
  query: (predicate: string) => Promise<DataRecord[]>;
}

export function createIntegrationListDeps(
  dataQueryService: DataQueryService,
): IntegrationListDeps {
  return {
    query: async (predicate) =>
      await dataQueryService.query(predicate, {
        loadAttributes: true,
      }) as DataRecord[],
  };
}

export async function* integrationList(
  _ctx: LibSwampContext,
  deps: IntegrationListDeps,
): AsyncGenerator<IntegrationListEvent> {
  yield* withGeneratorSpan(
    "swamp.access.integration.list",
    {},
    (async function* () {
      yield { kind: "resolving" as const };
      try {
        const records = await deps.query(
          `modelType == "${INTEGRATION_MODEL_TYPE.normalized}" && ` +
            `name == "${INTEGRATION_DATA_NAME}"`,
        );
        const integrations = records.flatMap((record) => {
          const parsed = IntegrationSchema.safeParse(record.attributes);
          if (parsed.success) return [integrationView(parsed.data)];
          // serve refuses it, so an operator needs to see it to diagnose that
          const id = (record.attributes as { id?: unknown } | null)?.id;
          return typeof id === "string" ? [unreadableView(id)] : [];
        }).sort((a, b) => a.id.localeCompare(b.id));
        yield {
          kind: "completed" as const,
          data: { integrations, count: integrations.length },
        };
      } catch (error) {
        yield {
          kind: "error" as const,
          error: {
            code: "integration_list_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    })(),
  );
}
