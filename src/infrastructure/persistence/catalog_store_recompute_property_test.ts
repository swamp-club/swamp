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
 * Differential property test of the catalog's latest-flag recompute
 * (swamp-club#3803). `recomputeGroupFlags` moved into SQL; the recompute it
 * replaced is kept here as the oracle: page the group's promoted rows into
 * JavaScript, run `computeLatestFlags`, write the rows whose flags changed.
 * Two stores get the same random adds, pending writes, settles and removals
 * over two groups; after every step every row's flags must agree.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { computeLatestFlags } from "../../domain/data/data_query_service.ts";
import { type CatalogRow, CatalogStore } from "./catalog_store.ts";

const GROUPS = ["one", "two"] as const;
const STEPS = ["", "a", "b"] as const;

function rowOf(
  dataName: string,
  version: number,
  stepName: string,
  pending: boolean,
): CatalogRow {
  return {
    namespace: "",
    type_normalized: "test-model",
    model_id: "model-001",
    data_name: dataName,
    id: `id-${dataName}-${version}`,
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
    size: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    tags: "{}",
    is_pending: pending ? 1 : 0,
    pending_pid: pending ? 42 : 0,
    pending_host: pending ? "h" : "",
  };
}

type Step =
  | { kind: "add"; group: number; version: number; step: number }
  | { kind: "pending"; group: number; version: number; step: number }
  | { kind: "settle"; group: number; version: number; keep: boolean }
  | { kind: "remove"; group: number; versions: number[] };

const arbGroup = fc.integer({ min: 0, max: GROUPS.length - 1 });
const arbVersion = fc.integer({ min: 1, max: 8 });
const arbStep: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("add" as const),
      group: arbGroup,
      version: arbVersion,
      step: fc.integer({ min: 0, max: STEPS.length - 1 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("pending" as const),
      group: arbGroup,
      version: arbVersion,
      step: fc.integer({ min: 0, max: STEPS.length - 1 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("settle" as const),
      group: arbGroup,
      version: arbVersion,
      keep: fc.boolean(),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("remove" as const),
      group: arbGroup,
      versions: fc.uniqueArray(arbVersion, { minLength: 1, maxLength: 3 }),
    }),
  },
);

/** The recompute `recomputeGroupFlags` ran before swamp-club#3803. */
function oracleRemoveVersions(
  store: CatalogStore,
  dataName: string,
  versions: readonly number[],
): void {
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.exec("BEGIN IMMEDIATE");
  try {
    const remove = db.prepare(
      `DELETE FROM catalog
       WHERE namespace = ? AND type_normalized = ? AND model_id = ? AND data_name = ? AND version = ?`,
    );
    for (const version of versions) {
      remove.run("", "test-model", "model-001", dataName, version);
    }
    const rows = [
      ...store.iterateFiltered(
        "namespace = ? AND type_normalized = ? AND model_id = ? AND data_name = ? AND is_pending = 0",
        ["", "test-model", "model-001", dataName],
      ),
    ];
    const before = new Map(
      rows.map((r) => [r, `${r.is_latest}:${r.is_step_latest}`]),
    );
    computeLatestFlags(rows);
    const update = db.prepare(
      `UPDATE catalog SET is_latest = ?, is_step_latest = ?
       WHERE namespace = ? AND type_normalized = ? AND model_id = ?
         AND data_name = ? AND version = ?`,
    );
    for (const row of rows) {
      if (before.get(row) === `${row.is_latest}:${row.is_step_latest}`) {
        continue;
      }
      update.run(
        row.is_latest,
        row.is_step_latest,
        row.namespace,
        row.type_normalized,
        row.model_id,
        row.data_name,
        row.version,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function apply(store: CatalogStore, step: Step, oracle: boolean): void {
  const dataName = GROUPS[step.group];
  switch (step.kind) {
    case "add":
      store.upsertNewVersion(
        rowOf(dataName, step.version, STEPS[step.step], false),
      );
      return;
    case "pending":
      store.upsert(rowOf(dataName, step.version, STEPS[step.step], true));
      return;
    case "settle":
      store.settlePending(
        "",
        "test-model",
        "model-001",
        dataName,
        step.version,
        step.keep,
      );
      return;
    case "remove":
      if (oracle) oracleRemoveVersions(store, dataName, step.versions);
      else {
        store.bulkRemoveVersions(
          "",
          "test-model",
          "model-001",
          dataName,
          step.versions,
          computeLatestFlags,
        );
      }
  }
}

function flagsOf(store: CatalogStore): unknown[] {
  return [...store.iterate()]
    .map((r) => [
      r.data_name,
      r.version,
      r.step_name,
      r.is_pending,
      r.is_latest,
      r.is_step_latest,
    ])
    .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
}

Deno.test("CatalogStore.recomputeGroupFlags: the SQL recompute sets the flags the JavaScript one did, over random adds, pending writes and removals (swamp-club#3803)", () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-catalog-recompute-" });
  const coverage = { removals: 0, steps: 0, pending: 0 };
  try {
    let run = 0;
    fc.assert(
      fc.property(
        fc.array(arbStep, { minLength: 1, maxLength: 30 }),
        (steps) => {
          run++;
          const sql = new CatalogStore(join(dir, `sql-${run}.db`));
          const js = new CatalogStore(join(dir, `js-${run}.db`));
          try {
            for (const step of steps) {
              apply(sql, step, false);
              apply(js, step, true);
              assertEquals(flagsOf(sql), flagsOf(js));
              if (step.kind === "remove") coverage.removals++;
              if (step.kind === "pending") coverage.pending++;
              if (step.kind === "add" && step.step > 0) coverage.steps++;
            }
          } finally {
            sql.close();
            js.close();
          }
        },
      ),
      { numRuns: 300 },
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
  console.error(`recompute property coverage: ${JSON.stringify(coverage)}`);
});
