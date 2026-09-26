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

import { assertEquals, assertGreater } from "@std/assert";
import { basename as pathBasename, join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import {
  bundleNamespace,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { canonicalizePath } from "../../infrastructure/persistence/canonicalize_path.ts";
import { DuplicateTypeError } from "../../infrastructure/persistence/duplicate_type_error.ts";
import { ReconcileFromDiskService } from "./reconcile_from_disk_service.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import type { DenoRuntime } from "../../domain/runtime/deno_runtime.ts";
import type { LocalManifestIdentity } from "../../infrastructure/persistence/local_manifest_reader.ts";

import "../../domain/models/models.ts";

const testDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
  getDenoEnv: () => Deno.env.toObject(),
};

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

const MINIMAL_EXTENSION_CODE = (targetType: string) => `
import { z } from "npm:zod@4";

export const extension = {
  type: "${targetType}",
  methods: [
    {
      probe: {
        description: "probe",
        arguments: z.object({}),
        execute: async () => ({ probed: true }),
      },
    },
  ],
};
`;

async function withFixtureRepo(
  fn: (args: {
    repoDir: string;
    repository: ExtensionRepository;
    catalog: ExtensionCatalogStore;
    lockfileRepository: LockfileRepository;
  }) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_reconcile_test_" });
  await ensureDir(join(repoDir, ".swamp"));
  await ensureDir(join(repoDir, "extensions", "models"));
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");
  const lockfilePath = join(
    repoDir,
    "extensions",
    "models",
    "upstream_extensions.json",
  );
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

Deno.test(
  "ReconcileFromDisk: empty repo produces zero transitions",
  async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, lockfileRepository }) => {
        const service = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });
        const result = await service.execute();
        assertEquals(result.transitions.length, 0);
        assertEquals(result.applied, false);
      },
    );
  },
);

Deno.test(
  "ReconcileFromDisk: discovers new local model and indexes it",
  async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, lockfileRepository }) => {
        const ts = Date.now();
        const typeId = `@test/reconcile-new-${ts}`;
        const modelPath = join(repoDir, "extensions", "models", "test.ts");
        await Deno.writeTextFile(modelPath, MINIMAL_MODEL_CODE(typeId));

        const service = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });
        const result = await service.execute();

        assertGreater(
          result.transitions.length,
          0,
          "must discover and index the new model",
        );
        assertEquals(result.applied, true);

        const found = result.transitions.find(
          (t) => t.toState === "Indexed",
        );
        assertEquals(
          found !== undefined,
          true,
          "must have an Indexed transition",
        );
      },
    );
  },
);

Deno.test(
  "ReconcileFromDisk: local extension gets extends_type so findExtensionsForType matches it (swamp-club#903)",
  async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, catalog, lockfileRepository }) => {
        const ts = Date.now();
        const baseType = `@test/reconcile-base-${ts}`;
        await Deno.writeTextFile(
          join(repoDir, "extensions", "models", "base.ts"),
          MINIMAL_MODEL_CODE(baseType),
        );
        await Deno.writeTextFile(
          join(repoDir, "extensions", "models", "ext.ts"),
          MINIMAL_EXTENSION_CODE(baseType),
        );

        const service = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });
        const result = await service.execute();
        assertEquals(result.applied, true);

        // The reconcile path (saveAll → sourceToRow) is the sole writer here.
        // Before the fix it wrote extends_type "", so the extension's methods
        // were dropped. The row must now be findable by its target type.
        const matches = catalog.findExtensionsForType(baseType);
        assertEquals(matches.length, 1, "extension must target the base type");
        assertEquals(matches[0].extends_type, baseType);
        assertEquals(matches[0].kind, "extension");
      },
    );
  },
);

Deno.test(
  "ReconcileFromDisk: dryRun collects transitions without applying",
  async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, catalog, lockfileRepository }) => {
        const ts = Date.now();
        const typeId = `@test/reconcile-dry-${ts}`;
        const modelPath = join(repoDir, "extensions", "models", "dry.ts");
        await Deno.writeTextFile(modelPath, MINIMAL_MODEL_CODE(typeId));

        const service = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });

        const rowsBefore = catalog.findAll().length;
        const result = await service.execute({ dryRun: true });

        assertGreater(result.transitions.length, 0);
        assertEquals(result.applied, false, "dryRun must not apply");
        assertEquals(
          catalog.findAll().length,
          rowsBefore,
          "catalog unchanged in dryRun",
        );
      },
    );
  },
);

Deno.test({
  name: "ReconcileFromDisk: idempotence — second run produces zero transitions",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, lockfileRepository }) => {
        const ts = Date.now();
        const typeId = `@test/reconcile-idem-${ts}`;
        const modelPath = join(repoDir, "extensions", "models", "idem.ts");
        await Deno.writeTextFile(modelPath, MINIMAL_MODEL_CODE(typeId));

        const service = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });

        const first = await service.execute();
        assertGreater(first.transitions.length, 0);
        assertEquals(first.applied, true);

        const second = await service.execute();
        assertEquals(
          second.transitions.length,
          0,
          "second reconcile must produce zero transitions (idempotence)",
        );
        assertEquals(second.applied, false);
      },
    );
  },
});

Deno.test({
  name: "ReconcileFromDisk: no-op reconcile marks a newly added kind populated",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, catalog, lockfileRepository }) => {
        await Deno.writeTextFile(
          join(repoDir, "extensions", "models", "noop.ts"),
          MINIMAL_MODEL_CODE(`@test/reconcile-noop-${crypto.randomUUID()}`),
        );
        const service = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });
        assertEquals((await service.execute()).applied, true);

        // Simulate a catalog built before the webhook kind existed.
        catalog.invalidate("webhook");
        assertEquals(repository.anyKindNeedsInvalidation(), true);

        const dry = await service.execute({ dryRun: true });
        assertEquals(dry.transitions.length, 0);
        assertEquals(
          repository.anyKindNeedsInvalidation(),
          true,
          "dryRun must not mark kinds populated",
        );

        const result = await service.execute();
        assertEquals(result.transitions.length, 0);
        assertEquals(repository.anyKindNeedsInvalidation(), false);
      },
    );
  },
});

Deno.test(
  "ReconcileFromDisk: deleted local source → tombstoned",
  async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, lockfileRepository }) => {
        const ts = Date.now();
        const typeId = `@test/reconcile-del-${ts}`;
        const modelPath = join(repoDir, "extensions", "models", "del.ts");
        await Deno.writeTextFile(modelPath, MINIMAL_MODEL_CODE(typeId));

        const service = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });

        await service.execute();

        await Deno.remove(modelPath);
        const result = await service.execute();

        const tombstone = result.transitions.find(
          (t) =>
            t.toState === "Tombstoned" || t.toState === "OrphanedBundleOnly",
        );
        assertEquals(
          tombstone !== undefined,
          true,
          "deleted source must produce a tombstone/orphan transition",
        );
        assertEquals(result.applied, true);
      },
    );
  },
);

