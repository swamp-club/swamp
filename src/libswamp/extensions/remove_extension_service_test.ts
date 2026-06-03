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
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { RemoveExtensionService } from "./remove_extension_service.ts";
import { InstallExtensionService } from "./install_extension_service.ts";
import type { InstallContext, InstallResult } from "./pull.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import { FaultingStubRepository } from "../../infrastructure/persistence/test_helpers/faulting_stub_repository.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import {
  bundleNamespace,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { UserError } from "../../domain/errors.ts";
import type { DenoRuntime } from "../../domain/runtime/deno_runtime.ts";

import "../../domain/models/models.ts";

const testDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
};

async function withFixtureRepo(
  fn: (args: {
    repoDir: string;
    repository: ExtensionRepository;
    catalog: ExtensionCatalogStore;
    lockfileRepository: LockfileRepository;
  }) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_resvc_test_" });
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

// =============================================================
// swamp-club#201 lifecycle-layer reproducer
// =============================================================
//
// Pre-W2 behaviour: `extension rm` deleted files + lockfile entry but
// did NOT touch the catalog. Stale `(kind, type)` rows survived
// removal — they only got pruned later when a NEXT install happened
// to overwrite them. Visible symptom: `swamp model type search` still
// returned the type after rm; `swamp doctor extensions` reported the
// orphan rows.
//
// W2 contract: after rm, the catalog has zero rows for that
// extension's name. This test pins it.

Deno.test(
  "swamp-club#201: rm via service prunes catalog rows (lifecycle-layer reproducer)",
  async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, lockfileRepository }) => {
        const ts = Date.now();
        const extName = `@test/issue201-${ts}`;
        const typeId = `@test/issue201-model-${ts}`;
        await stageModel(
          repoDir,
          extName,
          "model.ts",
          MINIMAL_MODEL_CODE(typeId),
        );

        // Install via InstallExtensionService — populates catalog +
        // lockfile.
        const installSvc = new InstallExtensionService({
          denoRuntime: testDenoRuntime,
          repository,
          installExtensionFn: async (ref, ctx) => {
            await ctx.lockfileRepository.writeEntry(
              ref.name,
              "1.0.0",
              [`.swamp/pulled-extensions/${ref.name}/models/model.ts`],
            );
            return makeStubInstallResult(ref.name, "1.0.0", [
              `.swamp/pulled-extensions/${ref.name}/models/model.ts`,
            ]);
          },
        });
        await installSvc.execute(
          { name: extName, version: "1.0.0" },
          makeInstallContext(repoDir, lockfileRepository),
        );

        // Pre-condition: catalog HAS rows for this extension; lockfile
        // HAS the entry. This is the user-visible state W1b ships
        // before W2 lands.
        assertEquals(
          repository.loadByName(extName).length,
          1,
          "Pre-rm: catalog must have a row for the extension",
        );
        assertEquals(
          lockfileRepository.getEntry(extName)?.version,
          "1.0.0",
          "Pre-rm: lockfile must have the entry",
        );

        // Remove via service.
        const removeSvc = new RemoveExtensionService({
          repository,
          lockfileRepository,
          repoDir,
        });
        const result = await removeSvc.execute(extName);

        // The bug-closing assertions for swamp-club#201:
        assertEquals(
          repository.loadByName(extName).length,
          0,
          "swamp-club#201: catalog must be empty for this extension after rm",
        );
        assertEquals(
          lockfileRepository.getEntry(extName),
          null,
          "Post-rm: lockfile entry must be gone",
        );
        assertEquals(result.name, extName);
        assertEquals(result.version, "1.0.0");
        assertEquals(
          result.filesDeleted >= 1,
          true,
          "Post-rm: tracked files were deleted",
        );
      },
    );
  },
);

// =============================================================
// Idempotency contract (plan v4 challenge #9)
// =============================================================

