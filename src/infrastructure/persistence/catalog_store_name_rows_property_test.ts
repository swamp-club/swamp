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
 * differential test: a name's rows written together by insertNameRows land
 * as the same rows one upsertNewVersion at a time leaves, whatever the order,
 * steps, repeated versions and rows the name already held
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import fc from "fast-check";
import { computeLatestFlags } from "../../domain/data/data_query_service.ts";
import { type CatalogRow, CatalogStore } from "./catalog_store.ts";

const STEPS = ["", "a", "b"] as const;

function rowOf(version: number, step: number, size: number): CatalogRow {
  const stepName = STEPS[step];
  return {
    namespace: "",
    type_normalized: "test-model",
    model_id: "model-001",
    data_name: "name",
    id: `id-${version}`,
    version,
    is_latest: 0,
    is_step_latest: 0,
    model_name: "m",
    spec_name: "result",
    data_type: "resource",
    content_type: "application/json",
    lifetime: "infinite",
    garbage_collection: "10",
    lifecycle: "active",
    owner_type: stepName === "" ? "model-method" : "workflow-step",
    owner_ref: "",
    workflow_run_id: "",
    workflow_name: "",
    job_name: "",
    step_name: stepName,
    source: "",
    streaming: 0,
    size,
    created_at: "2026-01-01T00:00:00.000Z",
    tags: "{}",
  };
}

const arbRow = fc.record({
  version: fc.integer({ min: 1, max: 8 }),
  step: fc.integer({ min: 0, max: STEPS.length - 1 }),
  size: fc.integer({ min: 0, max: 3 }),
});

function contentsOf(store: CatalogStore): unknown[] {
  return [...store.iterate()]
    .map((r) => JSON.stringify(r))
    .sort();
}

Deno.test("CatalogStore.insertNameRows: leaves the rows upsertNewVersion one at a time leaves, over random versions, steps and held rows (swamp-club#5122)", () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-catalog-name-rows-" });
  const coverage = { fresh: 0, held: 0, repeated: 0 };
  try {
    let run = 0;
    fc.assert(
      fc.property(
        fc.array(arbRow, { maxLength: 3 }),
        fc.array(arbRow, { minLength: 1, maxLength: 10 }),
        (held, written) => {
          run++;
          const oneByOne = new CatalogStore(join(dir, `one-${run}.db`));
          const together = new CatalogStore(join(dir, `together-${run}.db`));
          try {
            for (const store of [oneByOne, together]) {
              for (const row of held) {
                store.upsertNewVersion(rowOf(row.version, row.step, row.size));
              }
            }
            const rows = written.map((row) =>
              rowOf(row.version, row.step, row.size)
            );
            oneByOne.applyInTransaction((writer) => {
              for (const row of rows) writer.upsertNewVersion(row);
            });
            together.applyInTransaction((writer) =>
              writer.insertNameRows(rows, computeLatestFlags)
            );
            assertEquals(contentsOf(together), contentsOf(oneByOne));
            if (held.length === 0) coverage.fresh++;
            else coverage.held++;
            if (new Set(rows.map((r) => r.version)).size < rows.length) {
              coverage.repeated++;
            }
          } finally {
            oneByOne.close();
            together.close();
          }
        },
      ),
      { numRuns: 300 },
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
  console.error(
    `insertNameRows property coverage: ${JSON.stringify(coverage)}`,
  );
});
