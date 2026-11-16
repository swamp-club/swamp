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
import {
  computeLatestFlags,
  nameAlignedChunks,
} from "../../domain/data/data_query_service.ts";
import { type CatalogRow, CatalogStore } from "./catalog_store.ts";

const TYPES = ["t-a", "t-b"] as const;
const MODELS = ["m-1", "m-2"] as const;
const NAMES = ["one", "two"] as const;
const STEPS = ["", "s1", "s2"] as const;

function rowOf(
  type: string,
  model: string,
  name: string,
  version: number,
  step: string,
  flags: { latest: number; stepLatest: number; pending: boolean },
): CatalogRow {
  return {
    namespace: "",
    type_normalized: type,
    model_id: model,
    data_name: name,
    id: `id-${type}-${model}-${name}-${version}`,
    version,
    is_latest: flags.latest,
    is_step_latest: flags.stepLatest,
    model_name: model,
    spec_name: "result",
    data_type: "resource",
    content_type: "application/json",
    lifetime: "infinite",
    garbage_collection: "10",
    lifecycle: "active",
    owner_type: step === "" ? "model-method" : "workflow-step",
    owner_ref: "",
    workflow_run_id: "",
    workflow_name: "",
    job_name: "",
    step_name: step,
    source: "",
    streaming: 0,
    size: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    tags: "{}",
    is_pending: flags.pending ? 1 : 0,
    pending_pid: flags.pending ? 42 : 0,
    pending_host: flags.pending ? "h" : "",
  };
}

interface Group {
  type: number;
  model: number;
  name: number;
  // the walk's versions, with the step each was written by
  walked: { version: number; step: number }[];
  // rows the catalog holds before the rebuild: stale flags, pending writes
  seeded: {
    version: number;
    step: number;
    latest: number;
    stepLatest: number;
    pending: boolean;
  }[];
}

const arbGroup: fc.Arbitrary<Group> = fc.record({
  type: fc.integer({ min: 0, max: TYPES.length - 1 }),
  model: fc.integer({ min: 0, max: MODELS.length - 1 }),
  name: fc.integer({ min: 0, max: NAMES.length - 1 }),
  walked: fc.uniqueArray(
    fc.record({
      version: fc.integer({ min: 1, max: 9 }),
      step: fc.integer({ min: 0, max: STEPS.length - 1 }),
    }),
    { selector: (v) => v.version, maxLength: 6 },
  ),
  seeded: fc.uniqueArray(
    fc.record({
      version: fc.integer({ min: 1, max: 12 }),
      step: fc.integer({ min: 0, max: STEPS.length - 1 }),
      latest: fc.integer({ min: 0, max: 1 }),
      stepLatest: fc.integer({ min: 0, max: 1 }),
      pending: fc.boolean(),
    }),
    { selector: (v) => v.version, maxLength: 4 },
  ),
});

function keyOf(g: Group): string {
  return `${g.type}/${g.model}/${g.name}`;
}

function seed(store: CatalogStore, groups: readonly Group[]): void {
  for (const g of groups) {
    for (const s of g.seeded) {
      store.upsert(
        rowOf(
          TYPES[g.type],
          MODELS[g.model],
          NAMES[g.name],
          s.version,
          STEPS[s.step],
          { latest: s.latest, stepLatest: s.stepLatest, pending: s.pending },
        ),
      );
    }
  }
}

function walkedRows(groups: readonly Group[]): CatalogRow[] {
  // a walk yields every version of one name together
  return groups.flatMap((g) =>
    g.walked.map((w) =>
      rowOf(
        TYPES[g.type],
        MODELS[g.model],
        NAMES[g.name],
        w.version,
        STEPS[w.step],
        { latest: 0, stepLatest: 0, pending: false },
      )
    )
  );
}

function contents(store: CatalogStore): string[] {
  return [...store.iterate()]
    .map((row) =>
      `${row.type_normalized}/${row.model_id}/${row.data_name}@${row.version}` +
      ` latest=${row.is_latest} step=${row.is_step_latest} pending=${row.is_pending} id=${row.id}`
    )
    .sort();
}

