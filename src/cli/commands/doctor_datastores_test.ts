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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { Command } from "@cliffy/command";
import { join } from "@std/path";
import { ensureDirSync } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { SOLO_NAMESPACE } from "../../domain/data/namespace.ts";
import { DefaultDatastorePathResolver } from "../../infrastructure/persistence/default_datastore_path_resolver.ts";
import {
  catalogCompletenessDataDir,
  compareCatalogToDisk,
  doctorDatastoresCommand,
  repairLostV3FormatMarker,
} from "./doctor_datastores.ts";
import { initializeV3Datastore } from "../../infrastructure/datastore_v3/v3_datastore.ts";
import { ensureSupportedDatastoreFormat } from "../../infrastructure/persistence/datastore_format_guard.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { UserError } from "../../domain/errors.ts";
import { withMockedEnv } from "../../infrastructure/persistence/path_test_helpers.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

/**
 * Writes a data item to disk the way the repository lays it out:
 * `{type-segments}/{model-id}/{data-name}/{version}/metadata.yaml`.
 */
function writeDataItem(
  repoDir: string,
  typeSegments: string[],
  modelId: string,
  dataName: string,
  index: number,
): void {
  const nameDir = join(
    repoDir,
    ".swamp",
    "data",
    ...typeSegments,
    modelId,
    dataName,
  );
  const versionDir = join(nameDir, "1");
  ensureDirSync(versionDir);
  Deno.writeTextFileSync(
    join(versionDir, "raw"),
    JSON.stringify({ hello: "world" }),
  );
  Deno.writeTextFileSync(
    join(versionDir, "metadata.yaml"),
    stringifyYaml({
      name: dataName,
      id: `00000000-0000-1000-8000-0000000002${String(index).padStart(2, "0")}`,
      version: 1,
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      streaming: false,
      tags: { type: "resource", specName: "result", modelName: "shows" },
      ownerDefinition: { ownerType: "model-method", ownerRef: "test" },
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  Deno.writeTextFileSync(join(nameDir, "latest"), "1");
}

function withFixture(
  fn: (repoDir: string, catalog: CatalogStore) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const repoDir = Deno.makeTempDirSync({ prefix: "swamp-doctor-catalog-" });
    const catalog = new CatalogStore(
      join(repoDir, ".swamp", "data", "_catalog.db"),
    );
    try {
      await fn(repoDir, catalog);
    } finally {
      catalog.close();
      try {
        Deno.removeSync(repoDir, { recursive: true });
      } catch {
        // Windows may still hold the SQLite handle; the temp dir is disposable.
      }
    }
  };
}

Deno.test(
  "compareCatalogToDisk: reports the shortfall for a model missing from the index",
  withFixture(async (repoDir, catalog) => {
    // The exact shape from swamp-club#1580: a scoped type whose data names are
    // bare integers, present on disk, absent from the catalog.
    for (const [i, name] of ["207333", "124364", "289324"].entries()) {
      writeDataItem(repoDir, ["@scope", "shows"], "model-001", name, i);
    }
    // Catalog claims to be fully built and holds nothing.
    catalog.markPopulated();

    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );

    const summary = await compareCatalogToDisk(
      catalog,
      dataRepo,
      SOLO_NAMESPACE,
    );

    assertEquals(summary.diskRecords, 3);
    assertEquals(summary.catalogRecords, 0);
    assertEquals(summary.shortfalls.length, 1);
    assertEquals(summary.shortfalls[0].typeNormalized, "@scope/shows");
    assertEquals(summary.shortfalls[0].diskRecords, 3);
    assertEquals(summary.shortfalls[0].catalogRecords, 0);
  }),
);

Deno.test(
  "compareCatalogToDisk: does not modify the catalog it is measuring",
  withFixture(async (repoDir, catalog) => {
    for (const [i, name] of ["207333", "124364"].entries()) {
      writeDataItem(repoDir, ["@scope", "shows"], "model-001", name, i);
    }
    catalog.markPopulated();

    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );

    const rowsBefore = catalog.count();
    const populatedBefore = catalog.isPopulated();

    await compareCatalogToDisk(catalog, dataRepo, SOLO_NAMESPACE);

    // A diagnostic that triggers backfill repairs what it measures and then
    // reports health — the damaged state must survive being looked at.
    assertEquals(catalog.count(), rowsBefore);
    assertEquals(catalog.isPopulated(), populatedBefore);

    // And it is still detectable on a second run.
    const second = await compareCatalogToDisk(
      catalog,
      dataRepo,
      SOLO_NAMESPACE,
    );
    assertEquals(second.shortfalls.length, 1);
  }),
);