Deno.test(
  "RemoveExtensionService.execute: double-rm yields a clean UserError on the second call",
  async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, lockfileRepository }) => {
        const ts = Date.now();
        const extName = `@test/double-rm-${ts}`;
        const typeId = `@test/double-rm-model-${ts}`;
        await stageModel(
          repoDir,
          extName,
          "model.ts",
          MINIMAL_MODEL_CODE(typeId),
        );

        const installSvc = new InstallExtensionService({
          denoRuntime: testDenoRuntime,
          repository,
          installExtensionFn: async (ref, ctx) => {
            await ctx.lockfileRepository.writeEntry(
              ref.name,
              "1.0.0",
              [`.swamp/pulled-extensions/${ref.name}/models/model.ts`],
            );
            return makeStubInstallResult(ref.name, "1.0.0", [
              `.swamp/pulled-extensions/${ref.name}/models/model.ts`,
            ]);
          },
        });
        await installSvc.execute(
          { name: extName, version: "1.0.0" },
          makeInstallContext(repoDir, lockfileRepository),
        );

        const removeSvc = new RemoveExtensionService({
          repository,
          lockfileRepository,
          repoDir,
        });

        // First rm succeeds.
        await removeSvc.execute(extName);

        // Second rm errors with a clean message — neither silent
        // success nor an ambiguous error.
        await assertRejects(
          () => removeSvc.execute(extName),
          UserError,
          "is not installed",
        );
      },
    );
  },
);

// =============================================================
// rm-of-never-installed extension throws clean UserError
// =============================================================

Deno.test(
  "RemoveExtensionService.execute: rm of never-installed extension throws UserError",
  async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, lockfileRepository }) => {
        const removeSvc = new RemoveExtensionService({
          repository,
          lockfileRepository,
          repoDir,
        });

        await assertRejects(
          () => removeSvc.execute("@test/never-installed"),
          UserError,
          "is not installed",
        );
      },
    );
  },
);

// =============================================================
// rm preserves other installed extensions
// =============================================================

Deno.test(
  "RemoveExtensionService.execute: rm of one extension does not touch others",
  async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, lockfileRepository }) => {
        const ts = Date.now();
        const extA = `@test/preserve-a-${ts}`;
        const extB = `@test/preserve-b-${ts}`;
        const typeA = `@test/preserve-type-a-${ts}`;
        const typeB = `@test/preserve-type-b-${ts}`;

        await stageModel(repoDir, extA, "a.ts", MINIMAL_MODEL_CODE(typeA));
        await stageModel(repoDir, extB, "b.ts", MINIMAL_MODEL_CODE(typeB));

        const installSvc = new InstallExtensionService({
          denoRuntime: testDenoRuntime,
          repository,
          installExtensionFn: async (ref, ctx) => {
            const fileName = ref.name === extA ? "a.ts" : "b.ts";
            await ctx.lockfileRepository.writeEntry(
              ref.name,
              "1.0.0",
              [`.swamp/pulled-extensions/${ref.name}/models/${fileName}`],
            );
            return makeStubInstallResult(ref.name, "1.0.0", [
              `.swamp/pulled-extensions/${ref.name}/models/${fileName}`,
            ]);
          },
        });
        await installSvc.execute(
          { name: extA, version: "1.0.0" },
          makeInstallContext(repoDir, lockfileRepository),
        );
        await installSvc.execute(
          { name: extB, version: "1.0.0" },
          makeInstallContext(repoDir, lockfileRepository),
        );
        assertEquals(repository.loadByName(extA).length, 1);
        assertEquals(repository.loadByName(extB).length, 1);

        const removeSvc = new RemoveExtensionService({
          repository,
          lockfileRepository,
          repoDir,
        });
        await removeSvc.execute(extA);

        // Only A is gone; B is intact.
        assertEquals(repository.loadByName(extA).length, 0);
        assertEquals(lockfileRepository.getEntry(extA), null);
        assertEquals(repository.loadByName(extB).length, 1);
        assertEquals(lockfileRepository.getEntry(extB)?.version, "1.0.0");
      },
    );
  },
);

