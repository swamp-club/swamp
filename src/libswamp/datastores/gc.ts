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
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

/** What one chunk sweep of a v3 datastore found and did. */
export interface DatastoreGcChunkReport {
  /** Chunks the sweep listed. */
  scanned: number;
  /** Chunks past the grace period kept because a commit names them. */
  referenced: number;
  /** Unreferenced chunks deleted. */
  deleted: number;
  /** Chunks deleted, then put back because a commit naming them landed. */
  restored: number;
  /** Chunks stored within the grace period, kept unchecked. */
  keptTooNew: number;
  /** Candidates kept for the next sweep because its read budget was spent. */
  keptOverBudget: number;
  /** Damaged chunks found and deleted. */
  damaged: number;
  /** Stale temp files removed. */
  tempFilesRemoved: number;
}

/** The result of `swamp datastore gc`. */
export interface DatastoreGcData {
  /**
   * False on a v2 datastore, which has no chunks: chunk garbage collection
   * applies only to v3 datastores (swamp-club#3279).
   */
  applies: boolean;
  chunks?: DatastoreGcChunkReport;
}

export type DatastoreGcEvent =
  | { kind: "collecting" }
  | { kind: "completed"; data: DatastoreGcData }
  | { kind: "error"; error: SwampError };

/** Dependencies for {@link datastoreGc}. */
export interface DatastoreGcDeps {
  /**
   * Sweeps the datastore's unreferenced chunks; undefined on a v2 datastore,
   * which has none.
   */
  collectChunks?: (signal: AbortSignal) => Promise<DatastoreGcChunkReport>;
}

/**
 * Deletes the content chunks no commit names any more, past the grace
 * period, on a v3 datastore (swamp-club#3279). On a v2 datastore it does
 * nothing and says so.
 */
export async function* datastoreGc(
  ctx: LibSwampContext,
  deps: DatastoreGcDeps,
): AsyncIterable<DatastoreGcEvent> {
  yield* withGeneratorSpan(
    "swamp.datastore.gc",
    {},
    (async function* () {
      if (deps.collectChunks === undefined) {
        yield { kind: "completed" as const, data: { applies: false } };
        return;
      }
      yield { kind: "collecting" as const };
      const chunks = await deps.collectChunks(ctx.signal);
      yield { kind: "completed" as const, data: { applies: true, chunks } };
    })(),
  );
}