Deno.test(
  "compareCatalogToDisk: a fully indexed catalog reports no shortfall",
  withFixture(async (repoDir, catalog) => {
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );

    // Saving through the repository writes disk and catalog together, which is
    // what a healthy repo looks like.
    for (const name of ["207333", "recommendations"]) {
      writeDataItem(repoDir, ["@scope", "shows"], "model-001", name, 0);
    }
    for (const record of await dataRepo.findAllGlobal()) {
      catalog.upsert({
        id: record.data.id,
        namespace: SOLO_NAMESPACE,
        type_normalized: record.modelType.normalized,
        model_id: record.modelId,
        model_name: "shows",
        data_name: record.data.name,
        version: 1,
        is_latest: 1,
        is_step_latest: 1,
        spec_name: "result",
        data_type: "resource",
        content_type: "application/json",
        lifetime: "infinite",
        garbage_collection: "10",
        owner_type: "model-method",
        owner_ref: "test",
        streaming: 0,
        size: 0,
        created_at: "2026-01-01T00:00:00.000Z",
        tags: "{}",
        workflow_run_id: "",
        workflow_name: "",
        job_name: "",
        step_name: "",
        source: "",
      });
    }

    const summary = await compareCatalogToDisk(
      catalog,
      dataRepo,
      SOLO_NAMESPACE,
    );

    assertEquals(summary.diskRecords, 2);
    assertEquals(summary.catalogRecords, 2);
    assertEquals(summary.shortfalls.length, 0);
  }),
);

Deno.test("catalogCompletenessDataDir: is the repo's .swamp/data for the default datastore", () => {
  const repoDir = join("/repo");
  const resolver = new DefaultDatastorePathResolver(repoDir, {
    type: "filesystem",
    path: join(repoDir, ".swamp"),
  });
  assertEquals(
    catalogCompletenessDataDir(resolver),
    join(repoDir, ".swamp", "data"),
  );
});

Deno.test("catalogCompletenessDataDir: is the external path's data dir", () => {
  const external = join("/mnt", "nas", "store");
  const resolver = new DefaultDatastorePathResolver(join("/repo"), {
    type: "filesystem",
    path: external,
  });
  assertEquals(catalogCompletenessDataDir(resolver), join(external, "data"));
});

Deno.test("catalogCompletenessDataDir: includes the namespace", () => {
  const external = join("/mnt", "nas", "store");
  const resolver = new DefaultDatastorePathResolver(join("/repo"), {
    type: "filesystem",
    path: external,
    namespace: "team-a",
  });
  assertEquals(
    catalogCompletenessDataDir(resolver),
    join(external, "team-a", "data"),
  );
});

Deno.test("catalogCompletenessDataDir: is the cache's data dir for an extension datastore", () => {
  const cachePath = join("/home", "u", ".swamp", "repos", "id");
  const resolver = new DefaultDatastorePathResolver(join("/repo"), {
    type: "@swamp/s3-datastore",
    config: {},
    datastorePath: "s3://bucket",
    cachePath,
  });
  assertEquals(catalogCompletenessDataDir(resolver), join(cachePath, "data"));
});

Deno.test(
  "compareCatalogToDisk: reports the shortfall for records on an external datastore",
  withFixture(async (repoDir, catalog) => {
    // The records live on the external path; the local .swamp/data holds
    // only the catalog, which claims to be fully built and holds nothing.
    const externalParent = join(repoDir, "nas");
    for (const [i, name] of ["one", "two"].entries()) {
      writeDataItem(externalParent, ["command", "shell"], "model-001", name, i);
    }
    catalog.markPopulated();
    const resolver = new DefaultDatastorePathResolver(repoDir, {
      type: "filesystem",
      path: join(externalParent, ".swamp"),
    });

    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      catalogCompletenessDataDir(resolver),
      catalog,
    );
    const summary = await compareCatalogToDisk(
      catalog,
      dataRepo,
      SOLO_NAMESPACE,
    );

    assertEquals(summary.diskRecords, 2);
    assertEquals(summary.catalogRecords, 0);
    assertEquals(summary.shortfalls.length, 1);
  }),
);

// --- swamp-club#3617: --repair restores a v3 datastore's lost marker ---

async function captureLogs(fn: () => Promise<unknown>): Promise<string> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for await (const entry of Deno.readDir(dir)) {
    files[entry.name] = entry.isFile
      ? Array.from(await Deno.readFile(join(dir, entry.name))).join(",")
      : "dir";
  }
  return files;
}

