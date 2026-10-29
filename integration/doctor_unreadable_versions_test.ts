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
 * Integration test for swamp-club#3955: a v2 filesystem datastore whose
 * newest data versions an unclean shutdown left empty. The real repository,
 * catalog, doctor scan and libswamp repair are wired together: a read warns,
 * the scan reports the version, and the repair leaves the record's last
 * readable version latest on disk, in the catalog and through queries.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { Data } from "../src/domain/data/data.ts";
import { SOLO_NAMESPACE } from "../src/domain/data/namespace.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { DataQueryService } from "../src/domain/data/data_query_service.ts";
import type { DataRecord } from "../src/domain/data/data_record.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { scanUnreadableVersions } from "../src/infrastructure/persistence/unreadable_data_versions.ts";
import { captureUnreadableWarnings } from "../src/infrastructure/persistence/unreadable_records_test_helpers.ts";
import {
  repairUnreadableVersions,
  type RepairUnreadableVersionsDeps,
  type RepairUnreadableVersionsEvent,
} from "../src/libswamp/datastores/doctor_datastores.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { collect } from "../src/libswamp/testing.ts";

const type = ModelType.create("@swamp/software-factory");

interface Repo {
  catalog: CatalogStore;
  repo: FileSystemUnifiedDataRepository;
  modelId: string;
  nameDir: (name: string) => string;
  write: (name: string, count: number) => Promise<void>;
}