Deno.test(
  "ReconcileFromDisk: transition-count guardrail aborts on mass tombstone",
  async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, catalog, lockfileRepository }) => {
        // Seed the catalog with 10 fake rows directly. Then run
        // reconcile with an empty disk — all 10 would tombstone,
        // exceeding the 50% guardrail (10/10 = 100%).
        for (let i = 0; i < 10; i++) {
          catalog.upsertWithIdentity({
            source_path: join(
              repoDir,
              "extensions",
              "models",
              `fake${i}.ts`,
            ),
            type_normalized: `@test/fake${i}`,
            kind: "model",
            bundle_path: "",
            version: "0.0.0",
            description: "",
            extends_type: "",
            source_mtime: "",
            source_fingerprint: "fp",
            state: "Indexed",
            extension_name: `@local/${pathBasename(repoDir)}`,
            extension_version: "0.0.0",
          });
        }

        const service = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });
        const result = await service.execute();

        assertEquals(
          result.applied,
          false,
          "guardrail must abort when > 50% of rows would transition",
        );
        assertGreater(result.transitions.length, 0);
      },
    );
  },
);

Deno.test(
  "ReconcileFromDisk: ReconcileTransition has structured fields",
  async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, lockfileRepository }) => {
        const ts = Date.now();
        const typeId = `@test/reconcile-struct-${ts}`;
        const modelPath = join(
          repoDir,
          "extensions",
          "models",
          "struct.ts",
        );
        await Deno.writeTextFile(modelPath, MINIMAL_MODEL_CODE(typeId));

        const service = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });
        const result = await service.execute({ dryRun: true });

        for (const t of result.transitions) {
          assertEquals(typeof t.source.canonicalPath, "string");
          assertEquals(typeof t.toState, "string");
          assertEquals(typeof t.reason, "string");
        }
      },
    );
  },
);

// -- Regression tests for the three bug classes W3 structurally fixes -----

Deno.test({
  name:
    "ReconcileFromDisk regression #208: broken transitive dep → stable state, no rebundle loop",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, lockfileRepository }) => {
        const ts = Date.now();
        const typeId = `@test/dep-break-${ts}`;
        const modelsDir = join(repoDir, "extensions", "models");
        const entry = join(modelsDir, "entry.ts");
        await Deno.writeTextFile(entry, MINIMAL_MODEL_CODE(typeId));

        const service = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });

        // First reconcile: everything works.
        const first = await service.execute();
        assertEquals(first.applied, true);

        // Now corrupt the file — make it import a nonexistent dep.
        // This changes the fingerprint, and bundleAndIndexOne will
        // either fail or skip it.
        await Deno.writeTextFile(
          entry,
          `import { x } from './nonexistent.ts';\nexport const broken = x;\n`,
        );

        // Second reconcile: detects fingerprint change, tries to
        // rebundle. Either BundleBuildFailed or skipped (null return).
        await service.execute();

        // Third reconcile: whatever state we're in, it must be STABLE.
        const third = await service.execute();
        assertEquals(
          third.transitions.length,
          0,
          "#208: broken dep state must be stable — no rebundle loop",
        );
      },
    );
  },
});

Deno.test({
  name:
    "ReconcileFromDisk regression #209: schema-invalid extension → stable state, no rebundle loop",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, lockfileRepository }) => {
        const modelsDir = join(repoDir, "extensions", "models");
        // This file exports something that isn't a valid model schema.
        // bundleAndIndexOne will fail (either during bundle or validation).
        const file = join(modelsDir, "broken_schema.ts");
        await Deno.writeTextFile(
          file,
          'export const model = { not: "a valid model schema" };\n',
        );

        const service = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });

        // First reconcile: bundleAndIndexOne fails → ValidationFailed.
        await service.execute();
        // The file might be skipped entirely (bundleAndIndexOne returns
        // null for non-model exports) or fail. Either way, subsequent
        // reconciles must not loop.

        // Second reconcile: stable state → zero transitions.
        const result = await service.execute();
        assertEquals(
          result.transitions.length,
          0,
          "#209: schema-invalid extension must converge to stable state",
        );
      },
    );
  },
});

Deno.test({
  name:
    "ReconcileFromDisk regression #212: cached bundle missing → rebundles once, not in a loop",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, lockfileRepository, catalog }) => {
        const ts = Date.now();
        const typeId = `@test/reconcile-212-${ts}`;
        const modelPath = join(
          repoDir,
          "extensions",
          "models",
          "missing_bundle.ts",
        );
        await Deno.writeTextFile(modelPath, MINIMAL_MODEL_CODE(typeId));

        const service = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });

        // First reconcile: indexes the model.
        const first = await service.execute();
        assertEquals(first.applied, true);

        // Find the bundle path from the catalog and delete it.
        const rows = catalog.findAll();
        const row = rows.find((r) =>
          r.source_path.includes("missing_bundle.ts")
        );
        assertEquals(row !== undefined, true, "row must exist in catalog");
        if (row?.bundle_path) {
          try {
            await Deno.remove(row.bundle_path);
          } catch {
            // Bundle might not exist on disk (Deno bundle output location)
          }
        }

        // Second reconcile: detects issue, re-indexes.
        await service.execute();
        // May or may not produce transitions depending on whether
        // fingerprint changed. The key assertion is the THIRD run.

        // Third reconcile: must be stable — zero transitions.
        const third = await service.execute();
        assertEquals(
          third.transitions.length,
          0,
          "#212: after rebundle, state must be stable (no loop)",
        );
      },
    );
  },
});

// -- Pulled extension reconcile matrix ------------------------------------

async function withPulledFixtureRepo(
  fn: (args: {
    repoDir: string;
    repository: ExtensionRepository;
    catalog: ExtensionCatalogStore;
    lockfileRepository: LockfileRepository;
  }) => Promise<void>,
  lockfileContent: Record<string, unknown>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_reconcile_pulled_",
  });
  await ensureDir(join(repoDir, ".swamp"));
  await ensureDir(join(repoDir, "extensions", "models"));
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");
  const lockfilePath = join(
    repoDir,
    "extensions",
    "models",
    "upstream_extensions.json",
  );
  await Deno.writeTextFile(lockfilePath, JSON.stringify(lockfileContent));

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

Deno.test(
  "ReconcileFromDisk pulled: new source on disk + lockfile entry → indexed",
  async () => {
    const ts = Date.now();
    const extName = `@test/pulled-new-${ts}`;
    const typeId = `@test/pulled-model-${ts}`;
    await withPulledFixtureRepo(
      async ({ repoDir, repository, lockfileRepository }) => {
        // Stage a model in the pulled-extensions directory.
        const extRoot = join(
          swampPath(repoDir, "pulled-extensions"),
          extName,
          "models",
        );
        await ensureDir(extRoot);
        await Deno.writeTextFile(
          join(extRoot, "noop.ts"),
          MINIMAL_MODEL_CODE(typeId),
        );

        const service = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });
        const result = await service.execute();

        const indexed = result.transitions.find(
          (t) => t.toState === "Indexed",
        );
        assertEquals(
          indexed !== undefined,
          true,
          "pulled: new source must be indexed",
        );
        assertEquals(result.applied, true);
      },
      { [extName]: { version: "1.0.0", files: [] } },
    );
  },
);