/** A repo whose .swamp.yaml says `format` over a v3 datastore it holds. */
async function withV3Repo(
  format: 2 | 3 | undefined,
  fn: (repoDir: string, datastorePath: string) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-doctor-marker-" });
  try {
    const datastorePath = join(repoDir, "ds");
    await initializeV3Datastore(datastorePath, "test");
    await new RepoMarkerRepository().write(RepoPath.create(repoDir), {
      swampVersion: "0.0.0",
      initializedAt: new Date().toISOString(),
      repoId: crypto.randomUUID(),
      datastore: {
        type: "filesystem",
        path: datastorePath,
        ...(format !== undefined ? { format } : {}),
      },
    });
    await withMockedEnv(
      { SWAMP_DATASTORE: undefined },
      () => fn(repoDir, datastorePath),
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

Deno.test("repairLostV3FormatMarker: previews a lost marker opening nothing, then restores it with -y (swamp-club#3617)", async () => {
  await withV3Repo(3, async (repoDir, datastorePath) => {
    const markerPath = join(datastorePath, "datastore-format.json");
    for (const lost of [undefined, "", "\0\0\0\0"]) {
      await Deno.remove(markerPath).catch(() => {});
      if (lost !== undefined) await Deno.writeTextFile(markerPath, lost);
      const refusal = await assertRejects(() =>
        ensureSupportedDatastoreFormat(repoDir, {
          type: "filesystem",
          path: datastorePath,
          format: 3,
        })
      );
      const before = await snapshot(datastorePath);
      let status: string | undefined;
      const preview = await captureLogs(async () => {
        status = await repairLostV3FormatMarker(
          repoDir,
          refusal,
          "json",
          false,
        );
      });
      assertEquals(status, "preview");
      assertEquals(JSON.parse(preview), {
        status: "format_marker_preview",
        datastorePath,
        markerPath,
        marker: lost === undefined ? "absent" : "blank",
      });
      assertEquals(await snapshot(datastorePath), before);

      const restored = await captureLogs(async () => {
        status = await repairLostV3FormatMarker(
          repoDir,
          refusal,
          "json",
          true,
        );
      });
      assertEquals(status, "pass");
      assertEquals(JSON.parse(restored).status, "format_marker_restored");
      assertEquals(
        await ensureSupportedDatastoreFormat(repoDir, {
          type: "filesystem",
          path: datastorePath,
          format: 3,
        }),
        "v3",
      );
    }
  });
});

Deno.test("repairLostV3FormatMarker: leaves every other refusal to be rethrown unchanged (swamp-club#3617)", async () => {
  // A config that does not say format 3: the marker is not restored here.
  await withV3Repo(undefined, async (repoDir, datastorePath) => {
    await Deno.remove(join(datastorePath, "datastore-format.json"));
    const refusal = await assertRejects(() =>
      ensureSupportedDatastoreFormat(repoDir, {
        type: "filesystem",
        path: datastorePath,
      })
    );
    assertEquals(
      await repairLostV3FormatMarker(repoDir, refusal, "json", true),
      undefined,
    );
    assertEquals(
      (await snapshot(datastorePath))["datastore-format.json"],
      undefined,
    );
  });
  // A healthy v3 datastore, and errors that are not format refusals.
  await withV3Repo(3, async (repoDir) => {
    for (
      const error of [
        new UserError("mismatch", "datastore_format_mismatch"),
        new UserError("other", "validation_failed"),
        new Error("boom"),
      ]
    ) {
      assertEquals(
        await repairLostV3FormatMarker(repoDir, error, "json", true),
        undefined,
      );
    }
  });
});

Deno.test("doctor datastores --repair: a v3 datastore whose marker was lost is refused, previewed under --repair, and restored with -y, in log and json modes (swamp-club#3617)", async () => {
  await initializeLogging({});
  for (const json of [false, true]) {
    await withV3Repo(3, async (repoDir, datastorePath) => {
      const markerPath = join(datastorePath, "datastore-format.json");
      await Deno.remove(markerPath);
      const doctor = (...args: string[]) =>
        captureLogs(() =>
          new Command()
            .globalOption("--json", "JSON output")
            .command("datastores", doctorDatastoresCommand)
            .parse([
              "datastores",
              "--repo-dir",
              repoDir,
              ...args,
              ...(json ? ["--json"] : []),
            ])
        );

      // Without --repair the guard's refusal stands.
      await assertRejects(() => doctor(), UserError);

      const before = await snapshot(datastorePath);
      const preview = await doctor("--repair");
      assertEquals(await snapshot(datastorePath), before);
      if (json) {
        assertEquals(JSON.parse(preview), {
          status: "format_marker_preview",
          datastorePath,
          markerPath,
          marker: "absent",
        });
      } else {
        assertStringIncludes(preview, "Lost datastore format marker:");
        assertStringIncludes(preview, `${markerPath} is missing`);
      }

      const restored = await doctor("--repair", "-y");
      if (json) {
        assertEquals(JSON.parse(restored).status, "format_marker_restored");
      } else {
        assertStringIncludes(restored, "Datastore format marker restored:");
        assertStringIncludes(
          restored,
          "Run `swamp doctor datastores` to check the datastore.",
        );
      }
      assertEquals(
        await ensureSupportedDatastoreFormat(repoDir, {
          type: "filesystem",
          path: datastorePath,
          format: 3,
        }),
        "v3",
      );
    });
  }
});