// =============================================================
// Crash-state recovery (W2 plan v4 step 10)
// =============================================================
//
// Order: catalog tombstone-save → lockfile remove → FS delete. A fault
// inside the catalog `saveAll` (the very FIRST mutation of rm) must
// roll back via SQLite ROLLBACK so retry sees the extension still
// installed. Lockfile + FS are not yet touched, so the retry is a
// clean re-rm.

Deno.test(
  "RemoveExtensionService.execute: catalog saveAll fault leaves install state unchanged and retry succeeds",
  async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, catalog, lockfileRepository }) => {
        const ts = Date.now();
        const extName = `@test/crash-rm-${ts}`;
        const typeId = `@test/crash-rm-model-${ts}`;
        await stageModel(
          repoDir,
          extName,
          "model.ts",
          MINIMAL_MODEL_CODE(typeId),
        );

        // Install first via the real repository so the on-disk +
        // lockfile + catalog state is real.
        const installSvc = new InstallExtensionService({
          denoRuntime: testDenoRuntime,
          repository,
          installExtensionFn: async (ref, ctx) => {
            await ctx.lockfileRepository.writeEntry(
              ref.name,
              "1.0.0",
              [`.swamp/pulled-extensions/${ref.name}/models/model.ts`],
            );
            return makeStubInstallResult(
              ref.name,
              "1.0.0",
              [`.swamp/pulled-extensions/${ref.name}/models/model.ts`],
            );
          },
        });
        await installSvc.execute(
          { name: extName, version: "1.0.0" },
          makeInstallContext(repoDir, lockfileRepository),
        );

        // Pre-fault snapshot.
        const preFaultRows = catalog.findAll().length;
        assertEquals(repository.loadByName(extName).length, 1);
        assertEquals(lockfileRepository.getEntry(extName)?.version, "1.0.0");

        // Wrap the same catalog in a faulting repo for the rm path.
        const faultingRepo = new FaultingStubRepository({
          catalog,
          lockfileRepository,
          repoRoot: repoDir,
        });
        faultingRepo.injectSaveAllFault(
          new Error("simulated SQLite I/O fault during rm"),
        );

        const removeSvc = new RemoveExtensionService({
          repository: faultingRepo,
          lockfileRepository,
          repoDir,
        });

        // First attempt: faults inside the tombstone saveAll. SQLite
        // ROLLBACK preserves all rows; lockfile + FS untouched. The
        // lifecycle service surfaces the failure as a UserError with a
        // clean retry hint instead of a raw stack trace.
        const thrown = await assertRejects(
          () => removeSvc.execute(extName),
          UserError,
          "Remove failed",
        );
        if (!(thrown.message.includes(extName))) {
          throw new Error(
            `expected message to name extension ${extName}, got: ${thrown.message}`,
          );
        }
        if (!(thrown.message.includes("Retry"))) {
          throw new Error(
            `expected message to suggest retry, got: ${thrown.message}`,
          );
        }
        if (
          !(thrown.message.includes("simulated SQLite I/O fault during rm"))
        ) {
          throw new Error(
            `expected message to include underlying fault, got: ${thrown.message}`,
          );
        }
        assertEquals(catalog.findAll().length, preFaultRows);
        assertEquals(repository.loadByName(extName).length, 1);
        assertEquals(lockfileRepository.getEntry(extName)?.version, "1.0.0");

        // Second attempt: no fault. Clean rm; everything cleared.
        await removeSvc.execute(extName);
        assertEquals(repository.loadByName(extName).length, 0);
        assertEquals(lockfileRepository.getEntry(extName), null);
      },
    );
  },
);

