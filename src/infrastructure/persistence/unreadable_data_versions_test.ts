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
import { join } from "@std/path";
import { CatalogStore } from "./catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "./unified_data_repository.ts";
import { scanUnreadableVersions } from "./unreadable_data_versions.ts";
import { Data, SOLO_NAMESPACE } from "../../domain/data/mod.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import type { UnreadableDataVersion } from "../../domain/data/unreadable_data_version.ts";

const type = ModelType.create("@test/spec");

interface Fixture {
  dir: string;
  catalog: CatalogStore;
  repo: FileSystemUnifiedDataRepository;
  modelId: string;
  /** Saves `count` versions of `name`, each with JSON content. */
  write: (name: string, count: number) => Promise<void>;
  /** The directory of one version of `name`. */
  versionDir: (name: string, version: number) => string;
  scan: () => Promise<UnreadableDataVersion[]>;
}

async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-unreadable-" });
  const catalog = new CatalogStore(join(dir, "_catalog.db"));
  const repo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const modelId = crypto.randomUUID();
  try {
    await fn({
      dir,
      catalog,
      repo,
      modelId,
      write: async (name, count) => {
        for (let i = 0; i < count; i++) {
          await repo.save(
            type,
            modelId,
            Data.create({
              name,
              contentType: "application/json",
              lifetime: "infinite",
              garbageCollection: 100,
              tags: { type: "resource", modelName: "spec" },
              ownerDefinition: { ownerType: "manual", ownerRef: "test" },
            }),
            new TextEncoder().encode(JSON.stringify({ stageId: `s${i}` })),
          );
        }
      },
      versionDir: (name, version) => repo.getPath(type, modelId, name, version),
      scan: () => scanUnreadableVersions(repo, catalog, SOLO_NAMESPACE),
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

Deno.test("scanUnreadableVersions: a clean datastore has no findings", async () => {
  await withFixture(async (f) => {
    await f.write("state", 3);
    assertEquals(await f.scan(), []);
  });
});

Deno.test("scanUnreadableVersions: a zero-byte latest version is reported as latest, with the version a repair leaves", async () => {
  await withFixture(async (f) => {
    await f.write("state", 3);
    await truncate(f.versionDir("state", 3));
    assertEquals(await f.scan(), [{
      modelType: type.normalized,
      modelId: f.modelId,
      modelName: "spec",
      dataName: "state",
      version: 3,
      reason: "metadata_empty",
      latest: true,
      readableVersion: 2,
    }]);
  });
});

Deno.test("scanUnreadableVersions: missing metadata, missing raw and short raw each have their reason", async () => {
  await withFixture(async (f) => {
    await f.write("a", 2);
    await f.write("b", 2);
    await f.write("c", 2);
    await Deno.remove(join(f.versionDir("a", 2), "metadata.yaml"));
    await Deno.remove(join(f.versionDir("b", 2), "raw"));
    await Deno.writeTextFile(join(f.versionDir("c", 2), "raw"), "{");
    const found = await f.scan();
    assertEquals(
      found.map((x) => [x.dataName, x.version, x.reason, x.readableVersion]),
      [
        ["a", 2, "metadata_missing", 1],
        ["b", 2, "content_missing", 1],
        ["c", 2, "content_short", 1],
      ],
    );
  });
});

Deno.test("scanUnreadableVersions: a catalog row whose version directory is gone is reported", async () => {
  await withFixture(async (f) => {
    await f.write("state", 2);
    await Deno.remove(f.versionDir("state", 2), { recursive: true });
    const [finding] = await f.scan();
    assertEquals(finding.reason, "version_missing");
    assertEquals(finding.version, 2);
    assertEquals(finding.latest, true);
    assertEquals(finding.readableVersion, 1);
  });
});

Deno.test("scanUnreadableVersions: an older unreadable version is reported but not as latest", async () => {
  await withFixture(async (f) => {
    await f.write("state", 3);
    await truncate(f.versionDir("state", 1));
    const [finding] = await f.scan();
    assertEquals(finding.version, 1);
    assertEquals(finding.latest, false);
    assertEquals(finding.readableVersion, 3);
  });
});

Deno.test("scanUnreadableVersions: a version that is not published (an in-flight write) is not reported", async () => {
  await withFixture(async (f) => {
    await f.write("state", 2);
    // A save that wrote its metadata and stopped: no catalog row, and the
    // marker still names version 2.
    await Deno.mkdir(f.versionDir("state", 3));
    await Deno.writeFile(
      join(f.versionDir("state", 3), "metadata.yaml"),
      new Uint8Array(),
    );
    assertEquals(await f.scan(), []);
  });
});

Deno.test("scanUnreadableVersions: a pending deferred write is not reported", async () => {
  await withFixture(async (f) => {
    await f.write("state", 1);
    const receipt = await f.repo.saveDeferred(
      type,
      f.modelId,
      Data.create({
        name: "state",
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 100,
        tags: { type: "resource" },
        ownerDefinition: { ownerType: "manual", ownerRef: "test" },
      }),
      new TextEncoder().encode("{}"),
    );
    await truncate(f.versionDir("state", receipt.version));
    assertEquals(await f.scan(), []);
  });
});

Deno.test("scanUnreadableVersions: a NO_PROMOTED_VERSION marker names no version", async () => {
  await withFixture(async (f) => {
    await f.write("state", 1);
    await Deno.writeTextFile(
      join(f.versionDir("state", 1), "..", "latest"),
      "0",
    );
    assertEquals(await f.scan(), []);
  });
});

Deno.test("scanUnreadableVersions: an empty marker is its own finding and never promotes the highest directory", async () => {
  await withFixture(async (f) => {
    await f.write("state", 2);
    await Deno.writeFile(
      join(f.versionDir("state", 1), "..", "latest"),
      new Uint8Array(),
    );
    assertEquals(await f.scan(), [{
      modelType: type.normalized,
      modelId: f.modelId,
      modelName: "spec",
      dataName: "state",
      version: null,
      reason: "marker_unreadable",
      latest: true,
      readableVersion: 2,
    }]);
  });
});

Deno.test("scanUnreadableVersions: a rename marker, whose content is shorter than the data it replaced, is readable", async () => {
  await withFixture(async (f) => {
    await f.write("old", 1);
    await f.repo.rename(type, f.modelId, "old", "new");
    assertEquals(await f.scan(), []);
  });
});

Deno.test("scanUnreadableVersions: catalog rows of another namespace are never read", async () => {
  await withFixture(async (f) => {
    await f.write("state", 1);
    f.catalog.upsert({
      namespace: "other",
      type_normalized: type.normalized,
      model_id: f.modelId,
      data_name: "elsewhere",
      id: crypto.randomUUID(),
      version: 4,
      is_latest: 1,
      is_step_latest: 1,
      model_name: "spec",
      spec_name: "",
      data_type: "resource",
      content_type: "application/json",
      lifetime: "infinite",
      garbage_collection: "100",
      lifecycle: "active",
      owner_type: "manual",
      streaming: 0,
      size: 10,
      created_at: new Date().toISOString(),
      tags: "{}",
      owner_ref: "test",
      workflow_run_id: "",
      workflow_name: "",
      job_name: "",
      step_name: "",
      source: "",
    });
    assertEquals(await f.scan(), []);
  });
});

Deno.test("scanUnreadableVersions: a record whose only version is unreadable has no readable version", async () => {
  await withFixture(async (f) => {
    await f.write("state", 1);
    await truncate(f.versionDir("state", 1));
    const [finding] = await f.scan();
    assertEquals(finding.readableVersion, null);
    assertEquals(finding.modelName, "spec");
  });
});
