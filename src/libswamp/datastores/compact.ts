// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

/** Stats returned by the compact operation. */
export interface DatastoreCompactData {
  walPagesTotal: number;
  walPagesCheckpointed: number;
  /** Bytes reclaimed from the main database file after VACUUM. */
  dbBytesReclaimed: number;
}

export type DatastoreCompactEvent =
  | { kind: "checkpointing" }
  | { kind: "vacuuming" }
  | { kind: "completed"; data: DatastoreCompactData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the datastore compact operation. */
export interface DatastoreCompactDeps {
  checkpoint: () => { walPagesTotal: number; walPagesCheckpointed: number };
  vacuum: () => void;
  catalogDbSize: () => Promise<number>;
}

/** Checkpoints the catalog WAL and runs VACUUM to reclaim freed pages. */
export async function* datastoreCompact(
  _ctx: LibSwampContext,
  deps: DatastoreCompactDeps,
): AsyncIterable<DatastoreCompactEvent> {
  yield* withGeneratorSpan(
    "swamp.datastore.compact",
    {},
    (async function* () {
      yield { kind: "checkpointing" } as const;
      const beforeSize = await deps.catalogDbSize();
      const stats = deps.checkpoint();

      yield { kind: "vacuuming" } as const;
      deps.vacuum();
      const afterSize = await deps.catalogDbSize();

      yield {
        kind: "completed" as const,
        data: {
          walPagesTotal: stats.walPagesTotal,
          walPagesCheckpointed: stats.walPagesCheckpointed,
          dbBytesReclaimed: Math.max(0, beforeSize - afterSize),
        },
      };
    })(),
  );
}