// =============================================================
// swamp-club#383: empty per-extension scaffold dirs left behind
// =============================================================
//
// `pull` unconditionally `Deno.mkdir`s seven per-extension scaffold
// dirs (`models`, `workflows`, `vaults`, `drivers`, `datastores`,
// `reports`, `files`) regardless of whether the extension ships
// content for that kind. These dirs are never recorded in the
// lockfile's tracked-file list. Pre-fix, `pruneEmptyDirs`'s upward
// walk from tracked-file parents stopped at the extension root
// because the un-tracked scaffolds made it appear non-empty —
// leaving the entire per-extension subtree on disk after rm.
//
// The fix has RemoveExtensionService push the seven scaffold paths
// into parentDirs so pruneEmptyDirs sweeps them too. These tests
// pin (a) the canonical case, (b) sibling-extension safety, and
// (c) flat (non-scoped) name handling.
//
// Tests intentionally hardcode the seven scaffold names rather than
// importing PER_EXTENSION_SCAFFOLD_DIRS from production — a silent
// shrinkage of that constant must show up as a regression here.

async function stageScaffoldDirs(extRoot: string): Promise<void> {
  for (
    const kind of [
      "models",
      "workflows",
      "vaults",
      "drivers",
      "datastores",
      "reports",
      "files",
    ]
  ) {
    await ensureDir(join(extRoot, kind));
  }
}

Deno.test(
  "swamp-club#383: rm prunes empty per-extension scaffold dirs (canonical)",
  async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, lockfileRepository }) => {
        const ts = Date.now();
        const extName = `@test/scaffold-${ts}`;
        const typeId = `@test/scaffold-model-${ts}`;
        await stageModel(
          repoDir,
          extName,
          "model.ts",
          MINIMAL_MODEL_CODE(typeId),
        );
        const extRoot = join(
          swampPath(repoDir, "pulled-extensions"),
          extName,
        );
        await stageScaffoldDirs(extRoot);

        const installSvc = new InstallExtensionService({
          denoRuntime: testDenoRuntime,
          repository,
          installExtensionFn: async (ref, ctx) => {
            await ctx.lockfileRepository.writeEntry(
              ref.name,
              "1.0.0",
              [`.swamp/pulled-extensions/${ref.name}/models/model.ts`],
            );
            return makeStubInstallResult(ref.name, "1.0.0", [
              `.swamp/pulled-extensions/${ref.name}/models/model.ts`,
            ]);
          },
        });
        await installSvc.execute(
          { name: extName, version: "1.0.0" },
          makeInstallContext(repoDir, lockfileRepository),
        );

        const removeSvc = new RemoveExtensionService({
          repository,
          lockfileRepository,
          repoDir,
        });
        await removeSvc.execute(extName);

        // The per-extension subtree must be entirely gone — neither
        // the extension root nor any of the empty scaffold dirs may
        // remain.
        await assertRejects(
          () => Deno.stat(extRoot),
          Deno.errors.NotFound,
          undefined,
          "Post-rm: per-extension subtree must be removed",
        );
        // The `@scope/` dir is also gone since this fixture has no
        // sibling extensions under `@test/`.
        const scopeDir = join(
          swampPath(repoDir, "pulled-extensions"),
          "@test",
        );
        await assertRejects(
          () => Deno.stat(scopeDir),
          Deno.errors.NotFound,
          undefined,
          "Post-rm: empty scope dir must be removed",
        );
      },
    );
  },
);

