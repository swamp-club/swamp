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

import { isQuarantineTxnId } from "../../domain/datastore_v3/quarantine.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import type { LibSwampContext } from "../context.ts";
import { type SwampError, validationFailed } from "../errors.ts";

export interface QuarantineRenumberedVersion {
  name: string;
  from: number;
  to: number;
}

export interface DatastoreQuarantineAcceptData {
  txnId: string;
  partition: string;
  author: string;
  acceptedBy: string;
  acceptedAt: string;
  seq?: number;
  duplicate: boolean;
  renumbered: QuarantineRenumberedVersion[];
}

export type DatastoreQuarantineAcceptEvent =
  | { kind: "accepting"; txnId: string }
  | { kind: "completed"; data: DatastoreQuarantineAcceptData }
  | { kind: "error"; error: SwampError };

export interface DatastoreQuarantineAcceptInput {
  readonly txnId: string;
}

export interface DatastoreQuarantineAcceptDeps {
  accept: (txnId: string) => Promise<Record<string, unknown>>;
}

export async function* datastoreQuarantineAccept(
  ctx: LibSwampContext,
  deps: DatastoreQuarantineAcceptDeps,
  input: DatastoreQuarantineAcceptInput,
): AsyncIterable<DatastoreQuarantineAcceptEvent> {
  yield* withGeneratorSpan(
    "swamp.datastore.quarantine.accept",
    {},
    (async function* () {
      const txnId = input.txnId.trim().toLowerCase();
      if (!isQuarantineTxnId(txnId)) {
        yield {
          kind: "error",
          error: validationFailed(
            `Not a txnId: ${input.txnId}. \`swamp datastore status --server\` lists the quarantined changes and their txnIds.`,
          ),
        };
        return;
      }
      ctx.logger.debug`Asking serve to accept quarantined change ${txnId}`;
      yield { kind: "accepting", txnId };
      const reply = await deps.accept(txnId);
      yield { kind: "completed", data: acceptDataOf(txnId, reply) };
    })(),
  );
}

function acceptDataOf(
  txnId: string,
  reply: Record<string, unknown>,
): DatastoreQuarantineAcceptData {
  const text = (value: unknown): string =>
    typeof value === "string" ? value : "";
  const renumbered: QuarantineRenumberedVersion[] = [];
  if (Array.isArray(reply.renumbered)) {
    for (const raw of reply.renumbered) {
      const version = typeof raw === "object" && raw !== null
        ? raw as Record<string, unknown>
        : {};
      if (
        typeof version.name === "string" && typeof version.from === "number" &&
        typeof version.to === "number" && version.from !== version.to
      ) {
        renumbered.push({
          name: version.name,
          from: version.from,
          to: version.to,
        });
      }
    }
  }
  return {
    txnId,
    partition: text(reply.partition),
    author: text(reply.principal),
    acceptedBy: text(reply.acceptedBy),
    acceptedAt: text(reply.acceptedAt),
    ...(typeof reply.seq === "number" ? { seq: reply.seq } : {}),
    duplicate: reply.duplicate === true,
    renumbered,
  };
}
