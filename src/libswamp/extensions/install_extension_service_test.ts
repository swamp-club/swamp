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
import { FaultingStubRepository } from "../../infrastructure/persistence/test_helpers/faulting_stub_repository.ts";
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
    binaries: [],
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

// =============================================================
// Catalog source_path absolute-form regression
// =============================================================
//
// Phase 8 must write the catalog's `source_path` column as the absolute
// canonical path so that the legacy `populateCatalogFromDir` bootstrap
// (in `user_*_loader.ts`) — which uses absolute paths from a filesystem
// walk — UPSERTs onto the same row instead of inserting a duplicate
// empty-identity row at the absolute form.
//
// Pre-fix symptom: a brand-new repo + `extension pull` + any subsequent
// model command produced two rows per source file (one relative,
// identity-populated; one absolute, identity-empty). The empty-
// identity rows triggered cosmetic "Dropping orphan row" warnings on
// the next `loadByName` because the lockfile-fallback couldn't match
// them when the user passed `repoDir` as a relative path.
Deno.test(
  "InstallExtensionService.execute: catalog source_path is absolute (legacy populateCatalogFromDir compat)",
  async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, catalog, lockfileRepository }) => {
        const ts = Date.now();
        const extName = `@test/abs-path-${ts}`;
        const typeId = `@test/abs-path-model-${ts}`;
        await stageModel(
          repoDir,
          extName,
          "noop.ts",
          MINIMAL_MODEL_CODE(typeId),
        );

        const service = new InstallExtensionService({
          denoRuntime: testDenoRuntime,
          repository,
          installExtensionFn: async (ref, ctx) => {
            await ctx.lockfileRepository.writeEntry(
              ref.name,
              "1.0.0",
              [`.swamp/pulled-extensions/${ref.name}/models/noop.ts`],
            );
            return makeStubInstallResult(ref.name, "1.0.0", [
              `.swamp/pulled-extensions/${ref.name}/models/noop.ts`,
            ]);
          },
        });

        await service.execute(
          { name: extName, version: "1.0.0" } as ExtensionRef,
          makeInstallContext(repoDir, lockfileRepository),
        );

        // The row's source_path must be absolute (start with `/` on
        // POSIX, or contain a drive letter on Windows). Relative paths
        // would leave the legacy loader's UPSERT key-mismatched and
        // create duplicate empty-identity rows.
        const rows = catalog.findAll().filter((r) =>
          r.extension_name === extName
        );
        assertEquals(rows.length, 1);
        const sourcePath = rows[0].source_path;
        const isAbsolute = Deno.build.os === "windows"
          ? /^[a-zA-Z]:[\\/]/.test(sourcePath)
          : sourcePath.startsWith("/");
        assertEquals(
          isAbsolute,
          true,
          `source_path must be absolute, got: ${sourcePath}`,
        );
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

// =============================================================
// Crash-state recovery (W2 plan v4 step 10)
// =============================================================
//
// Generic non-`DuplicateTypeError` failures inside `repository.saveAll`
// (process kill, SQLite I/O error, OOM, etc.) must leave the catalog
// in its pre-save state so a retry succeeds. This pins the SQLite
// transaction-rollback contract that the lifecycle service depends on.
// FS + lockfile are NOT auto-rolled-back for generic errors — that's a
// known and intentional behavior (only DuplicateTypeError triggers FS
// rollback, because the user is provably going to want the prior state
// restored). The retry resolves the FS+lockfile-vs-catalog drift via
// the diff-save in saveAll.

Deno.test(
  "InstallExtensionService.execute: catalog saveAll fault leaves catalog clean and retry succeeds",
  async () => {
    await withFixtureRepo(
      async ({ repoDir, catalog, lockfileRepository }) => {
        const ts = Date.now();
        const extName = `@test/crash-install-${ts}`;
        const typeId = `@test/crash-install-model-${ts}`;
        await stageModel(
          repoDir,
          extName,
          "noop.ts",
          MINIMAL_MODEL_CODE(typeId),
        );

        const faultingRepo = new FaultingStubRepository({
          catalog,
          lockfileRepository,
          repoRoot: repoDir,
        });
        faultingRepo.injectSaveAllFault(
          new Error("simulated SQLite I/O fault"),
        );

        const service = new InstallExtensionService({
          denoRuntime: testDenoRuntime,
          repository: faultingRepo,
          installExtensionFn: async (ref, ctx) => {
            await ctx.lockfileRepository.writeEntry(
              ref.name,
              ref.version ?? "1.0.0",
              [`.swamp/pulled-extensions/${ref.name}/models/noop.ts`],
            );
            return makeStubInstallResult(ref.name, ref.version ?? "1.0.0", [
              `.swamp/pulled-extensions/${ref.name}/models/noop.ts`,
            ]);
          },
        });

        // First attempt: faults inside saveAll. The lifecycle service
        // wraps the underlying error in a UserError with the pinned
        // half-state recovery message so log-mode shows clean guidance
        // and `--json` consumers see the recovery hint in `error`.
        const thrown = await assertRejects(
          () =>
            service.execute(
              { name: extName, version: "1.0.0" } as ExtensionRef,
              makeInstallContext(repoDir, lockfileRepository),
            ),
          UserError,
          "Install partially applied",
        );
        // The pinned message names the extension and the recovery action.
        if (!(thrown.message.includes(extName))) {
          throw new Error(
            `expected message to name extension ${extName}, got: ${thrown.message}`,
          );
        }
        if (!(thrown.message.includes("swamp doctor extensions"))) {
          throw new Error(
            `expected message to mention \`swamp doctor extensions\`, got: ${thrown.message}`,
          );
        }
        // The underlying fault message is preserved for diagnostics.
        if (!(thrown.message.includes("simulated SQLite I/O fault"))) {
          throw new Error(
            `expected message to include underlying fault, got: ${thrown.message}`,
          );
        }

        // Catalog state: SQLite txn rolled back, no rows survive.
        assertEquals(faultingRepo.loadByName(extName).length, 0);
        assertEquals(catalog.findAll().length, 0);
        // Lockfile + FS state: the install service does NOT roll these
        // back for generic errors. Both still hold the partial install.
        assertEquals(
          lockfileRepository.getEntry(extName)?.version,
          "1.0.0",
        );

        // Second attempt: no fault scheduled. The diff-save in saveAll
        // reconciles the catalog against the (still-on-disk) FS+lockfile
        // state, so the retry succeeds and the catalog now matches.
        const retry = await service.execute(
          { name: extName, version: "1.0.0" } as ExtensionRef,
          makeInstallContext(repoDir, lockfileRepository),
        );
        assertEquals(retry?.name, extName);
        assertEquals(faultingRepo.loadByName(extName).length, 1);
      },
    );
  },
);
