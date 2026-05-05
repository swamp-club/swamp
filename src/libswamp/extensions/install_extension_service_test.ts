// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { InstallExtensionService } from "./install_extension_service.ts";
import type { ExtensionRef, InstallContext, InstallResult } from "./pull.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import { UserError } from "../../domain/errors.ts";
import type { DenoRuntime } from "../../domain/runtime/deno_runtime.ts";

// Required so the model loader's test bootstrap finds command/shell
// (preserved from the loader test files' pattern).
import "../../domain/models/models.ts";

const testDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
};

/**
 * Helpers for building a self-contained on-disk fixture that the
 * service can walk in phase 8. Avoids needing a real tarball / network
 * round-trip.
 */
async function withFixtureRepo(
  fn: (args: {
    repoDir: string;
    repository: ExtensionRepository;
    catalog: ExtensionCatalogStore;
    lockfileRepository: LockfileRepository;
  }) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_iesvc_test_" });
  await ensureDir(join(repoDir, ".swamp"));
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");
  const lockfilePath = join(
    repoDir,
    "extensions",
    "models",
    "upstream_extensions.json",
  );
  await ensureDir(join(repoDir, "extensions", "models"));
  await Deno.writeTextFile(lockfilePath, "{}");

  const catalog = new ExtensionCatalogStore(dbPath);
  const lockfileRepository = await LockfileRepository.create(lockfilePath);
  const repository = new ExtensionRepository({
    catalog,
    lockfileRepository,
    repoRoot: repoDir,
  });

  try {
    await fn({ repoDir, repository, catalog, lockfileRepository });
  } finally {
    catalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

/** Stages a model file at .swamp/pulled-extensions/<name>/models/<file> */
async function stageModel(
  repoDir: string,
  extName: string,
  fileName: string,
  modelCode: string,
): Promise<string> {
  const modelsDir = join(
    swampPath(repoDir, "pulled-extensions"),
    extName,
    "models",
  );
  await ensureDir(modelsDir);
  const path = join(modelsDir, fileName);
  await Deno.writeTextFile(path, modelCode);
  return path;
}

/** Builds an InstallResult that points at staged on-disk files. */
function makeStubInstallResult(
  extName: string,
  version: string,
  files: string[],
): InstallResult {
  return {
    name: extName,
    version,
    description: undefined,
    extractedFiles: files,
    integrityStatus: "verified",
    repository: undefined,
    platforms: [],
    safetyWarnings: [],
    conflicts: [],
    missingSourceFiles: [],
    hasSkills: false,
    hasSkillScripts: false,
    skillFiles: [],
    dependencyResults: [],
    pruned: [],
  };
}

function makeInstallContext(
  repoDir: string,
  lockfileRepository: LockfileRepository,
): InstallContext {
  return {
    getExtension: () => Promise.reject(new Error("stub")),
    downloadArchive: () => Promise.reject(new Error("stub")),
    getChecksum: () => Promise.resolve(null),
    lockfileRepository,
    skillsDir: join(repoDir, ".claude", "skills"),
    repoDir,
    force: false,
    alreadyPulled: new Set(),
    depth: 0,
  };
}

const MINIMAL_MODEL_CODE = (typeId: string) => `
import { z } from "npm:zod@4";

export const model = {
  type: "${typeId}",
  version: "2026.05.05.1",
  globalArguments: z.object({}),
  resources: {
    "data": {
      description: "x",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 1,
    },
  },
  methods: {
    noop: {
      description: "noop",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

Deno.test(
  "InstallExtensionService.execute: phase 8 populates the catalog with Indexed Sources",
  async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, catalog, lockfileRepository }) => {
        const ts = Date.now();
        const extName = `@test/svc-success-${ts}`;
        const typeId = `@test/svc-model-${ts}`;
        const filePath = await stageModel(
          repoDir,
          extName,
          "noop.ts",
          MINIMAL_MODEL_CODE(typeId),
        );

        // Pre-condition: catalog empty, no Extension known.
        assertEquals(catalog.findAll().length, 0);
        assertEquals(repository.loadByName(extName).length, 0);

        const service = new InstallExtensionService({
          denoRuntime: testDenoRuntime,
          repository,
          installExtensionFn: () =>
            Promise.resolve(
              makeStubInstallResult(extName, "1.0.0", [
                `.swamp/pulled-extensions/${extName}/models/noop.ts`,
              ]),
            ),
        });
        const ctx = makeInstallContext(repoDir, lockfileRepository);

        const result = await service.execute(
          { name: extName, version: "1.0.0" } as ExtensionRef,
          ctx,
        );

        // Returned result is the InstallResult unchanged (FS+lockfile
        // already done by the stubbed installExtension).
        assertEquals(result?.name, extName);
        assertEquals(result?.version, "1.0.0");

        // Phase 8 wrote a row for the model: catalog non-empty, the
        // Extension aggregate loads, and its Source has the type populated.
        const extensions = repository.loadByName(extName);
        assertEquals(extensions.length, 1);
        const ext = extensions[0];
        assertEquals(ext.sources.size, 1);
        const source = ext.sources.values().next().value!;
        assertEquals(source.kind, "model");
        assertEquals(
          source.state.tag,
          "Indexed",
          "Pin 1: source must land in Indexed state with type populated",
        );
        if (source.state.tag === "Indexed") {
          assertEquals(source.state.type, typeId.toLowerCase());
        }
        assertEquals(source.id.canonicalPath.endsWith("/noop.ts"), true);
        void filePath;
      },
    );
  },
);

Deno.test(
  "InstallExtensionService.execute: DuplicateTypeError triggers FS rollback and surfaces as UserError",
  async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, lockfileRepository }) => {
        const ts = Date.now();
        const typeId = `@test/svc-collide-${ts}`;
        const extA = `@test/collide-a-${ts}`;
        const extB = `@test/collide-b-${ts}`;

        // Stage and install A first via service.
        await stageModel(repoDir, extA, "model.ts", MINIMAL_MODEL_CODE(typeId));
        await lockfileRepository.writeEntry(extA, "1.0.0", [
          `.swamp/pulled-extensions/${extA}/models/model.ts`,
        ]);
        const serviceA = new InstallExtensionService({
          denoRuntime: testDenoRuntime,
          repository,
          installExtensionFn: () =>
            Promise.resolve(
              makeStubInstallResult(extA, "1.0.0", [
                `.swamp/pulled-extensions/${extA}/models/model.ts`,
              ]),
            ),
        });
        await serviceA.execute(
          { name: extA, version: "1.0.0" } as ExtensionRef,
          makeInstallContext(repoDir, lockfileRepository),
        );
        assertEquals(repository.loadByName(extA).length, 1);

        // Stage B which claims the SAME type. Phase 8 must detect the
        // collision via I-Repo-1 and roll back.
        const bModelPath = await stageModel(
          repoDir,
          extB,
          "model.ts",
          MINIMAL_MODEL_CODE(typeId),
        );
        const bExtractedFiles = [
          `.swamp/pulled-extensions/${extB}/models/model.ts`,
        ];

        const serviceB = new InstallExtensionService({
          denoRuntime: testDenoRuntime,
          repository,
          installExtensionFn: () =>
            Promise.resolve(
              makeStubInstallResult(extB, "1.0.0", bExtractedFiles),
            ),
        });

        await assertRejects(
          () =>
            serviceB.execute(
              { name: extB, version: "1.0.0" } as ExtensionRef,
              makeInstallContext(repoDir, lockfileRepository),
            ),
          UserError,
          "Cannot install",
        );

        // FS rollback: B's staged file is gone.
        let bStillExists = true;
        try {
          await Deno.stat(bModelPath);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) bStillExists = false;
          else throw error;
        }
        assertEquals(
          bStillExists,
          false,
          "FS rollback must delete files staged by the failed install",
        );

        // Lockfile rollback: B's entry was never persisted (or was
        // rolled back). A's entry remains.
        const fresh = await LockfileRepository.create(
          lockfileRepository.lockfilePath,
        );
        assertEquals(fresh.getEntry(extB), null);
        assertEquals(fresh.getEntry(extA)?.version, "1.0.0");

        // Catalog rollback (via SQLite ROLLBACK inside saveAll): A's row
        // is preserved, B's never landed.
        assertEquals(repository.loadByName(extA).length, 1);
        assertEquals(repository.loadByName(extB).length, 0);
      },
    );
  },
);
