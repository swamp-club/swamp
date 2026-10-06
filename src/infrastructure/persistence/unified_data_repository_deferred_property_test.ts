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
import { dirname, join } from "@std/path";
import fc from "fast-check";
import { FileSystemUnifiedDataRepository } from "./unified_data_repository.ts";
import { type CatalogRow, CatalogStore } from "./catalog_store.ts";
import { Data, SOLO_NAMESPACE } from "../../domain/data/mod.ts";
import {
  computeLatestFlags,
  DataQueryService,
} from "../../domain/data/data_query_service.ts";
import type { DeferredWriteReceipt } from "../../domain/data/repositories.ts";
import { ModelType } from "../../domain/models/model_type.ts";

/**
 * Model-based check of the deferred-write lifecycle against the catalog's
 * latest flags (swamp-club#2975): random interleavings of saves, deferred
 * saves, streamed deferred writes, promotions, rollbacks, deletes, GC,
 * catalog backfills and writer crashes, with the catalog, the disk and reads
 * compared against a reference model after every step.
 */

const TYPE = ModelType.create("test/model");
const MODEL_ID = "m1";
const NAME = "out";
const GC_KEEP = 3;
/** A pid no process can hold, so the writer reads as gone. */
const DEAD_PID = 2147483647;

type VersionState =
  | "promoted"
  | "pending" // deferred, finalized, in flight
  | "allocated" // streamed deferred write, content not finalized yet
  | "crashed" // pending or allocated whose process died
  | "foreign"; // pending or allocated, in flight in another live process

type Op =
  | { kind: "save"; step: string }
  | { kind: "saveDeferred"; step: string }
  | { kind: "allocate"; step: string }
  | { kind: "finalize"; pick: number }
  | { kind: "promote"; pick: number }
  | { kind: "rollback"; pick: number }
  | { kind: "crash"; pick: number }
  | { kind: "handOff"; pick: number }
  | { kind: "delete"; pick: number }
  | { kind: "gc" }
  | { kind: "backfill" };

const arbStep = fc.constantFrom("", "s1", "s2");
// Unbiased, so a pick reaches every version, not mostly the oldest.
const arbPick = fc.nat({ max: 20 }).noBias();
const arbOp: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({ kind: fc.constant("save" as const), step: arbStep }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("saveDeferred" as const),
      step: arbStep,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("allocate" as const),
      step: arbStep,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("finalize" as const),
      pick: arbPick,
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("promote" as const),
      pick: arbPick,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("rollback" as const),
      pick: arbPick,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("crash" as const),
      pick: arbPick,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("handOff" as const),
      pick: arbPick,
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("delete" as const),
      pick: arbPick,
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("gc" as const) }) },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("backfill" as const) }),
  },
);

function data(step: string): Data {
  return Data.create({
    name: NAME,
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: GC_KEEP,
    tags: { type: "resource", modelName: "writer", specName: NAME },
    ownerDefinition: {
      ownerType: "workflow-step",
      ownerRef: "test/model:run",
      ...(step === "" ? {} : { stepName: step }),
    },
  });
}

const bytes = (s: string) => new TextEncoder().encode(s);

interface Tracked {
  state: VersionState;
  step: string;
  receipt: DeferredWriteReceipt;
  /** Streamed writes only: where the content goes and the prior versions. */
  contentPath?: string;
  priorVersions?: number[];
}

function picked(
  model: Map<number, Tracked>,
  states: VersionState[],
  pick: number,
): [number, Tracked] | undefined {
  const matching = [...model.entries()]
    .filter(([, t]) => states.includes(t.state))
    .sort(([a], [b]) => a - b);
  return matching.length === 0 ? undefined : matching[pick % matching.length];
}

function outRows(catalog: CatalogStore): CatalogRow[] {
  return [...catalog.iterate()]
    .filter((r) => r.data_name === NAME)
    .sort((a, b) => a.version - b.version);
}

