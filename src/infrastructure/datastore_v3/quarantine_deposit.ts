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
 * Hands serve a change a flush quarantined (swamp-club#4195): one serve
 * refused because this checkout's caller lacks a grant it needs. Serve keeps
 * it for an admin to accept; the checkout keeps its own entry until the
 * change lands, whoever lands it.
 *
 * @module
 */

import type { OutboxEntry } from "../../domain/datastore_v3/commit_outbox.ts";
import { MAX_QUARANTINE_DEPOSIT_BYTES } from "../../domain/datastore_v3/quarantine.ts";
import type { DatastoreStorage } from "../../domain/datastore/datastore_storage.ts";
import { storageNamespaceOf } from "./serve_datastore_storage.ts";
import type {
  CommitChunk,
  ServeDatastoreClient,
} from "./serve_datastore_client.ts";

/** Thrown for a change too large to hand to serve: it stays here only. */
export class QuarantineTooLargeError extends Error {
  constructor(bytes: number) {
    super(
      `it carries ${bytes} bytes, more than serve keeps ` +
        `(${MAX_QUARANTINE_DEPOSIT_BYTES}); it stays quarantined in this checkout only`,
    );
    this.name = "QuarantineTooLargeError";
  }
}

/**
 * The flush's `quarantined` hook for a serve-mode checkout: reads the
 * entry's chunks from the checkout's chunk cache and deposits the change
 * with serve.
 *
 * @throws QuarantineTooLargeError when the change is past what serve keeps
 */
export function createQuarantineDeposit(deps: {
  readonly client: Pick<ServeDatastoreClient, "depositQuarantine">;
  readonly chunkCache: Pick<DatastoreStorage, "get">;
  readonly signal: () => AbortSignal;
}): (entry: OutboxEntry) => Promise<void> {
  return async (entry) => {
    const { commit } = entry;
    const signal = deps.signal();
    const chunks: CommitChunk[] = [];
    let bytes = 0;
    for (const sha256 of new Set(commit.chunkRefs())) {
      const content = await deps.chunkCache.get(
        storageNamespaceOf(commit.namespace),
        sha256,
        signal,
      );
      if (content === null) {
        throw new Error(
          `chunk ${sha256} of the change is not in this checkout's chunk cache`,
        );
      }
      bytes += content.byteLength;
      if (bytes > MAX_QUARANTINE_DEPOSIT_BYTES) {
        throw new QuarantineTooLargeError(bytes);
      }
      chunks.push({ sha256, bytes: content });
    }
    await deps.client.depositQuarantine({
      commit: commit.toJSON(),
      base: {
        seq: entry.base.seq,
        ...(entry.base.txnId === undefined ? {} : { txnId: entry.base.txnId }),
      },
      chunks,
    }, signal);
  };
}