Deno.test(
  "ReconcileFromDisk pulled: source missing + no lockfile entry → tombstoned (orphan)",
  async () => {
    const ts = Date.now();
    const extName = `@test/pulled-orphan-${ts}`;
    await withPulledFixtureRepo(
      async ({ repoDir, repository, catalog, lockfileRepository }) => {
        // Seed a catalog row for a pulled extension that has NO
        // lockfile entry and NO on-disk files. This simulates an
        // orphan from a failed rm.
        const extRoot = join(
          swampPath(repoDir, "pulled-extensions"),
          extName,
        );
        catalog.upsertWithIdentity({
          source_path: join(extRoot, "models", "ghost.ts"),
          type_normalized: `${extName}/ghost`,
          kind: "model",
          bundle_path: "",
          version: "1.0.0",
          description: "",
          extends_type: "",
          source_mtime: "",
          source_fingerprint: "fp",
          state: "Indexed",
          extension_name: extName,
          extension_version: "1.0.0",
        });

        const service = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });
        const result = await service.execute();

        const tombstone = result.transitions.find(
          (t) => t.toState === "Tombstoned",
        );
        assertEquals(
          tombstone !== undefined,
          true,
          "pulled orphan must be tombstoned",
        );
        assertEquals(result.applied, true);
      },
      {},
    );
  },
);

Deno.test(
  "ReconcileFromDisk pulled: source missing + lockfile present → EntryPointUnreadable",
  async () => {
    const ts = Date.now();
    const extName = `@test/pulled-missing-${ts}`;
    const typeId = `@test/pulled-missing-model-${ts}`;
    await withPulledFixtureRepo(
      async ({ repoDir, repository, lockfileRepository }) => {
        // Stage, reconcile to index, then delete the source file.
        const extRoot = join(
          swampPath(repoDir, "pulled-extensions"),
          extName,
          "models",
        );
        await ensureDir(extRoot);
        await Deno.writeTextFile(
          join(extRoot, "noop.ts"),
          MINIMAL_MODEL_CODE(typeId),
        );

        const service = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });

        // First reconcile: indexes it.
        await service.execute();

        // Delete the source file (but lockfile entry remains).
        await Deno.remove(join(extRoot, "noop.ts"));

        // Second reconcile: source missing + lockfile present →
        // EntryPointUnreadable.
        const result = await service.execute();
        const unreadable = result.transitions.find(
          (t) => t.toState === "EntryPointUnreadable",
        );
        assertEquals(
          unreadable !== undefined,
          true,
          "pulled: missing source with lockfile entry → EntryPointUnreadable",
        );
      },
      { [extName]: { version: "1.0.0", files: [] } },
    );
  },
);

// -- Manifest version migration tests (#284) --------------------------------

async function withManifestFixtureRepo(
  fn: (args: {
    repoDir: string;
    catalog: ExtensionCatalogStore;
    lockfileRepository: LockfileRepository;
    makeService: (
      manifest: LocalManifestIdentity | null,
    ) => ReconcileFromDiskService;
  }) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_reconcile_manifest_",
  });
  await ensureDir(join(repoDir, ".swamp"));
  await ensureDir(join(repoDir, "extensions", "models"));
  const dbPath = join(repoDir, ".swamp", "_extension_catalog.db");
  const lockfilePath = join(
    repoDir,
    "extensions",
    "models",
    "upstream_extensions.json",
  );
  await Deno.writeTextFile(lockfilePath, "{}");

  const catalog = new ExtensionCatalogStore(dbPath);
  const lockfileRepository = await LockfileRepository.create(lockfilePath);

  const makeService = (
    manifest: LocalManifestIdentity | null,
  ): ReconcileFromDiskService => {
    const repository = new ExtensionRepository({
      catalog,
      lockfileRepository,
      repoRoot: repoDir,
      localManifestIdentity: manifest,
    });
    return new ReconcileFromDiskService({
      denoRuntime: testDenoRuntime,
      repository,
      lockfileRepository,
      repoDir,
      localManifestIdentity: manifest,
    });
  };

  try {
    await fn({ repoDir, catalog, lockfileRepository, makeService });
  } finally {
    catalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

Deno.test({
  name: "ReconcileFromDisk #284: manifest version bump updates catalog version",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withManifestFixtureRepo(
      async ({ repoDir, catalog, makeService }) => {
        const ts = Date.now();
        const typeId = `@test/version-bump-${ts}`;
        const modelPath = join(repoDir, "extensions", "models", "bump.ts");
        await Deno.writeTextFile(modelPath, MINIMAL_MODEL_CODE(typeId));

        const manifestA: LocalManifestIdentity = {
          name: "@test/my-ext",
          version: "2026.04.21.1",
        };
        const first = await makeService(manifestA).execute();
        assertEquals(first.applied, true);

        const rowsAfterFirst = catalog.findAll();
        const row1 = rowsAfterFirst.find((r) =>
          r.source_path.includes("bump.ts")
        );
        assertEquals(row1?.extension_version, "2026.04.21.1");

        const manifestB: LocalManifestIdentity = {
          name: "@test/my-ext",
          version: "2026.04.22.1",
        };
        const second = await makeService(manifestB).execute();
        assertEquals(second.applied, true);

        const rowsAfterSecond = catalog.findAll();
        const row2 = rowsAfterSecond.find((r) =>
          r.source_path.includes("bump.ts")
        );
        assertEquals(
          row2?.extension_version,
          "2026.04.22.1",
          "#284: version bump must update catalog",
        );
      },
    );
  },
});

Deno.test({
  name:
    "ReconcileFromDisk #284: simultaneous name + version change (no-manifest → manifest)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withManifestFixtureRepo(
      async ({ repoDir, catalog, makeService }) => {
        const ts = Date.now();
        const typeId = `@test/name-version-${ts}`;
        const modelPath = join(
          repoDir,
          "extensions",
          "models",
          "combined.ts",
        );
        await Deno.writeTextFile(modelPath, MINIMAL_MODEL_CODE(typeId));

        const first = await makeService(null).execute();
        assertEquals(first.applied, true);

        const rowsAfterFirst = catalog.findAll();
        const row1 = rowsAfterFirst.find((r) =>
          r.source_path.includes("combined.ts")
        );
        assertEquals(row1?.extension_version, "0.0.0");
        assertEquals(
          row1?.extension_name?.startsWith("@local/"),
          true,
          "no-manifest: must use @local/ prefix",
        );

        const manifest: LocalManifestIdentity = {
          name: "@scope/my-project",
          version: "2026.05.01.1",
        };
        const second = await makeService(manifest).execute();
        assertEquals(second.applied, true);

        const rowsAfterSecond = catalog.findAll();
        const row2 = rowsAfterSecond.find((r) =>
          r.source_path.includes("combined.ts")
        );
        assertEquals(
          row2?.extension_name,
          "@scope/my-project",
          "#284: name must migrate to manifest name",
        );
        assertEquals(
          row2?.extension_version,
          "2026.05.01.1",
          "#284: version must migrate to manifest version",
        );
      },
    );
  },
});

Deno.test({
  name:
    "ReconcileFromDisk #284: manifest deletion reverts to synthetic @local/ identity",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withManifestFixtureRepo(
      async ({ repoDir, catalog, makeService }) => {
        const ts = Date.now();
        const typeId = `@test/manifest-del-${ts}`;
        const modelPath = join(repoDir, "extensions", "models", "revert.ts");
        await Deno.writeTextFile(modelPath, MINIMAL_MODEL_CODE(typeId));

        const manifest: LocalManifestIdentity = {
          name: "@scope/will-delete",
          version: "2026.05.01.1",
        };
        const first = await makeService(manifest).execute();
        assertEquals(first.applied, true);

        const rowsAfterFirst = catalog.findAll();
        const row1 = rowsAfterFirst.find((r) =>
          r.source_path.includes("revert.ts")
        );
        assertEquals(row1?.extension_name, "@scope/will-delete");
        assertEquals(row1?.extension_version, "2026.05.01.1");

        const second = await makeService(null).execute();
        assertEquals(second.applied, true);

        const basename = pathBasename(repoDir);
        const rowsAfterSecond = catalog.findAll();
        const row2 = rowsAfterSecond.find((r) =>
          r.source_path.includes("revert.ts")
        );
        assertEquals(
          row2?.extension_name,
          `@local/${basename}`,
          "#284: deleting manifest must revert to @local/ identity",
        );
        assertEquals(
          row2?.extension_version,
          "0.0.0",
          "#284: deleting manifest must revert version to 0.0.0",
        );
      },
    );
  },
});