async function checkInvariants(
  repo: FileSystemUnifiedDataRepository,
  catalog: CatalogStore,
  model: Map<number, Tracked>,
  trace: string,
): Promise<void> {
  const rows = outRows(catalog);
  const promoted = [...model.entries()]
    .filter(([, t]) => t.state === "promoted")
    .map(([v]) => v)
    .sort((a, b) => a - b);

  // 1. The catalog holds exactly the model's versions, pending ones unflagged.
  assertEquals(
    rows.map((r) => r.version),
    [...model.keys()].sort((a, b) => a - b),
    `catalog versions ${trace}`,
  );
  for (const row of rows) {
    const state = model.get(row.version)!.state;
    if (state === "promoted") {
      assertEquals(row.is_pending, 0, `promoted v${row.version} ${trace}`);
    } else {
      assertEquals(
        [row.is_pending, row.is_latest, row.is_step_latest],
        [1, 0, 0],
        `${state} v${row.version} ${trace}`,
      );
    }
  }

  // 2. The disk holds the same version directories.
  assertEquals(
    await repo.listVersions(TYPE, MODEL_ID, NAME),
    [...model.keys()].sort((a, b) => a - b),
    `disk versions ${trace}`,
  );

  // 3. Exactly one latest row, the highest promoted version, or none.
  assertEquals(
    rows.filter((r) => r.is_latest === 1).map((r) => r.version),
    promoted.length === 0 ? [] : [promoted[promoted.length - 1]],
    `is_latest ${trace}`,
  );

  // 4. With nothing in flight, the flags are what a rebuild derives.
  if (rows.every((r) => r.is_pending === 0)) {
    const expected = rows.map((r) => ({ ...r }));
    computeLatestFlags(expected);
    assertEquals(
      rows.map((r) => `${r.version}:${r.is_latest}:${r.is_step_latest}`),
      expected.map((r) => `${r.version}:${r.is_latest}:${r.is_step_latest}`),
      `flags ${trace}`,
    );
  }

  // 5. A latest read sees the highest promoted version, never an in-flight
  // write. With nothing promoted, a marker means nothing is readable; with
  // no marker the read falls back to the disk scan, as a first deferred
  // write always has.
  const latest = await repo.findByName(TYPE, MODEL_ID, NAME);
  const latestSync = repo.findByNameSync(TYPE, MODEL_ID, NAME);
  if (promoted.length > 0) {
    const highest = promoted[promoted.length - 1];
    assertEquals(latest?.version, highest, `latest read ${trace}`);
    assertEquals(latestSync?.version, highest, `latest sync read ${trace}`);
  } else {
    const marker = join(
      dirname(repo.getPath(TYPE, MODEL_ID, NAME, 1)),
      "latest",
    );
    const hasMarker = await Deno.lstat(marker).then(() => true, () => false);
    if (hasMarker) {
      assertEquals(latest, null, `latest read, nothing promoted ${trace}`);
      assertEquals(latestSync, null, `latest sync read ${trace}`);
    }
  }
}

