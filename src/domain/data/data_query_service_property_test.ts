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

import { assertEquals } from "@std/assert";
import fc from "fast-check";
import { join } from "@std/path";
import {
  type CatalogRow,
  CatalogStore,
} from "../../infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { DataQueryService } from "./data_query_service.ts";
import type { DataRecord } from "./data_record.ts";

const NAMES = ["a", "b", "c", "d", "e", "f", "g", "h"];

function row(dataName: string): CatalogRow {
  return {
    namespace: "",
    type_normalized: "test-model",
    model_id: "model-001",
    data_name: dataName,
    id: `id-${dataName}`,
    version: 1,
    is_latest: 1,
    model_name: "ingest",
    spec_name: "",
    data_type: "resource",
    content_type: "text/plain",
    lifetime: "infinite",
    owner_type: "model-method",
    streaming: 0,
    size: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    tags: "{}",
    owner_ref: "",
    workflow_run_id: "",
    workflow_name: "",
    job_name: "",
    step_name: "",
    source: "",
  };
}

/**
 * What an unversioned repository read of `start` returns: the name itself
 * when it has data, otherwise the end of its forward chain, following at
 * most five forwards and never revisiting a name.
 */
function expectedTarget(
  start: string,
  forwards: Map<string, string>,
  live: Set<string>,
): string | null {
  if (live.has(start)) return start;
  const seen = new Set([start]);
  let current = start;
  for (let hop = 1;; hop++) {
    const next = forwards.get(current);
    if (next === undefined || hop > 5 || seen.has(next)) return null;
    if (live.has(next)) return next;
    seen.add(next);
    current = next;
  }
}

Deno.test("DataQueryService rename forwards: a read by any name matches what the repository read returns", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-forward-prop-" });
  let run = 0;
  try {
    fc.assert(
      fc.property(
        // At most one forward per name, as the catalog's primary key holds.
        fc.dictionary(fc.constantFrom(...NAMES), fc.constantFrom(...NAMES)),
        fc.subarray(NAMES),
        fc.constantFrom(...NAMES),
        (forwardRecord, liveNames, start) => {
          const catalog = new CatalogStore(join(dir, `catalog-${run++}.db`));
          try {
            catalog.markPopulated();
            const live = new Set(liveNames);
            const forwards = new Map(Object.entries(forwardRecord));
            for (const name of live) catalog.upsert(row(name));
            for (const [from, to] of forwards) {
              catalog.recordRename({
                namespace: "",
                type_normalized: "test-model",
                model_id: "model-001",
                data_name: from,
                renamed_to: to,
              });
            }
            const service = new DataQueryService(
              catalog,
              new FileSystemUnifiedDataRepository(dir, undefined, catalog),
            );

            const results = service.querySync(
              `name == ${JSON.stringify(start)}`,
            ) as DataRecord[];
            const expected = expectedTarget(start, forwards, live);
            assertEquals(
              results.map((r) => r.name),
              expected === null ? [] : [expected],
            );
          } finally {
            catalog.close();
          }
        },
      ),
      { numRuns: 200 },
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