Deno.test(
  "swamp-club#383: rm preserves sibling extension under the same @scope",
  async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, lockfileRepository }) => {
        const ts = Date.now();
        const extA = `@test/sibling-a-${ts}`;
        const extB = `@test/sibling-b-${ts}`;
        const typeA = `@test/sibling-type-a-${ts}`;
        const typeB = `@test/sibling-type-b-${ts}`;
        await stageModel(repoDir, extA, "a.ts", MINIMAL_MODEL_CODE(typeA));
        await stageModel(repoDir, extB, "b.ts", MINIMAL_MODEL_CODE(typeB));
        const extRootA = join(
          swampPath(repoDir, "pulled-extensions"),
          extA,
        );
        const extRootB = join(
          swampPath(repoDir, "pulled-extensions"),
          extB,
        );
        await stageScaffoldDirs(extRootA);
        await stageScaffoldDirs(extRootB);

        const installSvc = new InstallExtensionService({
          denoRuntime: testDenoRuntime,
          repository,
          installExtensionFn: async (ref, ctx) => {
            const fileName = ref.name === extA ? "a.ts" : "b.ts";
            await ctx.lockfileRepository.writeEntry(
              ref.name,
              "1.0.0",
              [`.swamp/pulled-extensions/${ref.name}/models/${fileName}`],
            );
            return makeStubInstallResult(ref.name, "1.0.0", [
              `.swamp/pulled-extensions/${ref.name}/models/${fileName}`,
            ]);
          },
        });
        await installSvc.execute(
          { name: extA, version: "1.0.0" },
          makeInstallContext(repoDir, lockfileRepository),
        );
        await installSvc.execute(
          { name: extB, version: "1.0.0" },
          makeInstallContext(repoDir, lockfileRepository),
        );

        const removeSvc = new RemoveExtensionService({
          repository,
          lockfileRepository,
          repoDir,
        });
        await removeSvc.execute(extA);

        // A is gone — both subtree and scaffolds.
        await assertRejects(
          () => Deno.stat(extRootA),
          Deno.errors.NotFound,
          undefined,
          "Post-rm: extA subtree must be removed",
        );
        // B is intact — including its scaffold dirs and its tracked
        // model file.
        const bStat = await Deno.stat(extRootB);
        assertEquals(
          bStat.isDirectory,
          true,
          "Post-rm: extB subtree must be preserved",
        );
        const bModelStat = await Deno.stat(
          join(extRootB, "models", "b.ts"),
        );
        assertEquals(
          bModelStat.isFile,
          true,
          "Post-rm: extB tracked file must be preserved",
        );
        // The shared `@test/` scope dir is also preserved because B
        // still lives inside it.
        const scopeStat = await Deno.stat(
          join(swampPath(repoDir, "pulled-extensions"), "@test"),
        );
        assertEquals(
          scopeStat.isDirectory,
          true,
          "Post-rm: shared @scope dir must be preserved",
        );
      },
    );
  },
);

Deno.test(
  "swamp-club#383: rm prunes scaffold dirs for flat (non-scoped) extension names",
  async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, lockfileRepository }) => {
        const ts = Date.now();
        const extName = `flat-scaffold-${ts}`;
        const typeId = `flat-scaffold-model-${ts}`;
        await stageModel(
          repoDir,
          extName,
          "model.ts",
          MINIMAL_MODEL_CODE(typeId),
        );
        const extRoot = join(
          swampPath(repoDir, "pulled-extensions"),
          extName,
        );
        await stageScaffoldDirs(extRoot);

        const installSvc = new InstallExtensionService({
          denoRuntime: testDenoRuntime,
          repository,
          installExtensionFn: async (ref, ctx) => {
            await ctx.lockfileRepository.writeEntry(
              ref.name,
              "1.0.0",
              [`.swamp/pulled-extensions/${ref.name}/models/model.ts`],
            );
            return makeStubInstallResult(ref.name, "1.0.0", [
              `.swamp/pulled-extensions/${ref.name}/models/model.ts`,
            ]);
          },
        });
        await installSvc.execute(
          { name: extName, version: "1.0.0" },
          makeInstallContext(repoDir, lockfileRepository),
        );

        const removeSvc = new RemoveExtensionService({
          repository,
          lockfileRepository,
          repoDir,
        });
        await removeSvc.execute(extName);

        await assertRejects(
          () => Deno.stat(extRoot),
          Deno.errors.NotFound,
          undefined,
          "Post-rm: flat-name subtree must be removed",
        );
      },
    );
  },
);

