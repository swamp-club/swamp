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
 * Integration tests for latest-version tracking when several workflow steps
 * write the same data name (swamp-club#2520).
 *
 * Wires a real FileSystemUnifiedDataRepository, CatalogStore and
 * DataQueryService on a temp directory and checks that:
 * 1. A default (latest-only) query returns one version per data name.
 * 2. A latestPerStep query still returns each step's latest (swamp-club#1761).
 * 3. Deferred writes promoted in reverse version order converge.
 * 4. A v4 catalog holding per-step duplicate latests rebuilds cleanly.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { DatabaseSync } from "node:sqlite";

import { Data } from "../src/domain/data/data.ts";
import type { DataRecord } from "../src/domain/data/data_record.ts";
import { DataQueryService } from "../src/domain/data/data_query_service.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { computeDefinitionHash } from "../src/domain/models/model_output.ts";

import "../src/domain/models/models.ts";

const MODEL_TYPE = ModelType.create("repro/counter");
const MODEL_ID = "550e8400-e29b-41d4-a716-446655442520";
const PREDICATE = 'modelName == "c1" && name == "item-b"';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-step-latest-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function catalogPath(dir: string): string {
  return join(dir, ".swamp", "data", "_catalog.db");
}

async function openRepo(dir: string) {
  await ensureDir(join(dir, ".swamp", "data"));
  const catalog = new CatalogStore(catalogPath(dir));
  const dataRepo = new FileSystemUnifiedDataRepository(
    dir,
    undefined,
    catalog,
  );
  const query = new DataQueryService(catalog, dataRepo);
  return { catalog, dataRepo, query };
}

/** A version of item-b written by the c1.write method from `stepName`. */
async function itemB(stepName: string, jobName = "main"): Promise<Data> {
  return Data.create({
    name: "item-b",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", specName: "item", modelName: "c1" },
    ownerDefinition: {
      definitionHash: await computeDefinitionHash({
        type: "model-method",
        ref: "c1:write",
      }),
      ownerType: "model-method",
      ownerRef: "c1:write",
      ...(stepName ? { stepName, jobName } : {}),
    },
  });
}

function body(state: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ state }));
}

function versionsAndLatest(records: DataRecord[]): [number, boolean][] {
  return records
    .map((r): [number, boolean] => [r.version, r.isLatest])
    .sort((a, b) => a[0] - b[0]);
}

Deno.test("step latest: two steps writing one name leave a single latest version", async () => {
  await withTempDir(async (dir) => {
    const { catalog, dataRepo, query } = await openRepo(dir);
    try {
      catalog.markPopulated();
      await dataRepo.save(
        MODEL_TYPE,
        MODEL_ID,
        await itemB("s1"),
        body("Ingesting"),
      );
      await dataRepo.save(
        MODEL_TYPE,
        MODEL_ID,
        await itemB("s2"),
        body("Ingested"),
      );

      const latest = await query.query(PREDICATE) as DataRecord[];
      assertEquals(versionsAndLatest(latest), [[2, true]]);
      assertEquals(latest[0].attributes, { state: "Ingested" });

      const history = await query.query(
        `${PREDICATE} && version >= 0`,
      ) as DataRecord[];
      assertEquals(versionsAndLatest(history), [[1, false], [2, true]]);

      const perStep = await query.query(PREDICATE, {
        latestPerStep: true,
      }) as DataRecord[];
      assertEquals(versionsAndLatest(perStep), [[1, false], [2, true]]);

      // A later model-method write supersedes every step's output.
      await dataRepo.save(
        MODEL_TYPE,
        MODEL_ID,
        await itemB(""),
        body("Manual"),
      );
      const afterManual = await query.query(PREDICATE, {
        latestPerStep: true,
      }) as DataRecord[];
      assertEquals(versionsAndLatest(afterManual), [[3, true]]);
      assertEquals(catalog.countDuplicateLatest(), 0);
    } finally {
      catalog.close();
    }
  });
});

Deno.test("step latest: three steps across two jobs leave a single latest version", async () => {
  await withTempDir(async (dir) => {
    const { catalog, dataRepo, query } = await openRepo(dir);
    try {
      catalog.markPopulated();
      for (const [step, job] of [["s1", "ja"], ["s2", "ja"], ["s3", "jb"]]) {
        await dataRepo.save(
          MODEL_TYPE,
          MODEL_ID,
          await itemB(step, job),
          body(step),
        );
      }

      const latest = await query.query(PREDICATE) as DataRecord[];
      assertEquals(versionsAndLatest(latest), [[3, true]]);
      const perStep = await query.query(PREDICATE, {
        latestPerStep: true,
      }) as DataRecord[];
      assertEquals(perStep.map((r) => r.stepName).sort(), ["s1", "s2", "s3"]);
    } finally {
      catalog.close();
    }
  });
});