Deno.test({
  name:
    "ReconcileFromDisk #284: version bump with ≥10 sources does not hit guardrail",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withManifestFixtureRepo(
      async ({ repoDir, catalog, makeService }) => {
        const ts = Date.now();
        for (let i = 0; i < 12; i++) {
          const typeId = `@test/guardrail-${ts}-${i}`;
          const modelPath = join(
            repoDir,
            "extensions",
            "models",
            `model${i}.ts`,
          );
          await Deno.writeTextFile(modelPath, MINIMAL_MODEL_CODE(typeId));
        }

        const manifestA: LocalManifestIdentity = {
          name: "@test/big-ext",
          version: "2026.04.21.1",
        };
        const first = await makeService(manifestA).execute();
        assertEquals(first.applied, true);
        assertEquals(catalog.findAll().length, 12);

        const manifestB: LocalManifestIdentity = {
          name: "@test/big-ext",
          version: "2026.04.22.1",
        };
        const second = await makeService(manifestB).execute();
        assertEquals(
          second.applied,
          true,
          "#284: version migration must not be blocked by guardrail",
        );

        const rows = catalog.findAll();
        for (const row of rows) {
          assertEquals(
            row.extension_version,
            "2026.04.22.1",
            `#284: all rows must have new version, got ${row.extension_version} for ${row.source_path}`,
          );
        }
      },
    );
  },
});

// -- Per-subdirectory manifest tests (#784) ----------------------------------

Deno.test({
  name:
    "ReconcileFromDisk #784: sibling subdirs with own manifests produce separate aggregates",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, catalog, lockfileRepository }) => {
        const ts = Date.now();
        const fooDir = join(repoDir, "extensions", "models", "foo");
        const barDir = join(repoDir, "extensions", "models", "bar");
        await ensureDir(fooDir);
        await ensureDir(barDir);

        await Deno.writeTextFile(
          join(fooDir, "manifest.yaml"),
          stringifyYaml({
            manifestVersion: 1,
            name: "@test/foo",
            version: "2026.06.01.1",
          }),
        );
        await Deno.writeTextFile(
          join(fooDir, "driver.ts"),
          MINIMAL_MODEL_CODE(`@test/foo-model-${ts}`),
        );

        await Deno.writeTextFile(
          join(barDir, "manifest.yaml"),
          stringifyYaml({
            manifestVersion: 1,
            name: "@test/bar",
            version: "2026.06.01.1",
          }),
        );
        await Deno.writeTextFile(
          join(barDir, "driver.ts"),
          MINIMAL_MODEL_CODE(`@test/bar-model-${ts}`),
        );

        const service = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });
        const result = await service.execute();
        assertEquals(result.applied, true);

        const rows = catalog.findAll();
        const fooRows = rows.filter((r) => r.extension_name === "@test/foo");
        const barRows = rows.filter((r) => r.extension_name === "@test/bar");

        assertGreater(
          fooRows.length,
          0,
          "#784: @test/foo must have its own catalog rows",
        );
        assertGreater(
          barRows.length,
          0,
          "#784: @test/bar must have its own catalog rows",
        );

        for (const row of fooRows) {
          assertEquals(row.extension_version, "2026.06.01.1");
          assertEquals(
            row.source_path.includes("/foo/"),
            true,
            "#784: @test/foo rows must reference files under foo/",
          );
        }
        for (const row of barRows) {
          assertEquals(row.extension_version, "2026.06.01.1");
          assertEquals(
            row.source_path.includes("/bar/"),
            true,
            "#784: @test/bar rows must reference files under bar/",
          );
        }
      },
    );
  },
});

Deno.test({
  name:
    "ReconcileFromDisk #784: top-level manifest takes precedence over per-subdir manifests",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withManifestFixtureRepo(
      async ({ repoDir, catalog, makeService }) => {
        const ts = Date.now();
        const subDir = join(repoDir, "extensions", "models", "sub");
        await ensureDir(subDir);

        await Deno.writeTextFile(
          join(subDir, "manifest.yaml"),
          stringifyYaml({
            manifestVersion: 1,
            name: "@test/sub-ext",
            version: "2026.06.01.1",
          }),
        );
        await Deno.writeTextFile(
          join(subDir, "driver.ts"),
          MINIMAL_MODEL_CODE(`@test/sub-model-${ts}`),
        );

        const topLevelManifest: LocalManifestIdentity = {
          name: "@test/top-level",
          version: "2026.06.01.1",
        };
        const result = await makeService(topLevelManifest).execute();
        assertEquals(result.applied, true);

        const rows = catalog.findAll();
        for (const row of rows) {
          assertEquals(
            row.extension_name,
            "@test/top-level",
            "#784: top-level manifest must claim all files",
          );
        }
        const subRows = rows.filter((r) =>
          r.extension_name === "@test/sub-ext"
        );
        assertEquals(
          subRows.length,
          0,
          "#784: per-subdir manifest must be ignored when top-level exists",
        );
      },
    );
  },
});

Deno.test({
  name: "ReconcileFromDisk #784: mixed — subdirs with and without manifests",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, catalog, lockfileRepository }) => {
        const ts = Date.now();
        const manifestedDir = join(
          repoDir,
          "extensions",
          "models",
          "manifested",
        );
        await ensureDir(manifestedDir);

        await Deno.writeTextFile(
          join(manifestedDir, "manifest.yaml"),
          stringifyYaml({
            manifestVersion: 1,
            name: "@test/manifested",
            version: "2026.06.01.1",
          }),
        );
        await Deno.writeTextFile(
          join(manifestedDir, "driver.ts"),
          MINIMAL_MODEL_CODE(`@test/manifested-model-${ts}`),
        );

        const bareModel = join(repoDir, "extensions", "models", "bare.ts");
        await Deno.writeTextFile(
          bareModel,
          MINIMAL_MODEL_CODE(`@test/bare-model-${ts}`),
        );

        const service = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });
        const result = await service.execute();
        assertEquals(result.applied, true);

        const rows = catalog.findAll();
        const manifestedRows = rows.filter((r) =>
          r.extension_name === "@test/manifested"
        );
        const localRows = rows.filter((r) =>
          r.extension_name === `@local/${pathBasename(repoDir)}`
        );

        assertGreater(
          manifestedRows.length,
          0,
          "#784: @test/manifested must have its own rows",
        );
        assertGreater(
          localRows.length,
          0,
          "#784: bare file must fall back to @local/<repo>",
        );

        for (const row of manifestedRows) {
          assertEquals(
            row.source_path.includes("/manifested/"),
            true,
            "#784: manifested rows must reference files under manifested/",
          );
        }
        for (const row of localRows) {
          assertEquals(
            row.source_path.includes("bare.ts"),
            true,
            "#784: @local/ rows must reference the bare file",
          );
        }
      },
    );
  },
});

