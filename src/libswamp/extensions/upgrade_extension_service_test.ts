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
import { ensureDir } from "@std/fs";
import { UpgradeExtensionService } from "./upgrade_extension_service.ts";
import { InstallExtensionService } from "./install_extension_service.ts";
import type { InstallContext, InstallResult } from "./pull.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
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
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_upsvc_test_" });
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
): Promise<void> {
  const modelsDir = join(
    swampPath(repoDir, "pulled-extensions"),
    extName,
    "models",
  );
  await ensureDir(modelsDir);
  await Deno.writeTextFile(join(modelsDir, fileName), modelCode);
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

const MINIMAL_MODEL_CODE = (typeId: string, version: string) => `
import { z } from "npm:zod@4";

export const model = {
  type: "${typeId}",
  version: "${version}",
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
// Atomic upgrade contract — saveAll([tombstoneAll(v1), v2]) in one txn
// =============================================================
//
// Without the tombstone of v1 in the same saveAll, I-Repo-1 fires
// `DuplicateTypeError` on every upgrade because v1 still claims the
// type when v2's save attempts to add a row for the same type. This
// test pins the atomic contract: after upgrade, ONLY v2's rows are in
// the catalog; v1's are gone.

Deno.test(
  "UpgradeExtensionService.execute: v1 → v2 upgrade tombstones v1's catalog rows in one transaction",
  async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, lockfileRepository }) => {
        const ts = Date.now();
        const extName = `@test/upgrade-${ts}`;
        const typeId = `@test/upgrade-model-${ts}`;

        const v1Cal = "2026.05.05.1";
        const v2Cal = "2026.05.05.2";

        // Install v1 first via InstallExtensionService.
        await stageModel(
          repoDir,
          extName,
          "model.ts",
          MINIMAL_MODEL_CODE(typeId, v1Cal),
        );
        const installSvc = new InstallExtensionService({
          denoRuntime: testDenoRuntime,
          repository,
          installExtensionFn: async (ref, ctx) => {
            await ctx.lockfileRepository.writeEntry(
              ref.name,
              ref.version ?? v1Cal,
              [`.swamp/pulled-extensions/${ref.name}/models/model.ts`],
            );
            return makeStubInstallResult(
              ref.name,
              ref.version ?? v1Cal,
              [`.swamp/pulled-extensions/${ref.name}/models/model.ts`],
            );
          },
        });
        await installSvc.execute(
          { name: extName, version: v1Cal },
          makeInstallContext(repoDir, lockfileRepository),
        );
        const v1Extensions = repository.loadByName(extName);
        assertEquals(v1Extensions.length, 1);
        assertEquals(v1Extensions[0].version, v1Cal);

        // Upgrade to v2 — overwrite the source file with v2 content
        // (mirrors what install does on disk).
        await stageModel(
          repoDir,
          extName,
          "model.ts",
          MINIMAL_MODEL_CODE(typeId, v2Cal),
        );
        const upgradeSvc = new UpgradeExtensionService({
          denoRuntime: testDenoRuntime,
          repository,
          installExtensionFn: async (ref, ctx) => {
            await ctx.lockfileRepository.writeEntry(
              ref.name,
              ref.version ?? v2Cal,
              [`.swamp/pulled-extensions/${ref.name}/models/model.ts`],
            );
            return makeStubInstallResult(
              ref.name,
              ref.version ?? v2Cal,
              [`.swamp/pulled-extensions/${ref.name}/models/model.ts`],
            );
          },
        });
        await upgradeSvc.execute(
          extName,
          v2Cal,
          makeInstallContext(repoDir, lockfileRepository),
        );

        // Atomic upgrade contract: only v2's aggregate is present;
        // v1's rows tombstoned and DELETEd by the diff-save. No
        // DuplicateTypeError fired (the tombstone in the same saveAll
        // means I-Repo-1 evaluates only v2 in the post-save state).
        const afterUpgrade = repository.loadByName(extName);
        assertEquals(afterUpgrade.length, 1);
        assertEquals(afterUpgrade[0].version, v2Cal);
        assertEquals(
          lockfileRepository.getEntry(extName)?.version,
          v2Cal,
        );
      },
    );
  },
);

// =============================================================
// Force-pull regression — re-pulling an already-installed extension
// must not fail with DuplicateTypeError.
// =============================================================
//
// Pre-this-fix: `swamp extension pull foo --force` against an already-
// installed foo would fail because phase 8 saved v2's aggregate while
// v1's rows still claimed the type → I-Repo-1 fired. Now the atomic
// tombstone-of-prior-version pattern handles this transparently.

Deno.test(
  "InstallExtensionService.execute: force-reinstall of already-installed extension does not fail with DuplicateTypeError",
  async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, lockfileRepository }) => {
        const ts = Date.now();
        const extName = `@test/force-pull-${ts}`;
        const typeId = `@test/force-pull-model-${ts}`;

        const v1Cal = "2026.05.05.1";
        const v2Cal = "2026.05.05.2";

        // Install v1.
        await stageModel(
          repoDir,
          extName,
          "model.ts",
          MINIMAL_MODEL_CODE(typeId, v1Cal),
        );
        const svc = new InstallExtensionService({
          denoRuntime: testDenoRuntime,
          repository,
          installExtensionFn: async (ref, ctx) => {
            await ctx.lockfileRepository.writeEntry(
              ref.name,
              ref.version ?? v1Cal,
              [`.swamp/pulled-extensions/${ref.name}/models/model.ts`],
            );
            return makeStubInstallResult(
              ref.name,
              ref.version ?? v1Cal,
              [`.swamp/pulled-extensions/${ref.name}/models/model.ts`],
            );
          },
        });
        await svc.execute(
          { name: extName, version: v1Cal },
          makeInstallContext(repoDir, lockfileRepository),
        );

        // Force-pull v2 (same name, different version) via the SAME
        // service. The atomic-tombstone pattern handles it.
        await stageModel(
          repoDir,
          extName,
          "model.ts",
          MINIMAL_MODEL_CODE(typeId, v2Cal),
        );
        const svc2 = new InstallExtensionService({
          denoRuntime: testDenoRuntime,
          repository,
          installExtensionFn: async (ref, ctx) => {
            await ctx.lockfileRepository.writeEntry(
              ref.name,
              ref.version ?? v2Cal,
              [`.swamp/pulled-extensions/${ref.name}/models/model.ts`],
            );
            return makeStubInstallResult(
              ref.name,
              ref.version ?? v2Cal,
              [`.swamp/pulled-extensions/${ref.name}/models/model.ts`],
            );
          },
        });
        // Should not throw.
        await svc2.execute(
          { name: extName, version: v2Cal },
          makeInstallContext(repoDir, lockfileRepository),
        );

        const after = repository.loadByName(extName);
        assertEquals(after.length, 1);
        assertEquals(after[0].version, v2Cal);
      },
    );
  },
);