// =============================================================
// swamp-club#392: empty <kind>-bundles/<hash>/ dirs left behind
// =============================================================
//
// `pull` unconditionally `Deno.mkdir`s five bundle namespace dirs
// (`bundles/<hash>/`, `vault-bundles/<hash>/`, `driver-bundles/<hash>/`,
// `datastore-bundles/<hash>/`, `report-bundles/<hash>/`) regardless of
// whether the extension ships content for that bundle kind. When the
// source archive has no bundles for a kind, `copyDir` returns an empty
// file list and nothing is tracked. `RemoveExtensionService` must push
// these bundle namespace paths into `parentDirs` so `pruneEmptyDirs`
// sweeps them.
//
// Tests intentionally hardcode the five (sourceKind, bundleKind) pairs
// rather than importing from production — a silent change to the
// mapping must show up as a regression here.

const BUNDLE_MAPPINGS: ReadonlyArray<[string, string]> = [
  ["models", "bundles"],
  ["vaults", "vault-bundles"],
  ["drivers", "driver-bundles"],
  ["datastores", "datastore-bundles"],
  ["reports", "report-bundles"],
];

async function stageBundleNamespaceDirs(
  repoDir: string,
  extName: string,
): Promise<void> {
  const extensionRoot = join(
    swampPath(repoDir, "pulled-extensions"),
    extName,
  );
  for (const [sourceKind, bundleKind] of BUNDLE_MAPPINGS) {
    const hash = bundleNamespace(
      join(extensionRoot, sourceKind),
      repoDir,
    );
    await ensureDir(join(swampPath(repoDir, bundleKind), hash));
  }
}

Deno.test(
  "swamp-club#392: rm prunes empty bundle namespace dirs",
  async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, lockfileRepository }) => {
        const ts = Date.now();
        const extName = `@test/bundle-ns-${ts}`;
        const trackedFile =
          `.swamp/pulled-extensions/${extName}/models/model.ts`;
        const extRoot = join(
          swampPath(repoDir, "pulled-extensions"),
          extName,
        );
        await ensureDir(join(extRoot, "models"));
        await Deno.writeTextFile(
          join(extRoot, "models", "model.ts"),
          "// stub",
        );
        await stageScaffoldDirs(extRoot);
        await stageBundleNamespaceDirs(repoDir, extName);
        await lockfileRepository.writeEntry(extName, "1.0.0", [
          trackedFile,
        ]);

        const removeSvc = new RemoveExtensionService({
          repository,
          lockfileRepository,
          repoDir,
        });
        await removeSvc.execute(extName);

        for (const [sourceKind, bundleKind] of BUNDLE_MAPPINGS) {
          const hash = bundleNamespace(
            join(extRoot, sourceKind),
            repoDir,
          );
          const bundleDir = join(swampPath(repoDir, bundleKind), hash);
          await assertRejects(
            () => Deno.stat(bundleDir),
            Deno.errors.NotFound,
            undefined,
            `Post-rm: ${bundleKind}/${hash} must be removed`,
          );
        }
      },
    );
  },
);