Deno.test({
  name:
    "ReconcileFromDisk #784: migration — old monolithic @local/ aggregate splits into per-manifest aggregates",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, catalog, lockfileRepository }) => {
        const ts = Date.now();
        const fooDir = join(repoDir, "extensions", "models", "foo");
        const barDir = join(repoDir, "extensions", "models", "bar");
        await ensureDir(fooDir);
        await ensureDir(barDir);

        await Deno.writeTextFile(
          join(fooDir, "driver.ts"),
          MINIMAL_MODEL_CODE(`@test/foo-mig-${ts}`),
        );
        await Deno.writeTextFile(
          join(barDir, "driver.ts"),
          MINIMAL_MODEL_CODE(`@test/bar-mig-${ts}`),
        );

        // Phase 1: reconcile WITHOUT per-subdir manifests (simulates old
        // binary). Both files end up under @local/<repo>.
        const oldService = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });
        const first = await oldService.execute();
        assertEquals(first.applied, true);

        const oldRows = catalog.findAll();
        const repoBasename = `@local/${pathBasename(repoDir)}`;
        for (const row of oldRows) {
          assertEquals(
            row.extension_name,
            repoBasename,
            "#784 migration: old binary must group under @local/<repo>",
          );
        }

        // Phase 2: add per-subdir manifests and reconcile again (simulates
        // upgrading to the new binary). Old aggregate must be tombstoned,
        // new per-manifest aggregates must be created.
        await Deno.writeTextFile(
          join(fooDir, "manifest.yaml"),
          stringifyYaml({
            manifestVersion: 1,
            name: "@test/foo-ext",
            version: "2026.06.01.1",
          }),
        );
        await Deno.writeTextFile(
          join(barDir, "manifest.yaml"),
          stringifyYaml({
            manifestVersion: 1,
            name: "@test/bar-ext",
            version: "2026.06.01.1",
          }),
        );

        const newRepo = new ExtensionRepository({
          catalog,
          lockfileRepository,
          repoRoot: repoDir,
        });
        const newService = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository: newRepo,
          lockfileRepository,
          repoDir,
        });
        const second = await newService.execute();
        assertEquals(second.applied, true);

        const newRows = catalog.findAll().filter((r) =>
          (r.state ?? "Indexed") !== "Tombstoned"
        );
        const fooRows = newRows.filter((r) =>
          r.extension_name === "@test/foo-ext"
        );
        const barRows = newRows.filter((r) =>
          r.extension_name === "@test/bar-ext"
        );
        const localRows = newRows.filter((r) =>
          r.extension_name === repoBasename
        );

        assertGreater(
          fooRows.length,
          0,
          "#784 migration: @test/foo-ext must exist after migration",
        );
        assertGreater(
          barRows.length,
          0,
          "#784 migration: @test/bar-ext must exist after migration",
        );
        assertEquals(
          localRows.length,
          0,
          "#784 migration: old @local/<repo> rows must be tombstoned",
        );
      },
    );
  },
});

Deno.test({
  name:
    "ReconcileFromDisk #784: migration with ≥10 sources does not hit guardrail",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, catalog, lockfileRepository }) => {
        const ts = Date.now();
        const fooDir = join(repoDir, "extensions", "models", "foo");
        const barDir = join(repoDir, "extensions", "models", "bar");
        await ensureDir(fooDir);
        await ensureDir(barDir);

        for (let i = 0; i < 6; i++) {
          await Deno.writeTextFile(
            join(fooDir, `model${i}.ts`),
            MINIMAL_MODEL_CODE(`@test/foo-g-${ts}-${i}`),
          );
          await Deno.writeTextFile(
            join(barDir, `model${i}.ts`),
            MINIMAL_MODEL_CODE(`@test/bar-g-${ts}-${i}`),
          );
        }

        // Phase 1: reconcile without manifests — all 12 files under
        // @local/<repo>. Exceeds GUARDRAIL_MIN_ROWS (10).
        const oldService = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });
        const first = await oldService.execute();
        assertEquals(first.applied, true);
        assertEquals(catalog.findAll().length, 12);

        // Phase 2: add manifests and reconcile. The migration must NOT
        // be blocked by the >50% guardrail.
        await Deno.writeTextFile(
          join(fooDir, "manifest.yaml"),
          stringifyYaml({
            manifestVersion: 1,
            name: "@test/foo-guard",
            version: "2026.06.01.1",
          }),
        );
        await Deno.writeTextFile(
          join(barDir, "manifest.yaml"),
          stringifyYaml({
            manifestVersion: 1,
            name: "@test/bar-guard",
            version: "2026.06.01.1",
          }),
        );

        const newRepo = new ExtensionRepository({
          catalog,
          lockfileRepository,
          repoRoot: repoDir,
        });
        const newService = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository: newRepo,
          lockfileRepository,
          repoDir,
        });
        const second = await newService.execute();
        assertEquals(
          second.applied,
          true,
          "#784: migration with ≥10 sources must not be blocked by guardrail",
        );

        const liveRows = catalog.findAll().filter((r) =>
          (r.state ?? "Indexed") !== "Tombstoned"
        );
        const fooRows = liveRows.filter((r) =>
          r.extension_name === "@test/foo-guard"
        );
        const barRows = liveRows.filter((r) =>
          r.extension_name === "@test/bar-guard"
        );

        assertEquals(
          fooRows.length,
          6,
          "#784: @test/foo-guard must have 6 rows",
        );
        assertEquals(
          barRows.length,
          6,
          "#784: @test/bar-guard must have 6 rows",
        );
      },
    );
  },
});

Deno.test({
  name:
    "ReconcileFromDisk #784: partial manifest adoption with ≥10 sources does not hit guardrail",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withFixtureRepo(
      async ({ repoDir, repository, catalog, lockfileRepository }) => {
        const ts = Date.now();
        const fooDir = join(repoDir, "extensions", "models", "foo");
        const barDir = join(repoDir, "extensions", "models", "bar");
        await ensureDir(fooDir);
        await ensureDir(barDir);

        for (let i = 0; i < 5; i++) {
          await Deno.writeTextFile(
            join(fooDir, `model${i}.ts`),
            MINIMAL_MODEL_CODE(`@test/foo-p-${ts}-${i}`),
          );
          await Deno.writeTextFile(
            join(barDir, `model${i}.ts`),
            MINIMAL_MODEL_CODE(`@test/bar-p-${ts}-${i}`),
          );
        }
        // 2 loose files that stay in @local/<repo>
        for (let i = 0; i < 2; i++) {
          await Deno.writeTextFile(
            join(repoDir, "extensions", "models", `loose${i}.ts`),
            MINIMAL_MODEL_CODE(`@test/loose-p-${ts}-${i}`),
          );
        }

        // Phase 1: all 12 files under @local/<repo>.
        const oldService = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });
        const first = await oldService.execute();
        assertEquals(first.applied, true);
        assertEquals(catalog.findAll().length, 12);

        // Phase 2: add manifests to foo/ and bar/ only — loose files
        // remain in the default partition (partial adoption).
        await Deno.writeTextFile(
          join(fooDir, "manifest.yaml"),
          stringifyYaml({
            manifestVersion: 1,
            name: "@test/foo-partial",
            version: "2026.06.01.1",
          }),
        );
        await Deno.writeTextFile(
          join(barDir, "manifest.yaml"),
          stringifyYaml({
            manifestVersion: 1,
            name: "@test/bar-partial",
            version: "2026.06.01.1",
          }),
        );

        const newRepo = new ExtensionRepository({
          catalog,
          lockfileRepository,
          repoRoot: repoDir,
        });
        const newService = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository: newRepo,
          lockfileRepository,
          repoDir,
        });
        const second = await newService.execute();
        assertEquals(
          second.applied,
          true,
          "#784: partial adoption with ≥10 sources must not be blocked by guardrail",
        );

        const liveRows = catalog.findAll().filter((r) =>
          (r.state ?? "Indexed") !== "Tombstoned"
        );
        const fooRows = liveRows.filter((r) =>
          r.extension_name === "@test/foo-partial"
        );
        const barRows = liveRows.filter((r) =>
          r.extension_name === "@test/bar-partial"
        );
        const localRows = liveRows.filter((r) =>
          r.extension_name === `@local/${pathBasename(repoDir)}`
        );

        assertEquals(
          fooRows.length,
          5,
          "#784: @test/foo-partial must have 5 rows",
        );
        assertEquals(
          barRows.length,
          5,
          "#784: @test/bar-partial must have 5 rows",
        );
        assertEquals(
          localRows.length,
          2,
          "#784: loose files must remain under @local/<repo>",
        );
      },
    );
  },
});

