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

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import fc from "fast-check";
import { computeLatestFlags } from "./data_query_service.ts";
import {
  type CatalogRow,
  CatalogStore,
} from "../../infrastructure/persistence/catalog_store.ts";

function makeRow(version: number, stepName: string): CatalogRow {
  return {
    namespace: "",
    type_normalized: "test-model",
    model_id: "model-001",
    data_name: "my-data",
    id: `id-${version}`,
    version,
    is_latest: 0,
    is_step_latest: 0,
    model_name: "ingest",
    spec_name: "result",
    data_type: "resource",
    content_type: "application/json",
    lifetime: "infinite",
    owner_type: stepName === "" ? "model-method" : "workflow-step",
    streaming: 0,
    size: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    tags: "{}",
    owner_ref: "",
    workflow_run_id: "",
    workflow_name: "",
    job_name: "",
    step_name: stepName,
    source: "",
  };
}

/** Step names for versions 1..n of one data name; "" is a model-method write. */
const arbStepNames = fc.array(fc.constantFrom("", "s1", "s2", "s3"), {
  minLength: 1,
  maxLength: 8,
});

/** Step names plus an arbitrary promotion order over their versions. */
const arbWritesInOrder = arbStepNames.chain((steps) =>
  fc.tuple(
    fc.constant(steps),
    fc.shuffledSubarray(steps.map((_, i) => i + 1), {
      minLength: steps.length,
      maxLength: steps.length,
    }),
  )
);

function flags(rows: CatalogRow[]): string[] {
  return rows
    .slice()
    .sort((a, b) => a.version - b.version)
    .map((r) => `${r.version}:${r.is_latest}:${r.is_step_latest}`);
}

Deno.test("property: computeLatestFlags keeps one latest per name and it is also a step latest", () => {
  fc.assert(
    fc.property(arbStepNames, (steps) => {
      const rows = steps.map((step, i) => makeRow(i + 1, step));
      computeLatestFlags(rows);

      const latest = rows.filter((r) => r.is_latest === 1);
      assertEquals(latest.length, 1);
      assertEquals(latest[0].version, steps.length);
      assertEquals(latest[0].is_step_latest, 1);

      const stepLatestByStep = new Map<string, number>();
      for (const row of rows.filter((r) => r.is_step_latest === 1)) {
        stepLatestByStep.set(
          row.step_name,
          (stepLatestByStep.get(row.step_name) ?? 0) + 1,
        );
      }
      for (const count of stepLatestByStep.values()) assert(count === 1);
    }),
  );
});

Deno.test("property: upsertNewVersion in any promotion order matches computeLatestFlags", () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-latest-property-" });
  try {
    fc.assert(
      fc.property(arbWritesInOrder, ([steps, order]) => {
        const store = new CatalogStore(
          join(dir, `${crypto.randomUUID()}.db`),
        );
        try {
          for (const version of order) {
            store.upsertNewVersion(makeRow(version, steps[version - 1]));
          }
          const expected = steps.map((step, i) => makeRow(i + 1, step));
          computeLatestFlags(expected);
          assertEquals(flags([...store.iterate()]), flags(expected));
        } finally {
          store.close();
        }
      }),
    );
  } finally {
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch {
      // Windows can report EBUSY before SQLite handles are released.
    }
  }
});
