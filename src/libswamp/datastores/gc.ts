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

export interface DatastoreGcChunkReport {
  scanned: number;
  referenced: number;
  deleted: number;
  restored: number;
  keptTooNew: number;
  keptOverBudget: number;
  damaged: number;
  tempFilesRemoved: number;
}

export interface DatastoreGcData {
  applies: boolean;
  chunks?: DatastoreGcChunkReport;
}

export type DatastoreGcEvent =
  | { kind: "collecting" }
  | { kind: "completed"; data: DatastoreGcData }
  | { kind: "error"; error: SwampError };

export interface DatastoreGcDeps {
  collectChunks?: (signal: AbortSignal) => Promise<DatastoreGcChunkReport>;
}

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
