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

// Cold-start indexing of an extension whose export wraps its definition
// (swamp-club#2562). The startup reconcile indexes it by importing the
// bundle; the cold buildIndex walk that follows must keep that row instead
// of warning that the type cannot be extracted, or overwriting it with a
// type the static regex found elsewhere in the file.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { ExtensionLoader } from "../src/domain/extensions/extension_loader.ts";
import { modelKindAdapter } from "../src/domain/extensions/model_kind_adapter.ts";
import { ReconcileFromDiskService } from "../src/libswamp/extensions/reconcile_from_disk_service.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import {
  getExtensionLoadWarnings,
  resetExtensionLoadWarnings,
} from "../src/infrastructure/logging/extension_load_warnings.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";

import "../src/domain/models/models.ts";

const testDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
  getDenoEnv: () => Deno.env.toObject(),
};

/**
 * An extension whose export is a wrapper call. With `decoy`, an unrelated
 * object literal with a `type` field follows it, which the static regex
 * picks up instead of failing.
 */
const WRAPPED_EXTENSION = (targetType: string, decoy: boolean) => `
import { z } from "npm:zod@4";

function withDefaults<T>(definition: T): T {
  return definition;
}

const definition = {
  type: "${targetType}",
  methods: [{
    probe: {
      description: "probe",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  }],
};

export const extension = withDefaults(definition);
${decoy ? 'export const unrelated = { type: "@test/decoy" };' : ""}
`;

async function withRepo(
  decoy: boolean,
  fn: (args: {
    repoDir: string;
    modelsDir: string;
    extPath: string;
    catalog: ExtensionCatalogStore;
    repository: ExtensionRepository;
    lockfileRepository: LockfileRepository;
  }) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_2562_cold_" });
  const modelsDir = join(repoDir, "extensions", "models");
  await ensureDir(join(repoDir, ".swamp"));
  await ensureDir(modelsDir);
  const lockfilePath = join(modelsDir, "upstream_extensions.json");
  await Deno.writeTextFile(lockfilePath, "{}");
  const targetType = `@test/wrapped-${crypto.randomUUID().slice(0, 8)}`;
  const extPath = join(modelsDir, "wrapped_ext.ts");
  await Deno.writeTextFile(extPath, WRAPPED_EXTENSION(targetType, decoy));

  const catalog = new ExtensionCatalogStore(
    join(repoDir, ".swamp", "_extension_catalog.db"),
  );
  const lockfileRepository = await LockfileRepository.create(lockfilePath);
  const repository = new ExtensionRepository({
    catalog,
    lockfileRepository,
    repoRoot: repoDir,
  });
  resetExtensionLoadWarnings();
  try {
    await fn({
      repoDir,
      modelsDir,
      extPath,
      catalog,
      repository,
      lockfileRepository,
    });
  } finally {
    resetExtensionLoadWarnings();
    catalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

function extractionWarningsFor(path: string) {
  return getExtensionLoadWarnings().filter((w) =>
    w.category === "TypeExtractionFailed" && w.file === path
  );
}

for (const decoy of [false, true]) {
  Deno.test(`cold buildIndex keeps a reconcile-indexed wrapped export without warning (decoy literal: ${decoy})`, async () => {
    await withRepo(decoy, async (repo) => {
      await new ReconcileFromDiskService({
        denoRuntime: testDenoRuntime,
        repository: repo.repository,
        lockfileRepository: repo.lockfileRepository,
        repoDir: repo.repoDir,
      }).execute();
      const indexed = repo.catalog.findBySourcePath(repo.extPath);
      assertEquals(indexed?.kind, "extension");
      const targetType = indexed!.extends_type;

      const loader = new ExtensionLoader(
        testDenoRuntime,
        modelKindAdapter,
        repo.repoDir,
        undefined,
        repo.repository,
      );
      await loader.buildIndex(repo.modelsDir, { indexOnly: true });

      assertEquals(extractionWarningsFor(repo.extPath), []);
      const after = repo.catalog.findBySourcePath(repo.extPath);
      assertEquals(after?.type_normalized, targetType);
      assertEquals(after?.extends_type, targetType);
    });
  });
}

Deno.test("cold buildIndex does not warn for a wrapped export whose indexed row is stale", async () => {
  await withRepo(false, async (repo) => {
    await new ReconcileFromDiskService({
      denoRuntime: testDenoRuntime,
      repository: repo.repository,
      lockfileRepository: repo.lockfileRepository,
      repoDir: repo.repoDir,
    }).execute();
    const targetType = repo.catalog.findBySourcePath(repo.extPath)!
      .extends_type;
    // Edit the source after it was indexed: the row's fingerprint no longer
    // matches, but the stale-file scan re-imports it on the next load.
    await Deno.writeTextFile(
      repo.extPath,
      (await Deno.readTextFile(repo.extPath)) + "\n// edited\n",
    );

    const loader = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repo.repoDir,
      undefined,
      repo.repository,
    );
    await loader.buildIndex(repo.modelsDir, { indexOnly: true });

    assertEquals(extractionWarningsFor(repo.extPath), []);
    assertEquals(
      repo.catalog.findBySourcePath(repo.extPath)?.extends_type,
      targetType,
    );
  });
});

Deno.test("cold buildIndex refreshes a moved bundle path while keeping the import-indexed type", async () => {
  await withRepo(true, async (repo) => {
    await new ReconcileFromDiskService({
      denoRuntime: testDenoRuntime,
      repository: repo.repository,
      lockfileRepository: repo.lockfileRepository,
      repoDir: repo.repoDir,
    }).execute();
    const indexed = repo.catalog.findBySourcePath(repo.extPath)!;
    // As after a bundle layout or datastore change: same source, the row
    // still names the old bundle location.
    repo.catalog.upsert({ ...indexed, bundle_path: "/old/location/ext.js" });

    const loader = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repo.repoDir,
      undefined,
      repo.repository,
    );
    await loader.buildIndex(repo.modelsDir, { indexOnly: true });

    const after = repo.catalog.findBySourcePath(repo.extPath)!;
    assertEquals(after.bundle_path === "/old/location/ext.js", false);
    assertEquals((await Deno.stat(after.bundle_path)).isFile, true);
    assertEquals(after.extends_type, indexed.extends_type);
    assertEquals(extractionWarningsFor(repo.extPath), []);
  });
});

Deno.test("cold buildIndex still warns for a wrapped export nothing has indexed", async () => {
  await withRepo(false, async ({ repoDir, modelsDir, extPath, repository }) => {
    const loader = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository,
    );
    await loader.buildIndex(modelsDir, { indexOnly: true });

    const warnings = extractionWarningsFor(extPath);
    assertEquals(warnings.length, 1);
    assertEquals(
      warnings[0].error.includes("indexed from its bundle on the next load"),
      true,
    );
  });
});
