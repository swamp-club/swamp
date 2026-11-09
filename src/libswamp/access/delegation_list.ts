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
  DELEGATION_DATA_NAME,
  DELEGATION_MODEL_TYPE,
  type DelegationPhase,
  type DelegationRecord,
  DelegationSchema,
} from "../../domain/models/access/delegation_model.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

export type DelegationViewState = DelegationPhase | "unreadable";

/** never a token, a hash or the consent URL: a list is shown to operators and scripts */
export interface DelegationView {
  readonly id: string;
  readonly integrationId: string;
  readonly state: DelegationViewState;
  readonly person?: { readonly username?: string; readonly email: string };
  readonly external: {
    readonly platform: string;
    readonly teamId: string;
    readonly userId: string;
    readonly display: string;
    readonly workspace: string;
  };
  readonly ceilingDigest: string;
  readonly createdAt: string;
  readonly consentedAt?: string;
  readonly expiresAt?: string;
  readonly endedAt?: string;
  readonly endCause?: string;
  readonly refusalReason?: string;
  readonly club: {
    readonly linkId?: string;
    readonly endState: DelegationRecord["club"]["endState"];
    readonly endAttempts: number;
    readonly lastEndError?: string;
    readonly nextEndAttemptAt?: string;
  };
  readonly tokenGeneration?: number;
  readonly accessTokenExpiresAt?: string;
}

export function delegationView(record: DelegationRecord): DelegationView {
  const { club, person, tokens } = record;
  return {
    id: record.id,
    integrationId: record.integrationId,
    state: record.phase,
    ...(person
      ? {
        person: {
          ...(person.username !== undefined
            ? { username: person.username }
            : {}),
          email: person.email,
        },
      }
      : {}),
    external: {
      platform: record.external.platform,
      teamId: record.external.teamId,
      userId: record.external.userId,
      display: record.external.display,
      workspace: record.external.workspace,
    },
    ceilingDigest: record.ceilingDigest,
    createdAt: record.createdAt,
    ...(record.consentedAt ? { consentedAt: record.consentedAt } : {}),
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
    ...(record.ended
      ? { endedAt: record.ended.at, endCause: record.ended.cause }
      : {}),
    ...(record.refusal
      ? { endedAt: record.refusal.at, refusalReason: record.refusal.reason }
      : {}),
    club: {
      ...(club.linkId !== undefined ? { linkId: club.linkId } : {}),
      endState: club.endState,
      endAttempts: club.endAttempts,
      ...(club.lastEndError !== undefined
        ? { lastEndError: club.lastEndError }
        : {}),
      ...(club.nextEndAttemptAt !== undefined
        ? { nextEndAttemptAt: club.nextEndAttemptAt }
        : {}),
    },
    ...(tokens
      ? {
        tokenGeneration: tokens.generation,
        accessTokenExpiresAt: tokens.accessExpiresAt,
      }
      : {}),
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** only fields that hold no secret are read from a record that fails the schema */
export function unreadableDelegationView(
  id: string,
  attributes: Record<string, unknown>,
): DelegationView {
  const external = (attributes.external ?? {}) as Record<string, unknown>;
  return {
    id,
    integrationId: text(attributes.integrationId),
    state: "unreadable",
    external: {
      platform: text(external.platform),
      teamId: text(external.teamId),
      userId: text(external.userId),
      display: text(external.display),
      workspace: text(external.workspace),
    },
    ceilingDigest: "",
    createdAt: text(attributes.createdAt),
    club: { endState: "none", endAttempts: 0 },
  };
}

/** a record that names no id can't be shown, ended or diagnosed by id */
export function viewOfDelegationAttributes(
  attributes: unknown,
): DelegationView | undefined {
  const parsed = DelegationSchema.safeParse(attributes);
  if (parsed.success) return delegationView(parsed.data);
  if (attributes === null || typeof attributes !== "object") return undefined;
  const id = (attributes as { id?: unknown }).id;
  return typeof id === "string"
    ? unreadableDelegationView(id, attributes as Record<string, unknown>)
    : undefined;
}

export interface DelegationListInput {
  readonly integrationId?: string;
  readonly state?: DelegationViewState;
}

export interface DelegationListData {
  readonly delegations: readonly DelegationView[];
  readonly count: number;
}

export type DelegationListEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: DelegationListData }
  | { kind: "error"; error: SwampError };

export interface DelegationListDeps {
  query: (predicate: string) => Promise<DataRecord[]>;
}

export function createDelegationListDeps(
  dataQueryService: DataQueryService,
): DelegationListDeps {
  return {
    query: async (predicate) =>
      await dataQueryService.query(predicate, {
        loadAttributes: true,
      }) as DataRecord[],
  };
}

function newestFirst(a: DelegationView, b: DelegationView): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id.localeCompare(b.id);
}

export async function* delegationList(
  _ctx: LibSwampContext,
  deps: DelegationListDeps,
  input: DelegationListInput = {},
): AsyncGenerator<DelegationListEvent> {
  yield* withGeneratorSpan(
    "swamp.access.delegation.list",
    {},
    (async function* () {
      yield { kind: "resolving" as const };
      try {
        const records = await deps.query(
          `modelType == "${DELEGATION_MODEL_TYPE.normalized}" && ` +
            `name == "${DELEGATION_DATA_NAME}"`,
        );
        const delegations = records
          .flatMap((record) => {
            const view = viewOfDelegationAttributes(record.attributes);
            return view ? [view] : [];
          })
          .filter((view) =>
            (input.integrationId === undefined ||
              view.integrationId === input.integrationId) &&
            (input.state === undefined || view.state === input.state)
          )
          .sort(newestFirst);
        yield {
          kind: "completed" as const,
          data: { delegations, count: delegations.length },
        };
      } catch (error) {
        yield {
          kind: "error" as const,
          error: {
            code: "delegation_list_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    })(),
  );
}