Deno.test(
  "swamp-club#392: rm preserves sibling extension bundle namespace dirs",
  async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, lockfileRepository }) => {
        const ts = Date.now();
        const extA = `@test/bundle-sib-a-${ts}`;
        const extB = `@test/bundle-sib-b-${ts}`;
        const extRootA = join(
          swampPath(repoDir, "pulled-extensions"),
          extA,
        );
        const extRootB = join(
          swampPath(repoDir, "pulled-extensions"),
          extB,
        );
        for (const [ext, root] of [[extA, extRootA], [extB, extRootB]]) {
          await ensureDir(join(root, "models"));
          await Deno.writeTextFile(
            join(root, "models", "model.ts"),
            "// stub",
          );
          await stageScaffoldDirs(root);
          await stageBundleNamespaceDirs(repoDir, ext);
          await lockfileRepository.writeEntry(ext, "1.0.0", [
            `.swamp/pulled-extensions/${ext}/models/model.ts`,
          ]);
        }

        const removeSvc = new RemoveExtensionService({
          repository,
          lockfileRepository,
          repoDir,
        });
        await removeSvc.execute(extA);

        // A's bundle namespace dirs must be gone.
        for (const [sourceKind, bundleKind] of BUNDLE_MAPPINGS) {
          const hashA = bundleNamespace(
            join(extRootA, sourceKind),
            repoDir,
          );
          await assertRejects(
            () => Deno.stat(join(swampPath(repoDir, bundleKind), hashA)),
            Deno.errors.NotFound,
            undefined,
            `Post-rm: extA ${bundleKind}/${hashA} must be removed`,
          );
        }

        // B's bundle namespace dirs must be preserved.
        for (const [sourceKind, bundleKind] of BUNDLE_MAPPINGS) {
          const hashB = bundleNamespace(
            join(extRootB, sourceKind),
            repoDir,
          );
          const stat = await Deno.stat(
            join(swampPath(repoDir, bundleKind), hashB),
          );
          assertEquals(
            stat.isDirectory,
            true,
            `Post-rm: extB ${bundleKind}/${hashB} must be preserved`,
          );
        }
      },
    );
  },
);

Deno.test(
  "swamp-club#392: rm prunes bundle namespace dir after tracked bundle file deleted",
  async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, lockfileRepository }) => {
        const ts = Date.now();
        const extName = `@test/bundle-pop-${ts}`;
        const extRoot = join(
          swampPath(repoDir, "pulled-extensions"),
          extName,
        );
        await ensureDir(join(extRoot, "models"));
        await Deno.writeTextFile(
          join(extRoot, "models", "model.ts"),
          "// stub",
        );
        await stageScaffoldDirs(extRoot);
        await stageBundleNamespaceDirs(repoDir, extName);

        // Place a compiled bundle file in bundles/<hash>/ and track it.
        const bundlesHash = bundleNamespace(
          join(extRoot, "models"),
          repoDir,
        );
        const bundleFile = join(
          swampPath(repoDir, "bundles"),
          bundlesHash,
          "compiled.js",
        );
        await Deno.writeTextFile(bundleFile, "// compiled");
        const bundleFileRel = `.swamp/bundles/${bundlesHash}/compiled.js`;

        await lockfileRepository.writeEntry(extName, "1.0.0", [
          `.swamp/pulled-extensions/${extName}/models/model.ts`,
          bundleFileRel,
        ]);

        const removeSvc = new RemoveExtensionService({
          repository,
          lockfileRepository,
          repoDir,
        });
        await removeSvc.execute(extName);

        // The tracked bundle file is deleted, and since the dir is now
        // empty the namespace dir should also be pruned.
        await assertRejects(
          () =>
            Deno.stat(
              join(swampPath(repoDir, "bundles"), bundlesHash),
            ),
          Deno.errors.NotFound,
          undefined,
          "Post-rm: bundles/<hash>/ must be pruned after tracked file deleted",
        );

        // The four empty bundle namespace dirs (vault-, driver-,
        // datastore-, report-) must also be pruned.
        for (
          const [sourceKind, bundleKind] of BUNDLE_MAPPINGS.filter(
            ([_, bk]) => bk !== "bundles",
          )
        ) {
          const hash = bundleNamespace(
            join(extRoot, sourceKind),
            repoDir,
          );
          await assertRejects(
            () => Deno.stat(join(swampPath(repoDir, bundleKind), hash)),
            Deno.errors.NotFound,
            undefined,
            `Post-rm: ${bundleKind}/${hash} must be removed`,
          );
        }
      },
    );
  },
);