// -- managedConfig on an extension-backed datastore (swamp-club#2483) -------

const MINIMAL_DATASTORE_CODE = (typeId: string) => `
export const datastore = {
  type: "${typeId}",
  name: "Test Store",
  description: "A test datastore",
  createProvider: (_config: Record<string, unknown>) => ({
    createLock: (_datastorePath: string) => ({
      acquire: async () => {},
      release: async () => {},
      withLock: async (fn: () => Promise<unknown>) => fn(),
      inspect: async () => null,
      forceRelease: async (_nonce: string) => false,
    }),
    createVerifier: () => ({
      verify: async () => ({
        healthy: true,
        message: "ok",
        latencyMs: 1,
        datastoreType: "${typeId}",
      }),
    }),
    resolveDatastorePath: (repoDir: string) => repoDir,
  }),
};
`;

Deno.test(
  "ReconcileFromDisk pulled: additionalInstalledNames keeps an auto-resolved extension from being orphaned",
  async () => {
    const extName = `@test/auto-resolved-${crypto.randomUUID().slice(0, 8)}`;
    await withPulledFixtureRepo(
      async ({ repoDir, repository, catalog, lockfileRepository }) => {
        const extRoot = join(swampPath(repoDir, "pulled-extensions"), extName);
        catalog.upsertWithIdentity({
          source_path: join(extRoot, "models", "auto.ts"),
          type_normalized: `${extName}/auto`,
          kind: "model",
          bundle_path: "",
          version: "1.0.0",
          description: "",
          extends_type: "",
          source_mtime: "",
          source_fingerprint: "fp",
          state: "Indexed",
          extension_name: extName,
          extension_version: "1.0.0",
        });

        const service = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
          additionalInstalledNames: [extName],
        });
        const result = await service.execute({ dryRun: true });

        assertEquals(
          result.transitions.filter((t) => t.toState === "Tombstoned"),
          [],
        );
      },
      {},
    );
  },
);

Deno.test(
  "ReconcileFromDisk pulled: scanOnDiskDatastores keeps datastore rows left under the legacy root after migrate",
  async () => {
    const id = crypto.randomUUID().slice(0, 8);
    const extName = `@test/store-${id}`;
    const typeId = `@test/store-${id}`;
    const run = async (scanOnDiskDatastores: boolean) => {
      let unreadable = 0;
      await withPulledFixtureRepo(
        async ({ repoDir, repository, catalog, lockfileRepository }) => {
          // `datastore config migrate` leaves the pre-migrate copy under the
          // legacy root; the managed root is empty.
          const extRoot = join(
            swampPath(repoDir, "pulled-extensions"),
            extName,
          );
          await ensureDir(join(extRoot, "datastores"));
          await Deno.writeTextFile(
            join(extRoot, "manifest.yaml"),
            `manifestVersion: 1\nname: "${extName}"\nversion: "1.0.0"\n`,
          );
          const source = join(extRoot, "datastores", "store.ts");
          await Deno.writeTextFile(source, MINIMAL_DATASTORE_CODE(typeId));
          catalog.upsertWithIdentity({
            source_path: source,
            type_normalized: typeId,
            kind: "datastore",
            bundle_path: "",
            version: "1.0.0",
            description: "",
            extends_type: "",
            source_mtime: "",
            source_fingerprint: "fp",
            state: "Indexed",
            extension_name: extName,
            extension_version: "1.0.0",
          });

          const service = new ReconcileFromDiskService({
            denoRuntime: testDenoRuntime,
            repository,
            lockfileRepository,
            repoDir,
            pulledExtensionsRoot: swampPath(
              repoDir,
              "config",
              "pulled-extensions",
            ),
            scanOnDiskDatastores,
          });
          const result = await service.execute({ dryRun: true });
          unreadable =
            result.transitions.filter((t) =>
              t.toState === "EntryPointUnreadable"
            ).length;
        },
        { [extName]: { version: "1.0.0", files: [] } },
      );
      return unreadable;
    };

    assertEquals(await run(false) > 0, true, "control: rows are blanked");
    assertEquals(await run(true), 0, "scan: rows stay Indexed");
  },
);

Deno.test(
  "ReconcileFromDisk pulled: scanOnDiskDatastores does not tombstone datastore sources missing from the lockfile",
  async () => {
    const id = crypto.randomUUID().slice(0, 8);
    const extName = `@test/store-${id}`;
    const typeId = `@test/store-${id}`;
    const run = async (scanOnDiskDatastores: boolean) => {
      let tombstoned: string[] = [];
      await withPulledFixtureRepo(
        async ({ repoDir, repository, catalog, lockfileRepository }) => {
          // A teammate removed the extension from the shared lockfile, but
          // its sources are still on disk under the managed root.
          const extRoot = join(
            swampPath(repoDir, "config", "pulled-extensions"),
            extName,
          );
          await ensureDir(join(extRoot, "datastores"));
          await Deno.writeTextFile(
            join(extRoot, "manifest.yaml"),
            `manifestVersion: 1\nname: "${extName}"\nversion: "1.0.0"\n`,
          );
          const source = join(extRoot, "datastores", "store.ts");
          await Deno.writeTextFile(source, MINIMAL_DATASTORE_CODE(typeId));
          const row = {
            bundle_path: "",
            version: "1.0.0",
            description: "",
            extends_type: "",
            source_mtime: "",
            source_fingerprint: "fp",
            state: "Indexed",
            extension_name: extName,
            extension_version: "1.0.0",
          };
          catalog.upsertWithIdentity({
            ...row,
            source_path: source,
            type_normalized: typeId,
            kind: "datastore",
          });
          // Control: a model source of the same extension is not covered by
          // the datastore exemption and is still orphaned.
          catalog.upsertWithIdentity({
            ...row,
            source_path: join(extRoot, "models", "ghost.ts"),
            type_normalized: `${extName}/ghost`,
            kind: "model",
          });

          const service = new ReconcileFromDiskService({
            denoRuntime: testDenoRuntime,
            repository,
            lockfileRepository,
            repoDir,
            scanOnDiskDatastores,
          });
          const result = await service.execute({ dryRun: true });
          tombstoned = result.transitions
            .filter((t) => t.toState === "Tombstoned")
            .map((t) => pathBasename(t.source.canonicalPath))
            .sort();
        },
        {},
      );
      return tombstoned;
    };

    assertEquals(
      await run(false),
      ["ghost.ts", "store.ts"],
      "control: every orphaned source is tombstoned",
    );
    assertEquals(
      await run(true),
      ["ghost.ts"],
      "scan: the on-disk datastore source is kept",
    );
  },
);

