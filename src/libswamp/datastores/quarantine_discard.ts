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
 * `swamp datastore quarantine discard` (swamp-club#4195): an admin discards
 * a change serve keeps because its author lacked a grant it needs, so it
 * never lands. Serve keeps the record, marked discarded; the author's next
 * command keeps its entry as rejected and never sends it.
 *
 * @module
 */

import { isQuarantineTxnId } from "../../domain/datastore_v3/quarantine.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import type { LibSwampContext } from "../context.ts";
import { type SwampError, validationFailed } from "../errors.ts";

/** What `datastore quarantine discard` reports. */
export interface DatastoreQuarantineDiscardData {
  txnId: string;
  partition: string;
  /** Who made the change. */
  author: string;
  /** The admin who discarded it. */
  discardedBy: string;
  discardedAt: string;
  /** It had been discarded already. */
  duplicate: boolean;
}

export type DatastoreQuarantineDiscardEvent =
  | { kind: "discarding"; txnId: string }
  | { kind: "completed"; data: DatastoreQuarantineDiscardData }
  | { kind: "error"; error: SwampError };

export interface DatastoreQuarantineDiscardInput {
  readonly txnId: string;
}

export interface DatastoreQuarantineDiscardDeps {
  /** Asks serve to discard the kept change `txnId`; resolves with its reply. */
  discard: (txnId: string) => Promise<Record<string, unknown>>;
}

/** Discards a change serve keeps for an admin, so it never lands. */
export async function* datastoreQuarantineDiscard(
  ctx: LibSwampContext,
  deps: DatastoreQuarantineDiscardDeps,
  input: DatastoreQuarantineDiscardInput,
): AsyncIterable<DatastoreQuarantineDiscardEvent> {
  yield* withGeneratorSpan(
    "swamp.datastore.quarantine.discard",
    {},
    (async function* () {
      const txnId = input.txnId.trim().toLowerCase();
      if (!isQuarantineTxnId(txnId)) {
        yield {
          kind: "error",
          error: validationFailed(
            `Not a txnId: ${input.txnId}. \`swamp datastore status\` lists the quarantined changes and their txnIds.`,
          ),
        };
        return;
      }
      ctx.logger.debug`Asking serve to discard quarantined change ${txnId}`;
      yield { kind: "discarding", txnId };
      const reply = await deps.discard(txnId);
      yield { kind: "completed", data: discardDataOf(txnId, reply) };
    })(),
  );
}

/** Serve's reply to a discard, as the command reports it. */
function discardDataOf(
  txnId: string,
  reply: Record<string, unknown>,
): DatastoreQuarantineDiscardData {
  const text = (value: unknown): string =>
    typeof value === "string" ? value : "";
  return {
    txnId,
    partition: text(reply.partition),
    author: text(reply.principal),
    discardedBy: text(reply.discardedBy),
    discardedAt: text(reply.discardedAt),
    duplicate: reply.duplicate === true,
  };
}
