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

/** Stats returned by the compact operation. */
export interface DatastoreCompactData {
  walPagesTotal: number;
  walPagesCheckpointed: number;
  /** Bytes reclaimed from the main database file after VACUUM. */
  dbBytesReclaimed: number;
  /** True when VACUUM was skipped due to a runtime limitation. */
  vacuumSkipped: boolean;
}

export type DatastoreCompactEvent =
  | { kind: "checkpointing" }
  | { kind: "vacuuming" }
  | { kind: "completed"; data: DatastoreCompactData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the datastore compact operation. */
export interface DatastoreCompactDeps {
  checkpoint: () => { walPagesTotal: number; walPagesCheckpointed: number };
  vacuum: () => boolean;
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
      const stats = deps.checkpoint();
      // Measure after checkpoint so WAL pages are flushed to the main DB,
      // giving an accurate before-VACUUM baseline.
      const beforeSize = await deps.catalogDbSize();

      yield { kind: "vacuuming" } as const;
      const vacuumed = deps.vacuum();
      const afterSize = await deps.catalogDbSize();

      yield {
        kind: "completed" as const,
        data: {
          walPagesTotal: stats.walPagesTotal,
          walPagesCheckpointed: stats.walPagesCheckpointed,
          dbBytesReclaimed: Math.max(0, beforeSize - afterSize),
          vacuumSkipped: !vacuumed,
        },
      };
    })(),
  );
}