async function withRepo(fn: (r: Repo) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-doctor-unreadable-" });
  const catalog = new CatalogStore(join(dir, "_catalog.db"));
  const repo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const modelId = crypto.randomUUID();
  try {
    await fn({
      catalog,
      repo,
      modelId,
      nameDir: (name) => repo.getDataNameDir(type, modelId, name),
      write: async (name, count) => {
        for (let i = 1; i <= count; i++) {
          await repo.save(
            type,
            modelId,
            Data.create({
              name,
              contentType: "application/json",
              lifetime: "infinite",
              garbageCollection: 10,
              tags: { type: "resource", modelName: "work-item" },
              ownerDefinition: {
                ownerType: "model-method",
                ownerRef: "work-item:advance",
              },
            }),
            new TextEncoder().encode(JSON.stringify({ stageId: `s${i}` })),
          );
        }
      },
    });
  } finally {
    catalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** Empties a version's files, as an unclean shutdown leaves them. */
async function truncate(versionDir: string): Promise<void> {
  await Deno.writeFile(join(versionDir, "raw"), new Uint8Array());
  await Deno.writeFile(join(versionDir, "metadata.yaml"), new Uint8Array());
}

/**
 * Leaves version `version` of a data name as a save killed before it was
 * published: metadata copied from version `from` and renumbered, no raw
 * unless `complete`, no catalog row, and the marker left where it was.
 */
async function writeCrashedSave(
  nameDir: string,
  from: number,
  version: number,
  { complete = false }: { complete?: boolean } = {},
): Promise<void> {
  const metadata = parseYaml(
    await Deno.readTextFile(join(nameDir, String(from), "metadata.yaml")),
  ) as Record<string, unknown>;
  await Deno.mkdir(join(nameDir, String(version)));
  await Deno.writeTextFile(
    join(nameDir, String(version), "metadata.yaml"),
    stringifyYaml({ ...metadata, version, id: crypto.randomUUID() }),
  );
  // Killed after both files landed, before the marker moved.
  if (complete) {
    await Deno.copyFile(
      join(nameDir, String(from), "raw"),
      join(nameDir, String(version), "raw"),
    );
  }
}

/** The libswamp repair over the real repository and catalog. */
function repairDeps(r: Repo): RepairUnreadableVersionsDeps {
  const scan = () => scanUnreadableVersions(r.repo, r.catalog, SOLO_NAMESPACE);
  return {
    scan,
    underModelLocks: (_models, fn) =>
      fn({
        scan,
        rollBack: (record, versions) =>
          r.repo.rollBackToReadable(
            ModelType.create(record.modelType),
            record.modelId,
            record.dataName,
            versions,
          ),
      }),
  };
}

async function repair(r: Repo): Promise<RepairUnreadableVersionsEvent[]> {
  return await collect<RepairUnreadableVersionsEvent>(
    repairUnreadableVersions(createLibSwampContext(), repairDeps(r), {
      confirm: true,
    }),
  );
}

Deno.test("doctor unreadable versions: a read warns, the scan reports, and the repair leaves the last readable version latest everywhere (swamp-club#3955)", async () => {
  await withRepo(async (r) => {
    await r.write("state", 3);
    await truncate(join(r.nameDir("state"), "3"));

    const warnings = await captureUnreadableWarnings(async () => {
      assertEquals(await r.repo.findByName(type, r.modelId, "state"), null);
      assertEquals(await r.repo.findByName(type, r.modelId, "state"), null);
    }, ["data", "repository"]);
    assertEquals(warnings.length, 1, warnings.join("\n"));

    const found = await scanUnreadableVersions(
      r.repo,
      r.catalog,
      SOLO_NAMESPACE,
    );
    assertEquals(found.map((f) => [f.dataName, f.version, f.latest]), [
      ["state", 3, true],
    ]);

    const events = await repair(r);
    const completed = events.find((e) => e.kind === "completed");
    assert(completed?.kind === "completed", JSON.stringify(events));
    assertEquals(completed.result.versionsRemoved, 1);

    // On disk: the marker names version 2.
    assertEquals(
      await Deno.readTextFile(join(r.nameDir("state"), "latest")),
      "2",
    );
    // In the catalog: version 2 is latest, and step latest for its step.
    const rows = [...r.catalog.iterateNamespace(SOLO_NAMESPACE)]
      .filter((row) => row.data_name === "state")
      .map((row) => [row.version, row.is_latest, row.is_step_latest]);
    assertEquals(rows.sort(), [[1, 0, 0], [2, 1, 1]]);
    // Through reads and queries.
    assertEquals(
      (await r.repo.findByName(type, r.modelId, "state"))?.version,
      2,
    );
    const records = await new DataQueryService(r.catalog, r.repo).query(
      'name == "state"',
    ) as DataRecord[];
    assertEquals(records.map((rec) => rec.version), [2]);
    assertEquals(records[0].attributes, { stageId: "s2" });

    assertEquals(
      await scanUnreadableVersions(r.repo, r.catalog, SOLO_NAMESPACE),
      [],
    );
  });
});

Deno.test("doctor unreadable versions: a record whose only version is unreadable is removed entirely (swamp-club#3955)", async () => {
  await withRepo(async (r) => {
    await r.write("evidence", 1);
    await r.write("journal", 2);
    await truncate(join(r.nameDir("evidence"), "1"));

    const events = await repair(r);
    const completed = events.find((e) => e.kind === "completed");
    assert(completed?.kind === "completed", JSON.stringify(events));
    assertEquals(completed.result.recordsRemoved, 1);

    let gone = false;
    try {
      await Deno.stat(r.nameDir("evidence"));
    } catch (error) {
      gone = error instanceof Deno.errors.NotFound;
    }
    assertEquals(gone, true);
    assertEquals(
      r.catalog.versionKeys(SOLO_NAMESPACE).map((k) => k.data_name),
      ["journal", "journal"],
    );
    assertEquals(
      await scanUnreadableVersions(r.repo, r.catalog, SOLO_NAMESPACE),
      [],
    );
  });
});

Deno.test("doctor unreadable versions: an unreadable latest marker is rewritten to the highest readable version (swamp-club#3955)", async () => {
  await withRepo(async (r) => {
    await r.write("status", 2);
    await Deno.writeFile(join(r.nameDir("status"), "latest"), new Uint8Array());

    const events = await repair(r);
    assert(
      events.some((e) => e.kind === "completed"),
      JSON.stringify(events),
    );
    assertEquals(
      await Deno.readTextFile(join(r.nameDir("status"), "latest")),
      "2",
    );
    assertEquals(
      await scanUnreadableVersions(r.repo, r.catalog, SOLO_NAMESPACE),
      [],
    );
  });
});

Deno.test("doctor unreadable versions: a foreign-namespace catalog row is neither reported nor removed (swamp-club#3955)", async () => {
  await withRepo(async (r) => {
    await r.write("state", 1);
    const [own] = [...r.catalog.iterateNamespace(SOLO_NAMESPACE)];
    r.catalog.upsert({ ...own, namespace: "other", id: crypto.randomUUID() });

    const events = await repair(r);
    assertEquals(events.map((e) => e.kind), ["scanning", "not_needed"]);
    assertEquals(r.catalog.versionKeys("other").length, 1);
  });
});

Deno.test("doctor unreadable versions: a crashed save above an unreadable version gains no catalog row, so the catalog and the marker agree (swamp-club#3955)", async () => {
  for (const unreadable of [1, 3]) {
    await withRepo(async (r) => {
      await r.write("state", 3);
      await truncate(join(r.nameDir("state"), String(unreadable)));
      // A save killed after metadata.yaml landed: no raw, no catalog row,
      // and the marker still names version 3.
      await writeCrashedSave(r.nameDir("state"), 2, 4);

      const events = await repair(r);
      assert(
        events.some((e) => e.kind === "completed"),
        JSON.stringify(events),
      );

      const expected = unreadable === 3 ? 2 : 3;
      assertEquals(
        await Deno.readTextFile(join(r.nameDir("state"), "latest")),
        String(expected),
      );
      const latestRows = r.catalog.versionKeys(SOLO_NAMESPACE)
        .filter((k) => k.is_latest === 1)
        .map((k) => k.version);
      assertEquals(latestRows, [expected]);
      assertEquals(
        r.catalog.versionKeys(SOLO_NAMESPACE).some((k) => k.version === 4),
        false,
      );
      // A live repo's catalog is populated, so the query reads the rows
      // above instead of rebuilding them from every directory on disk.
      r.catalog.markPopulated();
      const records = await new DataQueryService(r.catalog, r.repo).query(
        'name == "state"',
      ) as DataRecord[];
      assertEquals(records.map((rec) => rec.version), [expected]);
      assertEquals(
        await scanUnreadableVersions(r.repo, r.catalog, SOLO_NAMESPACE),
        [],
      );
    });
  }
});

Deno.test("doctor unreadable versions: a record left with only a crashed save reads as absent and is not reported removed (swamp-club#3955)", async () => {
  await withRepo(async (r) => {
    await r.write("state", 1);
    await writeCrashedSave(r.nameDir("state"), 1, 2);
    await truncate(join(r.nameDir("state"), "1"));

    const events = await repair(r);
    const completed = events.find((e) => e.kind === "completed");
    assert(completed?.kind === "completed", JSON.stringify(events));
    assertEquals(completed.result.recordsRemoved, 0);
    assertEquals(completed.result.records[0].becomesLatest, null);
    assertEquals(r.catalog.versionKeys(SOLO_NAMESPACE), []);
    assertEquals(await r.repo.findByName(type, r.modelId, "state"), null);
    assertEquals(
      await scanUnreadableVersions(r.repo, r.catalog, SOLO_NAMESPACE),
      [],
    );
  });
});

Deno.test("doctor unreadable versions: a complete crashed save above the published versions never becomes latest (swamp-club#3955)", async () => {
  for (const damage of ["version", "marker"] as const) {
    await withRepo(async (r) => {
      await r.write("state", 3);
      if (damage === "version") {
        await truncate(join(r.nameDir("state"), "1"));
      } else {
        await Deno.writeFile(
          join(r.nameDir("state"), "latest"),
          new Uint8Array(),
        );
      }
      await writeCrashedSave(r.nameDir("state"), 3, 4, { complete: true });

      const found = await scanUnreadableVersions(
        r.repo,
        r.catalog,
        SOLO_NAMESPACE,
      );
      assertEquals(found.map((f) => f.readableVersion), [3]);

      const events = await repair(r);
      assert(
        events.some((e) => e.kind === "completed"),
        JSON.stringify(events),
      );
      assertEquals(
        await Deno.readTextFile(join(r.nameDir("state"), "latest")),
        "3",
        damage,
      );
      assertEquals(
        r.catalog.versionKeys(SOLO_NAMESPACE)
          .filter((k) => k.is_latest === 1)
          .map((k) => k.version),
        [3],
      );
      assertEquals(
        (await r.repo.findByName(type, r.modelId, "state"))?.version,
        3,
      );
    });
  }
});
