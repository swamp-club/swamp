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
import { computeLatestFlags, DataQueryService } from "./data_query_service.ts";
import type { DataRecord } from "./data_record.ts";
import type { UnifiedDataRepository } from "./repositories.ts";
import type { ModelType } from "../models/model_type.ts";
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
    garbage_collection: "10",
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

// ── Rename forwards (swamp-club#2968) ───────────────────────────────────────

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
    is_step_latest: 1,
    model_name: "ingest",
    spec_name: "",
    data_type: "resource",
    content_type: "text/plain",
    lifetime: "infinite",
    garbage_collection: "",
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

/**
 * The disk an unversioned repository read sees: a forwarded name's latest
 * version is its rename marker, any other live name holds data. Only the
 * methods rename-forward resolution reads are provided.
 */
function diskRepo(forwards: Map<string, string>): UnifiedDataRepository {
  const disk = {
    namespace: "",
    getLatestVersionSync: (_type: ModelType, _modelId: string, name: string) =>
      forwards.has(name) ? 2 : null,
    findByNameSync: (_type: ModelType, _modelId: string, name: string) =>
      forwards.has(name)
        ? { isRenamed: true, renamedTo: forwards.get(name) }
        : null,
  };
  return disk as unknown as UnifiedDataRepository;
}

Deno.test("DataQueryService rename forwards: a read by any name matches what the repository read returns", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-forward-prop-" });
  let run = 0;
  try {
    fc.assert(
      fc.property(
        // At most one forward per name, as a name has one latest version.
        fc.dictionary(fc.constantFrom(...NAMES), fc.constantFrom(...NAMES)),
        fc.subarray(NAMES),
        fc.constantFrom(...NAMES),
        fc.boolean(),
        (forwardRecord, liveNames, start, catalogKnowsAll) => {
          const catalog = new CatalogStore(join(dir, `catalog-${run++}.db`));
          try {
            catalog.markPopulated();
            const forwards = new Map(Object.entries(forwardRecord));
            // A name whose latest version is a rename marker holds no data.
            const live = new Set(liveNames.filter((n) => !forwards.has(n)));
            for (const name of live) catalog.upsert(row(name));
            // The catalog may miss forwards beyond the first hop (a missed
            // write-through); the markers on disk still decide the chain.
            for (const [from, to] of forwards) {
              if (!catalogKnowsAll && from !== start) continue;
              catalog.recordRename({
                namespace: "",
                type_normalized: "test-model",
                model_id: "model-001",
                data_name: from,
                renamed_to: to,
              });
            }
            const service = new DataQueryService(catalog, diskRepo(forwards));

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