// -- reconcileUncataloguedPulled (swamp-club#2355) --------------------------

/**
 * Stages a pulled model source plus its pre-built bundle, so reconcile's
 * bundleAndIndexOne takes the trusted-pulled cache path instead of
 * spawning `deno bundle`.
 */
async function stagePulledModel(
  repoDir: string,
  extName: string,
  fileBase: string,
  typeId: string,
): Promise<string> {
  const modelsDir = join(
    swampPath(repoDir, "pulled-extensions"),
    extName,
    "models",
  );
  await ensureDir(modelsDir);
  const sourcePath = join(modelsDir, `${fileBase}.ts`);
  await Deno.writeTextFile(sourcePath, MINIMAL_MODEL_CODE(typeId));
  const bundleDir = join(
    repoDir,
    ".swamp",
    "bundles",
    bundleNamespace(modelsDir, repoDir),
  );
  await ensureDir(bundleDir);
  await Deno.writeTextFile(
    join(bundleDir, `${fileBase}.js`),
    MINIMAL_MODEL_CODE(typeId),
  );
  return sourcePath;
}

function seedIndexedRow(
  catalog: ExtensionCatalogStore,
  args: { sourcePath: string; type: string; extensionName: string },
): void {
  catalog.upsertWithIdentity({
    source_path: canonicalizePath(args.sourcePath),
    type_normalized: args.type,
    kind: "model",
    bundle_path: "",
    version: "1.0.0",
    description: "",
    extends_type: "",
    source_mtime: "",
    source_fingerprint: "fp",
    state: "Indexed",
    extension_name: args.extensionName,
    extension_version: "1.0.0",
  });
}

function rowsUnder(catalog: ExtensionCatalogStore, prefix: string) {
  return catalog.findBySourcePathPrefix(canonicalizePath(prefix) + "/");
}

Deno.test(
  "reconcileUncataloguedPulled: catalogues a pulled extension that has no rows",
  async () => {
    const id = crypto.randomUUID();
    const extName = `@test/uncatalogued-${id}`;
    const typeId = `@test/uncatalogued-model-${id}`;
    await withPulledFixtureRepo(
      async ({ repoDir, repository, catalog, lockfileRepository }) => {
        const sourcePath = await stagePulledModel(
          repoDir,
          extName,
          "noop",
          typeId,
        );
        const service = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });

        const results = await service.reconcileUncataloguedPulled([extName]);

        assertEquals(results.map((r) => [r.name, r.status]), [
          [extName, "catalogued"],
        ]);
        const row = catalog.findBySourcePath(canonicalizePath(sourcePath));
        assertEquals(row?.type_normalized, typeId);
        assertEquals(row?.kind, "model");
        assertEquals(row?.extension_name, extName);
        assertEquals(row?.bundle_path.endsWith("noop.js"), true);
        assertEquals((row?.source_fingerprint ?? "").length > 0, true);
      },
      { [extName]: { version: "1.0.0", files: [] } },
    );
  },
);

Deno.test(
  "reconcileUncataloguedPulled: skips an extension that is already catalogued and leaves its rows unchanged",
  async () => {
    const id = crypto.randomUUID();
    const extName = `@test/already-${id}`;
    await withPulledFixtureRepo(
      async ({ repoDir, repository, catalog, lockfileRepository }) => {
        const extRoot = join(swampPath(repoDir, "pulled-extensions"), extName);
        // A second source on disk that the existing aggregate does not
        // know about: a full reconcile would index it, the scoped one
        // must not touch this extension at all.
        await stagePulledModel(repoDir, extName, "extra", `${extName}/extra`);
        seedIndexedRow(catalog, {
          sourcePath: join(extRoot, "models", "known.ts"),
          type: `${extName}/known`,
          extensionName: extName,
        });
        const before = rowsUnder(catalog, extRoot);

        const service = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });
        const results = await service.reconcileUncataloguedPulled([extName]);

        assertEquals(results.map((r) => [r.name, r.status]), [
          [extName, "skipped"],
        ]);
        assertEquals(rowsUnder(catalog, extRoot), before);
      },
      { [extName]: { version: "1.0.0", files: [] } },
    );
  },
);

Deno.test(
  "reconcileUncataloguedPulled: leaves other rows alone, tombstones no orphan and marks no kind populated",
  async () => {
    const id = crypto.randomUUID();
    const newExt = `@test/new-${id}`;
    const otherExt = `@test/other-${id}`;
    const orphanExt = `@test/orphan-${id}`;
    await withPulledFixtureRepo(
      async ({ repoDir, repository, catalog, lockfileRepository }) => {
        await stagePulledModel(repoDir, newExt, "noop", `${newExt}/noop`);
        const localPath = join(repoDir, "extensions", "models", "local.ts");
        await Deno.writeTextFile(
          localPath,
          MINIMAL_MODEL_CODE(`@test/local-${id}`),
        );
        seedIndexedRow(catalog, {
          sourcePath: localPath,
          type: `@test/local-${id}`,
          extensionName: `@local/${id}`,
        });
        const pulledRoot = swampPath(repoDir, "pulled-extensions");
        seedIndexedRow(catalog, {
          sourcePath: join(pulledRoot, otherExt, "models", "other.ts"),
          type: `${otherExt}/other`,
          extensionName: otherExt,
        });
        // In the catalog but not in the lockfile: a full reconcile
        // tombstones this as an orphan.
        seedIndexedRow(catalog, {
          sourcePath: join(pulledRoot, orphanExt, "models", "ghost.ts"),
          type: `${orphanExt}/ghost`,
          extensionName: orphanExt,
        });
        const untouched = () => [
          catalog.findBySourcePath(canonicalizePath(localPath)),
          ...rowsUnder(catalog, join(pulledRoot, otherExt)),
          ...rowsUnder(catalog, join(pulledRoot, orphanExt)),
        ];
        const before = untouched();

        const service = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });
        const results = await service.reconcileUncataloguedPulled([newExt]);

        assertEquals(results.map((r) => r.status), ["catalogued"]);
        assertEquals(untouched(), before);
        for (
          const kind of [
            "model",
            "vault",
            "datastore",
            "report",
            "webhook",
          ] as const
        ) {
          assertEquals(
            catalog.isPopulated(kind),
            false,
            `scoped reconcile must not mark ${kind} populated`,
          );
        }
      },
      {
        [newExt]: { version: "1.0.0", files: [] },
        [otherExt]: { version: "1.0.0", files: [] },
      },
    );
  },
);