Deno.test("step latest: deferred writes promoted in reverse version order converge", async () => {
  await withTempDir(async (dir) => {
    const { catalog, dataRepo, query } = await openRepo(dir);
    try {
      catalog.markPopulated();
      const r1 = await dataRepo.saveDeferred(
        MODEL_TYPE,
        MODEL_ID,
        await itemB("s1"),
        body("Ingesting"),
      );
      const r2 = await dataRepo.saveDeferred(
        MODEL_TYPE,
        MODEL_ID,
        await itemB("s2"),
        body("Ingested"),
      );
      assertEquals(await query.query(PREDICATE), []);

      await dataRepo.advanceLatestMarkers([r2]);
      await dataRepo.advanceLatestMarkers([r1]);

      // The on-disk marker follows version order too, so disk reads and
      // catalog reads agree.
      assertEquals(
        dataRepo.getLatestVersionSync(MODEL_TYPE, MODEL_ID, "item-b"),
        2,
      );
      assertEquals(
        (await dataRepo.findByName(MODEL_TYPE, MODEL_ID, "item-b"))?.version,
        2,
      );

      const latest = await query.query(PREDICATE) as DataRecord[];
      assertEquals(versionsAndLatest(latest), [[2, true]]);
      const perStep = await query.query(PREDICATE, {
        latestPerStep: true,
      }) as DataRecord[];
      assertEquals(versionsAndLatest(perStep), [[1, false], [2, true]]);
      assertEquals(catalog.countDuplicateLatest(), 0);
    } finally {
      catalog.close();
    }
  });
});

Deno.test("step latest: saves finishing out of version order keep disk and catalog on the highest version", async () => {
  await withTempDir(async (dir) => {
    const { catalog, dataRepo, query } = await openRepo(dir);
    try {
      catalog.markPopulated();
      // Two parallel steps allocate v1 and v2; the v2 writer finishes first.
      const v1 = await itemB("s1");
      const v2 = await itemB("s2");
      const allocated1 = await dataRepo.allocateVersion(
        MODEL_TYPE,
        MODEL_ID,
        v1,
      );
      const allocated2 = await dataRepo.allocateVersion(
        MODEL_TYPE,
        MODEL_ID,
        v2,
      );
      await Deno.writeFile(allocated1.contentPath, body("Ingesting"));
      await Deno.writeFile(allocated2.contentPath, body("Ingested"));
      await dataRepo.finalizeVersion(
        MODEL_TYPE,
        MODEL_ID,
        v2,
        allocated2.version,
      );
      await dataRepo.finalizeVersion(
        MODEL_TYPE,
        MODEL_ID,
        v1,
        allocated1.version,
      );

      assertEquals(
        dataRepo.getLatestVersionSync(MODEL_TYPE, MODEL_ID, "item-b"),
        2,
      );
      const latest = await query.query(PREDICATE) as DataRecord[];
      assertEquals(versionsAndLatest(latest), [[2, true]]);
    } finally {
      catalog.close();
    }
  });
});

Deno.test("step latest: a v4 catalog with per-step duplicate latests rebuilds from disk", async () => {
  await withTempDir(async (dir) => {
    // Write the data to disk through the current repository.
    const first = await openRepo(dir);
    first.catalog.markPopulated();
    await first.dataRepo.save(
      MODEL_TYPE,
      MODEL_ID,
      await itemB("s1"),
      body("Ingesting"),
    );
    await first.dataRepo.save(
      MODEL_TYPE,
      MODEL_ID,
      await itemB("s2"),
      body("Ingested"),
    );
    first.catalog.close();

    // Replace the catalog with what a v4 build left behind: both versions
    // flagged latest, and populated so no backfill would run.
    for (const suffix of ["", "-wal", "-shm"]) {
      await Deno.remove(catalogPath(dir) + suffix).catch(() => {});
    }
    const db = new DatabaseSync(catalogPath(dir));
    db.exec(`
      CREATE TABLE catalog (
        namespace TEXT NOT NULL DEFAULT '', type_normalized TEXT NOT NULL,
        model_id TEXT NOT NULL, data_name TEXT NOT NULL, id TEXT NOT NULL,
        version INTEGER NOT NULL, is_latest INTEGER NOT NULL DEFAULT 1,
        model_name TEXT NOT NULL, created_at TEXT NOT NULL,
        step_name TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (namespace, type_normalized, model_id, data_name, version)
      );
      CREATE TABLE catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO catalog VALUES
        ('', 'repro/counter', '${MODEL_ID}', 'item-b', 'a', 1, 1, 'c1', '2026-01-01T00:00:00.000Z', 's1'),
        ('', 'repro/counter', '${MODEL_ID}', 'item-b', 'b', 2, 1, 'c1', '2026-01-01T00:00:01.000Z', 's2');
      INSERT INTO catalog_meta VALUES ('schema_version', '4'), ('populated', 'true');
    `);
    db.close();

    const second = await openRepo(dir);
    try {
      assertEquals(second.catalog.isPopulated(), false);
      const latest = await second.query.query(PREDICATE) as DataRecord[];
      assertEquals(versionsAndLatest(latest), [[2, true]]);
      const perStep = await second.query.query(PREDICATE, {
        latestPerStep: true,
      }) as DataRecord[];
      assertEquals(versionsAndLatest(perStep), [[1, false], [2, true]]);
    } finally {
      second.catalog.close();
    }
  });
});
