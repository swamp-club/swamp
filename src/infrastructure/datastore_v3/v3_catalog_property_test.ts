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

import { assertEquals, assertRejects } from "@std/assert";
import fc from "fast-check";
import { join } from "@std/path";
import { DataMetadataSchema } from "../../domain/data/data_metadata.ts";
import {
  metadata,
  MODEL_ID,
  MODEL_TYPE,
  modelPartition,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { catalogRow, V3Catalog } from "./v3_catalog.ts";

interface World {
  /** each name's true history: its version count */
  readonly history: readonly number[];
  /** torn rows a writer left: [name index, version] */
  readonly torn: readonly (readonly [number, number])[];
  readonly bound: number;
}

const arbWorld: fc.Arbitrary<World> = fc.integer({ min: 2, max: 8 }).chain((
  names,
) =>
  fc.record({
    history: fc.array(fc.integer({ min: 1, max: 6 }), {
      minLength: names,
      maxLength: names,
    }),
    torn: fc.array(
      fc.tuple(
        fc.integer({ min: 0, max: names - 1 }),
        fc.integer({
          min: 1,
          max: 9,
        }),
      ),
      { maxLength: 12 },
    ),
    bound: fc.integer({ min: 1, max: 8 }),
  })
);

const nameOf = (index: number) => `n${index}`;
const key = (n: string) => ({
  namespace: "",
  type: MODEL_TYPE.normalized,
  modelId: MODEL_ID,
  name: n,
});
const upsert = (n: string, version: number) => ({
  kind: "upsert-version" as const,
  metadata: DataMetadataSchema.parse(metadata(n, version)),
});

/** a catalog holding the true history, then a writer's torn rows marking names dirty */
function seeded(path: string, world: World, bound: number): V3Catalog {
  const catalog = V3Catalog.open(path, { reconcileRowsPerTransaction: bound });
  catalog.ensureDirtyTracking(1_000);
  for (const [index, versions] of world.history.entries()) {
    catalog.apply(
      "",
      modelPartition(),
      Array.from({ length: versions }, (_, v) => upsert(nameOf(index), v + 1)),
    );
  }
  for (const [index, version] of world.torn) {
    catalog.store.upsertNewVersion(
      catalogRow(
        "",
        MODEL_TYPE.normalized,
        MODEL_ID,
        DataMetadataSchema.parse(metadata(nameOf(index), version)),
      ),
    );
  }
  return catalog;
}

/** what a recovery holds: clear the dirty names, replay their history, forget them */
function holdRepair(catalog: V3Catalog, world: World): void {
  const names = world.history.map((_, index) => key(nameOf(index)));
  catalog.beginBatch();
  catalog.clearNames(names, () => true);
  catalog.apply(
    "",
    modelPartition(),
    world.history.flatMap((versions, index) =>
      Array.from({ length: versions }, (_, v) => upsert(nameOf(index), v + 1))
    ),
  );
  catalog.forgetDirty(names);
}

function rowsOf(catalog: V3Catalog): string[] {
  return [...catalog.store.iterate()].map((row) => JSON.stringify(row)).sort();
}

function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-v3-catalog-slices-" });
  return fn(dir).finally(() => {
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch (error) {
      if (Deno.build.os !== "windows") throw error;
    }
  });
}

Deno.test("V3Catalog.commitBatchInSlices: a repair committed in bounded slices leaves the same rows and dirty names as one transaction", async () => {
  await fc.assert(
    fc.asyncProperty(arbWorld, (world) =>
      withDir(async (dir) => {
        const whole = seeded(join(dir, "whole.db"), world, 1_000_000);
        const sliced = seeded(join(dir, "sliced.db"), world, world.bound);
        try {
          holdRepair(whole, world);
          whole.commitBatch();
          holdRepair(sliced, world);
          let turns = 0;
          await sliced.commitBatchInSlices(() => {
            turns++;
            return Promise.resolve();
          });
          assertEquals(rowsOf(sliced), rowsOf(whole));
          assertEquals(sliced.dirtyNames(), whole.dirtyNames());
          if (world.history.length > world.bound) {
            assertEquals(turns > 0, true);
          }
        } finally {
          whole.close();
          sliced.close();
        }
      })),
    { numRuns: 60 },
  );
});

Deno.test("V3Catalog.commitBatchInSlices: stopped between slices it leaves every name dirty, and the next repair converges", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbWorld.filter((world) =>
        world.torn.length > 0 && world.history.length > world.bound
      ),
      (world) =>
        withDir(async (dir) => {
          const whole = seeded(join(dir, "whole.db"), world, 1_000_000);
          const sliced = seeded(join(dir, "sliced.db"), world, world.bound);
          try {
            const dirtyBefore = sliced.dirtyNames();
            holdRepair(sliced, world);
            await assertRejects(() =>
              sliced.commitBatchInSlices(() =>
                Promise.reject(new Error("crashed between slices"))
              )
            );
            sliced.rollbackBatch();
            // the names are forgotten only once every slice has committed
            assertEquals(sliced.dirtyNames(), dirtyBefore);
            holdRepair(sliced, world);
            await sliced.commitBatchInSlices(() => Promise.resolve());
            holdRepair(whole, world);
            whole.commitBatch();
            assertEquals(rowsOf(sliced), rowsOf(whole));
            assertEquals(sliced.dirtyNames(), []);
          } finally {
            whole.close();
            sliced.close();
          }
        }),
    ),
    { numRuns: 40 },
  );
});
