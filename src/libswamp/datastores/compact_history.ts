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
import type { HistoryCompactionOutcome } from "../../domain/datastore_v3/compaction_policy.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export type DatastoreHistoryCompaction = HistoryCompactionOutcome;

/** applies only to a v3 datastore, which keeps a commit history */
export type DatastoreCompactHistoryData =
  | { readonly applies: false }
  | ({ readonly applies: true } & DatastoreHistoryCompaction);

export type DatastoreCompactHistoryEvent =
  | { kind: "compacting" }
  | { kind: "completed"; data: DatastoreCompactHistoryData }
  | { kind: "error"; error: SwampError };

export interface DatastoreCompactHistoryDeps {
  /** absent on a v2 datastore */
  compactHistory?: (signal: AbortSignal) => Promise<DatastoreHistoryCompaction>;
}

export async function* datastoreCompactHistory(
  ctx: LibSwampContext,
  deps: DatastoreCompactHistoryDeps,
): AsyncIterable<DatastoreCompactHistoryEvent> {
  yield* withGeneratorSpan(
    "swamp.datastore.compact_history",
    {},
    (async function* () {
      if (deps.compactHistory === undefined) {
        yield { kind: "completed" as const, data: { applies: false } };
        return;
      }
      yield { kind: "compacting" as const };
      const outcome = await deps.compactHistory(ctx.signal);
      yield {
        kind: "completed" as const,
        data: { applies: true, ...outcome },
      };
    })(),
  );
}
