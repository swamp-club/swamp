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

import {
  endDelegation,
  refuseDelegation,
} from "../../domain/access/delegation.ts";
import { createResourceWriter } from "../../domain/models/data_writer.ts";
import {
  DELEGATION_DATA_NAME,
  DELEGATION_MODEL_TYPE,
  delegationDefinitionName,
  delegationModel,
  type DelegationRecord,
  DelegationSchema,
} from "../../domain/models/access/delegation_model.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { withUnitOfWork } from "../unit_of_work.ts";
import { type DelegationView, delegationView } from "./delegation_list.ts";

export const OPERATOR_END_CAUSE = "operator";

export interface DelegationEndData {
  readonly delegation: DelegationView;
  /** it was already ended or refused, so nothing was written */
  readonly alreadyEnded: boolean;
}

export type DelegationEndEvent =
  | { kind: "ending"; id: string }
  | { kind: "completed"; data: DelegationEndData }
  | { kind: "error"; error: SwampError };

export interface DelegationEndInput {
  readonly id: string;
  readonly nowMs: number;
}

/** the caller holds the record's model lock around the whole use case */
export interface DelegationEndDeps {
  read: (id: string) => Promise<DelegationRecord | null>;
  write: (record: DelegationRecord) => Promise<void>;
}

export function createDelegationEndDeps(
  repoContext: RepositoryContext,
): DelegationEndDeps {
  return {
    read: async (id) => {
      const content = await repoContext.unifiedDataRepo.getContent(
        DELEGATION_MODEL_TYPE,
        id,
        DELEGATION_DATA_NAME,
      );
      if (content === null) return null;
      return DelegationSchema.parse(
        JSON.parse(new TextDecoder().decode(content)),
      );
    },
    write: async (record) => {
      const { writeResource } = createResourceWriter(
        repoContext.unifiedDataRepo,
        DELEGATION_MODEL_TYPE,
        record.id,
        delegationModel.resources!,
        undefined,
        undefined,
        undefined,
        undefined,
        delegationDefinitionName(record.id),
      );
      await writeResource(
        "delegation",
        DELEGATION_DATA_NAME,
        record as unknown as Record<string, unknown>,
      );
    },
  };
}

/** a link nobody has consented to yet is refused, as serve's own end does */
export function operatorEnd(
  record: DelegationRecord,
  nowMs: number,
): DelegationRecord {
  return record.phase === "awaiting_consent" || record.phase === "reporting"
    ? refuseDelegation(record, OPERATOR_END_CAUSE, nowMs)
    : endDelegation(record, OPERATOR_END_CAUSE, nowMs);
}

export async function* delegationEnd(
  ctx: LibSwampContext,
  deps: DelegationEndDeps,
  input: DelegationEndInput,
): AsyncGenerator<DelegationEndEvent> {
  yield* withUnitOfWork(ctx, () =>
    withGeneratorSpan(
      "swamp.access.delegation.end",
      { "delegation.id": input.id },
      (async function* () {
        yield { kind: "ending" as const, id: input.id };
        let current: DelegationRecord | null;
        try {
          current = await deps.read(input.id);
        } catch (error) {
          yield {
            kind: "error" as const,
            error: {
              code: "delegation_unreadable",
              message: `Delegation '${input.id}' can't be read: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          };
          return;
        }
        if (current === null) {
          yield {
            kind: "error" as const,
            error: {
              code: "delegation_not_found",
              message: `Delegation '${input.id}' does not exist`,
            },
          };
          return;
        }
        if (current.phase === "ended" || current.phase === "refused") {
          yield {
            kind: "completed" as const,
            data: { delegation: delegationView(current), alreadyEnded: true },
          };
          return;
        }
        const next = operatorEnd(current, input.nowMs);
        await deps.write(next);
        yield {
          kind: "completed" as const,
          data: { delegation: delegationView(next), alreadyEnded: false },
        };
      })(),
    ));
}