Deno.test(
  "reconcileUncataloguedPulled: a large new extension is not blocked by the >50% guardrail",
  async () => {
    const id = crypto.randomUUID();
    const existingExt = `@test/existing-${id}`;
    const bigExt = `@test/big-${id}`;
    await withPulledFixtureRepo(
      async ({ repoDir, repository, catalog, lockfileRepository }) => {
        const pulledRoot = swampPath(repoDir, "pulled-extensions");
        // Ten existing rows puts the catalog over the guardrail's minimum.
        for (let i = 0; i < 10; i++) {
          seedIndexedRow(catalog, {
            sourcePath: join(pulledRoot, existingExt, "models", `m${i}.ts`),
            type: `${existingExt}/m${i}`,
            extensionName: existingExt,
          });
        }
        for (let i = 0; i < 12; i++) {
          await stagePulledModel(repoDir, bigExt, `s${i}`, `${bigExt}/s${i}`);
        }

        const service = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });
        const results = await service.reconcileUncataloguedPulled([bigExt]);

        assertEquals(results.map((r) => r.status), ["catalogued"]);
        assertEquals(rowsUnder(catalog, join(pulledRoot, bigExt)).length, 12);
      },
      {
        [existingExt]: { version: "1.0.0", files: [] },
        [bigExt]: { version: "1.0.0", files: [] },
      },
    );
  },
);

Deno.test(
  "reconcileUncataloguedPulled: a type conflict fails only that extension",
  async () => {
    const id = crypto.randomUUID();
    const ownerExt = `@test/owner-${id}`;
    const clashExt = `@test/clash-${id}`;
    const okExt = `@test/ok-${id}`;
    const takenType = `@test/taken-${id}`;
    await withPulledFixtureRepo(
      async ({ repoDir, repository, catalog, lockfileRepository }) => {
        const pulledRoot = swampPath(repoDir, "pulled-extensions");
        seedIndexedRow(catalog, {
          sourcePath: join(pulledRoot, ownerExt, "models", "taken.ts"),
          type: takenType,
          extensionName: ownerExt,
        });
        await stagePulledModel(repoDir, clashExt, "taken", takenType);
        await stagePulledModel(repoDir, okExt, "noop", `${okExt}/noop`);

        const service = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });
        const results = await service.reconcileUncataloguedPulled([
          clashExt,
          okExt,
        ]);

        const byName = new Map(results.map((r) => [r.name, r]));
        const clash = byName.get(clashExt);
        assertEquals(clash?.status, "failed");
        assertEquals(
          clash?.status === "failed" &&
            clash.error instanceof DuplicateTypeError,
          true,
        );
        assertEquals(rowsUnder(catalog, join(pulledRoot, clashExt)), []);
        assertEquals(byName.get(okExt)?.status, "catalogued");
        assertEquals(rowsUnder(catalog, join(pulledRoot, okExt)).length, 1);
      },
      {
        [ownerExt]: { version: "1.0.0", files: [] },
        [clashExt]: { version: "1.0.0", files: [] },
        [okExt]: { version: "1.0.0", files: [] },
      },
    );
  },
);

Deno.test(
  "reconcileUncataloguedPulled: keeps a source-mounted row outside the repo root",
  async () => {
    const id = crypto.randomUUID();
    const newExt = `@test/new-${id}`;
    const mountDir = await Deno.makeTempDir({ prefix: "swamp_2355_mount_" });
    try {
      await withPulledFixtureRepo(
        async ({ repoDir, repository, catalog, lockfileRepository }) => {
          // Mounted through .swamp-sources.yaml from outside the repo root.
          const mountedPath = join(mountDir, "mounted.ts");
          await Deno.writeTextFile(
            mountedPath,
            MINIMAL_MODEL_CODE(`@test/mounted-${id}`),
          );
          seedIndexedRow(catalog, {
            sourcePath: mountedPath,
            type: `@test/mounted-${id}`,
            extensionName: `@local/${id}`,
          });
          const before = catalog.findBySourcePath(
            canonicalizePath(mountedPath),
          );
          await stagePulledModel(repoDir, newExt, "noop", `${newExt}/noop`);

          const service = new ReconcileFromDiskService({
            denoRuntime: testDenoRuntime,
            repository,
            lockfileRepository,
            repoDir,
          });
          const results = await service.reconcileUncataloguedPulled([newExt]);

          assertEquals(results.map((r) => r.status), ["catalogued"]);
          assertEquals(
            catalog.findBySourcePath(canonicalizePath(mountedPath)),
            before,
            "the scoped save must not prune a live out-of-root source",
          );
        },
        { [newExt]: { version: "1.0.0", files: [] } },
      );
    } finally {
      await Deno.remove(mountDir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "selectUncataloguedPulled: keeps rowless lockfile entries, drops catalogued names and names without a lockfile entry",
  async () => {
    const id = crypto.randomUUID();
    const rowless = `@test/rowless-${id}`;
    const elsewhere = `@test/elsewhere-${id}`;
    const unlisted = `@test/unlisted-${id}`;
    await withPulledFixtureRepo(
      async ({ repoDir, repository, catalog, lockfileRepository }) => {
        // Catalogued, but its rows live under another root, so a prefix
        // check on pulled-extensions/<name>/ alone would call it
        // uncatalogued.
        seedIndexedRow(catalog, {
          sourcePath: join(repoDir, ".swamp", "other-root", elsewhere, "x.ts"),
          type: `${elsewhere}/x`,
          extensionName: elsewhere,
        });
        await stagePulledModel(repoDir, rowless, "noop", `${rowless}/noop`);

        const service = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });

        assertEquals(
          service.selectUncataloguedPulled([rowless, elsewhere, unlisted]),
          [rowless],
        );
        const results = await service.reconcileUncataloguedPulled([
          rowless,
          elsewhere,
          unlisted,
        ]);
        assertEquals(
          results.map((r) => [r.name, r.status]),
          [[rowless, "catalogued"], [elsewhere, "skipped"], [
            unlisted,
            "skipped",
          ]],
          "reconcileUncataloguedPulled applies the same criterion",
        );
      },
      {
        [rowless]: { version: "1.0.0", files: [] },
        [elsewhere]: { version: "1.0.0", files: [] },
      },
    );
  },
);

Deno.test(
  "reconcileUncataloguedPulled: an entry with no entry-point sources is skipped, not catalogued",
  async () => {
    const id = crypto.randomUUID();
    const helperOnly = `@test/helper-only-${id}`;
    await withPulledFixtureRepo(
      async ({ repoDir, repository, catalog, lockfileRepository }) => {
        const libDir = join(
          swampPath(repoDir, "pulled-extensions"),
          helperOnly,
          "models",
          "_lib",
        );
        await ensureDir(libDir);
        await Deno.writeTextFile(
          join(libDir, "helper.ts"),
          "export const helper = () => 1;\n",
        );

        const service = new ReconcileFromDiskService({
          denoRuntime: testDenoRuntime,
          repository,
          lockfileRepository,
          repoDir,
        });
        const results = await service.reconcileUncataloguedPulled([
          helperOnly,
        ]);

        assertEquals(results, [{
          name: helperOnly,
          status: "skipped",
          reason: "no entry-point sources on disk",
        }]);
        assertEquals(
          rowsUnder(
            catalog,
            join(swampPath(repoDir, "pulled-extensions"), helperOnly),
          ),
          [],
        );
      },
      { [helperOnly]: { version: "1.0.0", files: [] } },
    );
  },
);