Deno.test("property: deferred writes, removals, GC, backfill and crashes keep the catalog, disk and reads consistent (swamp-club#2975)", async () => {
  const root = await Deno.makeTempDir({ prefix: "swamp-deferred-model-" });
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbOp, { minLength: 1, maxLength: 40, size: "max" }),
        fc.boolean(),
        async (ops, writeGc) => {
          const dir = join(root, crypto.randomUUID());
          await Deno.mkdir(dir);
          const catalog = new CatalogStore(join(dir, "_catalog.db"));
          catalog.markPopulated();
          const repo = new FileSystemUnifiedDataRepository(
            dir,
            undefined,
            catalog,
            undefined,
            undefined,
            SOLO_NAMESPACE,
            writeGc,
          );
          const service = new DataQueryService(catalog, repo);
          const model = new Map<number, Tracked>();
          const trace: string[] = [`writeGc=${writeGc}`];
          try {
            for (const op of ops) {
              trace.push(JSON.stringify(op));
              switch (op.kind) {
                case "save": {
                  // The write-time cap prunes the oldest promoted versions so
                  // that, with the new one, at most GC_KEEP stay; versions in
                  // flight are neither counted nor pruned.
                  const priorPromoted = [...model.entries()]
                    .filter(([, t]) => t.state === "promoted")
                    .map(([v]) => v)
                    .sort((a, b) => a - b);
                  const r = await repo.save(
                    TYPE,
                    MODEL_ID,
                    data(op.step),
                    bytes("x"),
                  );
                  if (writeGc && priorPromoted.length >= GC_KEEP) {
                    for (
                      const v of priorPromoted.slice(
                        0,
                        priorPromoted.length - GC_KEEP + 1,
                      )
                    ) {
                      model.delete(v);
                    }
                  }
                  model.set(r.version, {
                    state: "promoted",
                    step: op.step,
                    receipt: {
                      type: TYPE,
                      modelId: MODEL_ID,
                      dataName: NAME,
                      version: r.version,
                    },
                  });
                  break;
                }
                case "saveDeferred": {
                  const receipt = await repo.saveDeferred(
                    TYPE,
                    MODEL_ID,
                    data(op.step),
                    bytes("x"),
                  );
                  model.set(receipt.version, {
                    state: "pending",
                    step: op.step,
                    receipt,
                  });
                  break;
                }
                case "allocate": {
                  const a = await repo.allocateVersion(
                    TYPE,
                    MODEL_ID,
                    data(op.step),
                    { deferred: true },
                  );
                  model.set(a.version, {
                    state: "allocated",
                    step: op.step,
                    receipt: {
                      type: TYPE,
                      modelId: MODEL_ID,
                      dataName: NAME,
                      version: a.version,
                    },
                    contentPath: a.contentPath,
                    priorVersions: a.priorVersions,
                  });
                  break;
                }
                case "finalize": {
                  const p = picked(model, ["allocated"], op.pick);
                  if (!p) break;
                  const [v, t] = p;
                  await Deno.writeFile(t.contentPath!, bytes("x"));
                  await repo.finalizeVersionDeferred(
                    TYPE,
                    MODEL_ID,
                    data(t.step),
                    v,
                    t.priorVersions,
                  );
                  t.state = "pending";
                  break;
                }
                case "promote": {
                  const p = picked(model, ["pending"], op.pick);
                  if (!p) break;
                  await repo.advanceLatestMarkers([p[1].receipt]);
                  p[1].state = "promoted";
                  break;
                }
                case "rollback": {
                  const p = picked(model, ["pending", "allocated"], op.pick);
                  if (!p) break;
                  await repo.rollbackVersions([p[1].receipt]);
                  model.delete(p[0]);
                  break;
                }
                case "crash": {
                  const p = picked(model, ["pending", "allocated"], op.pick);
                  if (!p) break;
                  const row = outRows(catalog).find((r) => r.version === p[0])!;
                  catalog.upsert({ ...row, pending_pid: DEAD_PID });
                  p[1].state = "crashed";
                  break;
                }
                case "handOff": {
                  // Another live process now owns the write: GC must leave it.
                  const p = picked(model, ["pending", "allocated"], op.pick);
                  if (!p) break;
                  const row = outRows(catalog).find((r) => r.version === p[0])!;
                  catalog.upsert({ ...row, pending_pid: Deno.ppid });
                  p[1].state = "foreign";
                  break;
                }
                case "delete": {
                  const p = picked(model, ["promoted"], op.pick);
                  if (!p) break;
                  await repo.delete(TYPE, MODEL_ID, NAME, p[0]);
                  model.delete(p[0]);
                  break;
                }
                case "gc": {
                  await repo.collectGarbage(TYPE, MODEL_ID);
                  for (const [v, t] of [...model.entries()]) {
                    if (t.state === "crashed") model.delete(v);
                  }
                  const promoted = [...model.entries()]
                    .filter(([, t]) => t.state === "promoted")
                    .map(([v]) => v)
                    .sort((a, b) => a - b);
                  if (promoted.length > GC_KEEP) {
                    for (const v of promoted.slice(0, -GC_KEEP)) {
                      model.delete(v);
                    }
                  }
                  break;
                }
                case "backfill": {
                  catalog.invalidate();
                  await service.ensurePopulated();
                  break;
                }
              }
              await checkInvariants(
                repo,
                catalog,
                model,
                trace.join(" > "),
              );
            }
          } finally {
            catalog.close();
          }
        },
      ),
      { numRuns: 300 },
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