Deno.test("CatalogStore: a rebuild committed in name-aligned chunks leaves the catalog a single-transaction rebuild leaves, over random walks, stale flags and pending rows", async () => {
  const coverage = { split: 0, pending: 0, steps: 0 };
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(arbGroup, { selector: keyOf, maxLength: 8 }),
      fc.integer({ min: 1, max: 4 }),
      fc.integer({ min: 1, max: 4 }),
      async (groups, chunkRows, enforceRows) => {
        const whole = new CatalogStore(":memory:");
        const chunked = new CatalogStore(":memory:");
        try {
          seed(whole, groups);
          seed(chunked, groups);
          const rows = walkedRows(groups);

          whole.bulkUpsert(rows, computeLatestFlags);
          whole.enforceUniqueLatest(computeLatestFlags);

          const chunks = nameAlignedChunks(rows, chunkRows);
          for (const chunk of chunks) {
            chunked.bulkUpsert(chunk, computeLatestFlags);
          }
          await chunked.enforceUniqueLatestInChunks(computeLatestFlags, {
            chunkRows: enforceRows,
          });

          assertEquals(contents(chunked), contents(whole));
          if (chunks.length > 1) coverage.split++;
          if (groups.some((g) => g.seeded.some((s) => s.pending))) {
            coverage.pending++;
          }
          if (rows.some((r) => r.step_name !== "")) coverage.steps++;
        } finally {
          whole.close();
          chunked.close();
        }
      },
    ),
    { numRuns: 300 },
  );
  console.error(`chunked commit coverage: ${JSON.stringify(coverage)}`);
});

Deno.test("nameAlignedChunks: never splits one data name's rows, and cuts once a chunk reaches its size", () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 1, max: 5 }), { maxLength: 20 }),
      fc.integer({ min: 1, max: 6 }),
      (sizes, size) => {
        const rows = sizes.flatMap((count, name) =>
          Array.from(
            { length: count },
            (_, i) =>
              rowOf("t", "m", `n${name}`, i + 1, "", {
                latest: 0,
                stepLatest: 0,
                pending: false,
              }),
          )
        );
        const chunks = nameAlignedChunks(rows, size);
        assertEquals(chunks.flat(), rows);
        const seen = new Map<string, number>();
        chunks.forEach((chunk, index) => {
          for (const row of chunk) {
            const at = seen.get(row.data_name) ?? index;
            assertEquals(at, index, `${row.data_name} spans two chunks`);
            seen.set(row.data_name, index);
          }
          if (index < chunks.length - 1) {
            const last = chunk[chunk.length - 1].data_name;
            const sizeOfLast = chunk.filter((r) => r.data_name === last).length;
            // a chunk is cut only when the rows before its last name filled it
            assertEquals(chunk.length - sizeOfLast < size, true);
          }
        });
      },
    ),
    { numRuns: 300 },
  );
});

Deno.test("CatalogStore.enforceUniqueLatestInChunks: limited to types, it leaves other types' flags as they were", async () => {
  const store = new CatalogStore(":memory:");
  try {
    for (const type of TYPES) {
      for (const version of [1, 2]) {
        store.upsert(
          rowOf(type, "m-1", "one", version, "", {
            latest: 1,
            stepLatest: 1,
            pending: false,
          }),
        );
      }
    }
    await store.enforceUniqueLatestInChunks(computeLatestFlags, {
      types: ["t-a"],
    });
    assertEquals(
      contents(store).map((line) => line.split(" pending")[0]),
      [
        "t-a/m-1/one@1 latest=0 step=0",
        "t-a/m-1/one@2 latest=1 step=1",
        "t-b/m-1/one@1 latest=1 step=1",
        "t-b/m-1/one@2 latest=1 step=1",
      ],
    );
  } finally {
    store.close();
  }
});
