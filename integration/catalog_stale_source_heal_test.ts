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

// Stale extension-catalog rows after a managedConfig migration and an
// `extension rm` (swamp-club#2490). `datastore config migrate` copies the
// pulled tree instead of moving it, `extension install` re-extracts into
// `.swamp/config/pulled-extensions/` and deletes the old sources without
// touching the catalog, and `extension rm` could not identify rows under
// the managed root. These tests wire the real loader, repository, catalog
// and migration together on a temp filesystem and assert that no stale
// row survives, crashes a type load, or blocks a later save.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { dirname, join } from "@std/path";
import { ensureDir } from "@std/fs";
import { ExtensionLoader } from "../src/domain/extensions/extension_loader.ts";
import { modelKindAdapter } from "../src/domain/extensions/model_kind_adapter.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { migrateConfigToDatastore } from "../src/domain/datastore/managed_config_migration.ts";
import { RemoveExtensionService } from "../src/libswamp/extensions/remove_extension_service.ts";
import { canonicalizePath } from "../src/infrastructure/persistence/canonicalize_path.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import {
  registerManagedConfig,
  swampPath,
} from "../src/infrastructure/persistence/paths.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";

import "../src/domain/models/models.ts";

const testDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
  getDenoEnv: () => Deno.env.toObject(),
};

const MODEL_CODE = (type: string) => `
import { z } from "npm:zod@4";

export const model = {
  type: "${type}",
  version: "2026.05.05.1",
  globalArguments: z.object({}),
  resources: {},
  methods: {
    noop: {
      description: "noop",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

interface Repo {
  repoDir: string;
  modelsDir: string;
  type: string;
  catalog: ExtensionCatalogStore;
}

/** A repo whose catalog lives for the whole test; loaders and
 *  repositories are built per step, as each CLI command builds its own. */
async function withRepo(fn: (repo: Repo) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_2490_" });
  const modelsDir = join(repoDir, "extensions", "models");
  await ensureDir(modelsDir);
  await ensureDir(join(repoDir, ".swamp"));
  const type = `@test/stale-${crypto.randomUUID().slice(0, 8)}`;
  const catalog = new ExtensionCatalogStore(
    join(repoDir, ".swamp", "_extension_catalog.db"),
  );
  try {
    await fn({ repoDir, modelsDir, type, catalog });
  } finally {
    catalog.close();
    modelRegistry.invalidateType(type);
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

function pulledModelPath(root: string, name: string): string {
  return join(root, name, "models", "report_definition.ts");
}

async function writeModel(path: string, type: string): Promise<void> {
  await ensureDir(dirname(path));
  await Deno.writeTextFile(path, MODEL_CODE(type));
}

async function repositoryFor(
  repo: Repo,
  lockfilePath: string,
): Promise<{
  repository: ExtensionRepository;
  lockfileRepository: LockfileRepository;
}> {
  const lockfileRepository = await LockfileRepository.create(lockfilePath);
  return {
    lockfileRepository,
    repository: new ExtensionRepository({
      catalog: repo.catalog,
      lockfileRepository,
      repoRoot: repo.repoDir,
    }),
  };
}

function loaderFor(repo: Repo, repository: ExtensionRepository) {
  return new ExtensionLoader(
    testDenoRuntime,
    modelKindAdapter,
    repo.repoDir,
    undefined,
    repository,
  );
}

function typedRows(repo: Repo): string[] {
  return repo.catalog.findAllByType(repo.type, "model").map((r) =>
    r.source_path
  );
}

/**
 * Pull, migrate, install: the reproduction from swamp-club#2490 up to the
 * point where the old sources are gone but their catalog row is not.
 * Returns the managed-root source and lockfile paths.
 */
async function pullMigrateInstall(
  repo: Repo,
  name: string,
): Promise<{ managedSource: string; managedLockfile: string }> {
  const legacyRoot = swampPath(repo.repoDir, "pulled-extensions");
  const legacySource = pulledModelPath(legacyRoot, name);
  const legacyLockfile = join(repo.modelsDir, "upstream_extensions.json");

  // Pull while managedConfig is false.
  registerManagedConfig(repo.repoDir, false);
  await writeModel(legacySource, repo.type);
  const legacy = await repositoryFor(repo, legacyLockfile);
  await legacy.lockfileRepository.writeEntry(name, "1.0.0", [
    `.swamp/pulled-extensions/${name}/models/report_definition.ts`,
  ]);
  await loaderFor(repo, legacy.repository).buildIndex(repo.modelsDir, {
    additionalDirs: [dirname(legacySource)],
    indexOnly: true,
  });
  assertEquals(typedRows(repo), [canonicalizePath(legacySource)]);

  // `datastore config migrate` copies the tree and lockfile verbatim.
  const configRoot = join(repo.repoDir, "datastore", "config");
  await migrateConfigToDatastore(
    repo.repoDir,
    legacyLockfile,
    configRoot,
    legacyRoot,
  );
  registerManagedConfig(repo.repoDir, true, configRoot);

  // `extension install` re-extracts under the managed root, rewrites the
  // lockfile entry and prunes the old sources — without the catalog.
  const managedRoot = swampPath(repo.repoDir, "config", "pulled-extensions");
  const managedSource = pulledModelPath(managedRoot, name);
  await writeModel(managedSource, repo.type);
  const managedLockfile = join(configRoot, "upstream_extensions.json");
  const managed = await LockfileRepository.create(managedLockfile);
  await managed.writeEntry(name, "1.0.0", [
    `.swamp/config/pulled-extensions/${name}/models/report_definition.ts`,
  ]);
  await Deno.remove(join(legacyRoot, name), { recursive: true });

  return { managedSource, managedLockfile };
}

Deno.test("catalog heal: a type loads from the managed root after migrate and install", async () => {
  await withRepo(async (repo) => {
    const name = "@test/cur";
    const { managedSource, managedLockfile } = await pullMigrateInstall(
      repo,
      name,
    );

    const { repository } = await repositoryFor(repo, managedLockfile);
    const loader = loaderFor(repo, repository);
    // The pulled dirs moved, so this is the cold path.
    await loader.buildIndex(repo.modelsDir, {
      additionalDirs: [dirname(managedSource)],
      indexOnly: true,
    });

    // The old row is gone, not merely typeless.
    assertEquals(repo.catalog.findAll().map((r) => r.source_path), [
      canonicalizePath(managedSource),
    ]);
    await loader.loadSingleType(repo.type);
    assertEquals(modelRegistry.get(repo.type) !== undefined, true);
  });
});

Deno.test("catalog heal: a stale row is dropped at type-load time instead of crashing", async () => {
  await withRepo(async (repo) => {
    const name = "@test/cur";
    const { managedSource, managedLockfile } = await pullMigrateInstall(
      repo,
      name,
    );
    const legacySource = canonicalizePath(
      pulledModelPath(swampPath(repo.repoDir, "pulled-extensions"), name),
    );

    // Load the type straight from the stale row, before any index pass.
    const { repository } = await repositoryFor(repo, managedLockfile);
    const loader = loaderFor(repo, repository);
    await loader.loadSingleType(repo.type, {
      bundlePath: repo.catalog.findBySourcePath(legacySource)!.bundle_path,
      sourcePath: legacySource,
    });

    assertEquals(typedRows(repo), []);
    assertEquals(modelRegistry.get(repo.type), undefined);

    // The next index pass finds the live source.
    await loader.buildIndex(repo.modelsDir, {
      additionalDirs: [dirname(managedSource)],
      indexOnly: true,
    });
    assertEquals(typedRows(repo), [canonicalizePath(managedSource)]);
  });
});

Deno.test("catalog heal: extension rm leaves no managed-root row behind", async () => {
  await withRepo(async (repo) => {
    const name = "@test/cur";
    const { managedSource, managedLockfile } = await pullMigrateInstall(
      repo,
      name,
    );
    const { repository, lockfileRepository } = await repositoryFor(
      repo,
      managedLockfile,
    );
    await loaderFor(repo, repository).buildIndex(repo.modelsDir, {
      additionalDirs: [dirname(managedSource)],
      indexOnly: true,
    });

    await new RemoveExtensionService({
      repository,
      lockfileRepository,
      repoDir: repo.repoDir,
    }).execute(name);

    assertEquals(repo.catalog.findAll(), []);
    const after = await repositoryFor(repo, managedLockfile);
    await assertRejects(
      () => loaderFor(repo, after.repository).loadSingleType(repo.type),
      Error,
      "No catalog entry",
    );
  });
});

Deno.test("catalog heal: saveAll drops a copied old-root duplicate instead of failing I-Repo-1", async () => {
  await withRepo(async (repo) => {
    const name = "@test/cur";
    const { managedSource, managedLockfile } = await pullMigrateInstall(
      repo,
      name,
    );
    const { repository } = await repositoryFor(repo, managedLockfile);
    await loaderFor(repo, repository).buildIndex(repo.modelsDir, {
      additionalDirs: [dirname(managedSource)],
      indexOnly: true,
    });

    // A remote datastore's migrate leaves the old tree in place, so the old
    // row's source still exists and shares the type with the new row.
    const legacySource = pulledModelPath(
      swampPath(repo.repoDir, "pulled-extensions"),
      name,
    );
    await writeModel(legacySource, repo.type);
    const live = repo.catalog.findBySourcePath(managedSource)!;
    repo.catalog.upsertWithIdentity({
      ...live,
      source_path: canonicalizePath(legacySource),
      extension_name: name,
      extension_version: "1.0.0",
    });

    repository.saveAll([]);
    assertEquals(typedRows(repo), [canonicalizePath(managedSource)]);
  });
});

Deno.test("catalog heal: a warm pass restores a type a stale local row had cleared", async () => {
  await withRepo(async (repo) => {
    const name = "@test/cur";
    const { managedSource, managedLockfile } = await pullMigrateInstall(
      repo,
      name,
    );
    const { repository } = await repositoryFor(repo, managedLockfile);
    const dirs = {
      additionalDirs: [dirname(managedSource)],
      indexOnly: true,
    };
    await loaderFor(repo, repository).buildIndex(repo.modelsDir, dirs);

    // A catalog damaged before the upgrade: a stale local-origin row claims
    // the type, the pulled row's type was cleared, and the heal never ran.
    const pulled = canonicalizePath(managedSource);
    repo.catalog.upsert({
      ...repo.catalog.findBySourcePath(managedSource)!,
      source_path: canonicalizePath(
        join(repo.repoDir, "gone", "extensions", "models", "old.ts"),
      ),
    });
    repo.catalog.setTypeNormalized(pulled, "");
    assertEquals(typedRows(repo).includes(pulled), false);

    await loaderFor(repo, repository).buildIndex(repo.modelsDir, dirs);

    assertEquals(typedRows(repo), [pulled]);
    assertEquals(repo.catalog.isTypelessHealDone("model"), true);
  });
});

Deno.test("catalog heal: two pulled rows never end up sharing a type", async () => {
  await withRepo(async (repo) => {
    registerManagedConfig(repo.repoDir, false);
    const lockfilePath = join(repo.modelsDir, "upstream_extensions.json");
    const root = swampPath(repo.repoDir, "pulled-extensions");
    const first = pulledModelPath(root, "@test/aa");
    const second = pulledModelPath(root, "@test/zz");
    const local = join(repo.modelsDir, "override.ts");
    for (const path of [first, second, local]) {
      await writeModel(path, repo.type);
    }
    // An unrelated extension whose models are indexed after the loser's.
    const sibling = pulledModelPath(root, "@test/zzz");
    await writeModel(sibling, `${repo.type}-sibling`);
    const { repository, lockfileRepository } = await repositoryFor(
      repo,
      lockfilePath,
    );
    for (const name of ["@test/aa", "@test/zz", "@test/zzz"]) {
      await lockfileRepository.writeEntry(name, "1.0.0", [
        `.swamp/pulled-extensions/${name}/models/report_definition.ts`,
      ]);
    }
    const dirs = {
      additionalDirs: [dirname(first), dirname(second), dirname(sibling)],
      indexOnly: true,
    };

    // Cold pass: the local override is the only claimant.
    await loaderFor(repo, repository).buildIndex(repo.modelsDir, dirs);
    assertEquals(typedRows(repo), [canonicalizePath(local)]);

    // Deleting an unrelated typed row re-arms the heal, which must not
    // restore a type the override still holds.
    const unrelated = join(repo.modelsDir, "unrelated.ts");
    await writeModel(unrelated, `${repo.type}-unrelated`);
    await loaderFor(repo, repository).buildIndex(repo.modelsDir, dirs);
    await Deno.remove(unrelated);
    await loaderFor(repo, repository).buildIndex(repo.modelsDir, dirs);
    assertEquals(typedRows(repo), [canonicalizePath(local)]);

    // Removing the override restores exactly one pulled row, by path.
    await Deno.remove(local);
    await loaderFor(repo, repository).buildIndex(repo.modelsDir, dirs);
    assertEquals(typedRows(repo), [canonicalizePath(first)]);
    repository.saveAll([]);

    // Rebundling the loser must not type it again, even when another
    // extension's file fails later in the same pass and its failure is
    // saved mid-pass, before the pass settles conflicts.
    await Deno.remove(repo.catalog.findBySourcePath(second)!.bundle_path);
    await Deno.remove(repo.catalog.findBySourcePath(sibling)!.bundle_path);
    await Deno.writeTextFile(sibling, "export const model = {");
    await loaderFor(repo, repository).buildIndex(repo.modelsDir, dirs);
    assertEquals(typedRows(repo), [canonicalizePath(first)]);
    repository.saveAll([]);
  });
});

/**
 * `@swamp/aws/cur` is pulled and indexed first; `@aaa/cur`, whose path
 * sorts first, is pulled later with the same type. Returns both sources.
 */
async function pullIncumbentThenRival(
  repo: Repo,
  repository: ExtensionRepository,
  lockfileRepository: LockfileRepository,
): Promise<{ incumbent: string; rival: string; dirs: string[] }> {
  registerManagedConfig(repo.repoDir, false);
  const root = swampPath(repo.repoDir, "pulled-extensions");
  const incumbent = pulledModelPath(root, "@swamp/aws/cur");
  const rival = pulledModelPath(root, "@aaa/cur");
  for (const name of ["@swamp/aws/cur", "@aaa/cur"]) {
    await lockfileRepository.writeEntry(name, "1.0.0", [
      `.swamp/pulled-extensions/${name}/models/report_definition.ts`,
    ]);
  }
  await writeModel(incumbent, repo.type);
  await loaderFor(repo, repository).buildIndex(repo.modelsDir, {
    additionalDirs: [dirname(incumbent)],
    indexOnly: true,
  });
  assertEquals(typedRows(repo), [canonicalizePath(incumbent)]);
  await writeModel(rival, repo.type);
  return {
    incumbent,
    rival,
    dirs: [dirname(incumbent), dirname(rival)],
  };
}

Deno.test("catalog heal: a later pull never takes a type from the pulled extension that holds it", async () => {
  await withRepo(async (repo) => {
    const { repository, lockfileRepository } = await repositoryFor(
      repo,
      join(repo.modelsDir, "upstream_extensions.json"),
    );
    const { incumbent, dirs } = await pullIncumbentThenRival(
      repo,
      repository,
      lockfileRepository,
    );

    await loaderFor(repo, repository).buildIndex(repo.modelsDir, {
      additionalDirs: dirs,
      indexOnly: true,
    });
    assertEquals(typedRows(repo), [canonicalizePath(incumbent)]);
    repository.saveAll([]);
  });
});

Deno.test("catalog heal: a catalog with both pulled rows typed keeps the first and names both", async () => {
  await withRepo(async (repo) => {
    const { repository, lockfileRepository } = await repositoryFor(
      repo,
      join(repo.modelsDir, "upstream_extensions.json"),
    );
    const { incumbent, rival, dirs } = await pullIncumbentThenRival(
      repo,
      repository,
      lockfileRepository,
    );
    await loaderFor(repo, repository).buildIndex(repo.modelsDir, {
      additionalDirs: dirs,
      indexOnly: true,
    });
    // What an older binary left behind: both rows typed.
    repo.catalog.setTypeNormalized(canonicalizePath(rival), repo.type);

    const records: LogRecord[] = [];
    await configure({
      sinks: { capture: (record: LogRecord) => records.push(record) },
      loggers: [
        { category: ["swamp"], lowestLevel: "warning", sinks: ["capture"] },
        { category: ["logtape", "meta"], lowestLevel: "warning", sinks: [] },
      ],
      reset: true,
    });
    try {
      await loaderFor(repo, repository).buildIndex(repo.modelsDir, {
        additionalDirs: dirs,
        indexOnly: true,
      });
    } finally {
      await reset();
    }

    assertEquals(typedRows(repo), [canonicalizePath(incumbent)]);
    repository.saveAll([]);
    const warnings = records.map((r) => r.message.map(String).join(""))
      .filter((m) => m.includes("both provide"));
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0], "Extensions @swamp/aws/cur and @aaa/cur");
    assertStringIncludes(warnings[0], `swamp extension rm @swamp/aws/cur`);
  });
});

/** Imports cleanly but fails schema validation: `version` is missing. */
const BROKEN_MODEL_CODE = (type: string) =>
  MODEL_CODE(type).replace(`  version: "2026.05.05.1",\n`, "");

interface Override {
  local: string;
  pulled: string;
  unrelated: string;
  repository: ExtensionRepository;
  warmPass: () => Promise<void>;
}

/**
 * A pulled model and a local override of the same type, indexed cold so
 * the override is the only claimant, then warm-passed with an unrelated
 * typed local model so the typeless-row heal has run and set its marker.
 * Deleting `unrelated` re-arms the heal.
 */
async function withIndexedOverride(repo: Repo): Promise<Override> {
  registerManagedConfig(repo.repoDir, false);
  const lockfilePath = join(repo.modelsDir, "upstream_extensions.json");
  const name = "@test/upstream";
  const pulled = pulledModelPath(
    swampPath(repo.repoDir, "pulled-extensions"),
    name,
  );
  const local = join(repo.modelsDir, "override.ts");
  await writeModel(pulled, repo.type);
  await writeModel(local, repo.type);
  const { repository, lockfileRepository } = await repositoryFor(
    repo,
    lockfilePath,
  );
  await lockfileRepository.writeEntry(name, "1.0.0", [
    `.swamp/pulled-extensions/${name}/models/report_definition.ts`,
  ]);
  const dirs = { additionalDirs: [dirname(pulled)], indexOnly: true };
  const warmPass = async () => {
    await loaderFor(repo, repository).buildIndex(repo.modelsDir, dirs);
  };

  await warmPass();
  assertEquals(typedRows(repo), [canonicalizePath(local)]);
  const unrelated = join(repo.modelsDir, "unrelated.ts");
  await writeModel(unrelated, `${repo.type}-unrelated`);
  await warmPass();
  assertEquals(repo.catalog.isTypelessHealDone("model"), true);
  assertEquals(typedRows(repo), [canonicalizePath(local)]);

  return { local, pulled, unrelated, repository, warmPass };
}

Deno.test("catalog heal: a broken local override does not hand its type to the pulled extension", async () => {
  await withRepo(async (repo) => {
    const { local, unrelated, repository, warmPass } =
      await withIndexedOverride(repo);

    // The override breaks while the heal is already done.
    await Deno.writeTextFile(local, BROKEN_MODEL_CODE(repo.type));
    await warmPass();
    assertEquals(
      repo.catalog.findBySourcePath(local)?.state,
      "ValidationFailed",
    );
    assertEquals(typedRows(repo), []);

    // Re-arming the heal must not give the type to the shadowed pulled row.
    await Deno.remove(unrelated);
    await warmPass();
    assertEquals(typedRows(repo), []);
    assertEquals(repo.catalog.isTypelessHealDone("model"), false);
    await assertRejects(
      () => loaderFor(repo, repository).loadSingleType(repo.type),
      Error,
      "No catalog entry",
    );

    // Fixing the override lets the heal finish, with the override winning.
    await writeModel(local, repo.type);
    await warmPass();
    assertEquals(typedRows(repo), [canonicalizePath(local)]);
    assertEquals(repo.catalog.isTypelessHealDone("model"), true);
  });
});

Deno.test("catalog heal: a local override that fails in the same pass still blocks the heal", async () => {
  await withRepo(async (repo) => {
    const { local, unrelated, warmPass } = await withIndexedOverride(repo);

    await Deno.writeTextFile(local, BROKEN_MODEL_CODE(repo.type));
    await Deno.remove(unrelated);
    await warmPass();

    assertEquals(
      repo.catalog.findBySourcePath(local)?.state,
      "ValidationFailed",
    );
    assertEquals(typedRows(repo), []);
    assertEquals(repo.catalog.isTypelessHealDone("model"), false);
  });
});

Deno.test("catalog heal: deleting a broken local override lets the pulled type back", async () => {
  await withRepo(async (repo) => {
    const { local, pulled, unrelated, warmPass } = await withIndexedOverride(
      repo,
    );
    await Deno.writeTextFile(local, BROKEN_MODEL_CODE(repo.type));
    await Deno.remove(unrelated);
    await warmPass();
    assertEquals(typedRows(repo), []);

    await Deno.remove(local);
    await warmPass();

    assertEquals(typedRows(repo), [canonicalizePath(pulled)]);
    assertEquals(repo.catalog.isTypelessHealDone("model"), true);
  });
});

Deno.test("catalog heal: the heal restores a type to a local row before a pulled one", async () => {
  await withRepo(async (repo) => {
    const { local, warmPass } = await withIndexedOverride(repo);
    // A second local override sorts after the first, so it is left
    // typeless; the pulled row is typeless too. Both could take the type
    // back once the first override is gone, and `.swamp/` sorts before
    // `extensions/`, so path order alone would pick the pulled row.
    const second = join(repo.modelsDir, "override2.ts");
    await writeModel(second, repo.type);
    await warmPass();
    assertEquals(typedRows(repo), [canonicalizePath(local)]);

    await Deno.remove(local);
    await warmPass();

    assertEquals(typedRows(repo), [canonicalizePath(second)]);
  });
});

Deno.test("catalog heal: an override that changes its type gives the old one back", async () => {
  await withRepo(async (repo) => {
    const { local, pulled, warmPass } = await withIndexedOverride(repo);
    modelRegistry.invalidateType(`${repo.type}-unrelated`);

    // No row is deleted: the override's row is upserted with a new type.
    await writeModel(local, `${repo.type}-v2`);
    await warmPass();

    assertEquals(typedRows(repo), [canonicalizePath(pulled)]);
    assertEquals(
      repo.catalog.findBySourcePath(local)?.type_normalized,
      `${repo.type}-v2`,
    );
    modelRegistry.invalidateType(`${repo.type}-v2`);
  });
});

Deno.test("catalog heal: a type moved to an earlier file in one upgrade stays available", async () => {
  await withRepo(async (repo) => {
    registerManagedConfig(repo.repoDir, false);
    const name = "@test/ext";
    const modelsDir = join(
      swampPath(repo.repoDir, "pulled-extensions"),
      name,
      "models",
    );
    const oldFile = join(modelsDir, "z_old.ts");
    const newFile = join(modelsDir, "a_new.ts");
    const { repository, lockfileRepository } = await repositoryFor(
      repo,
      join(repo.modelsDir, "upstream_extensions.json"),
    );
    await lockfileRepository.writeEntry(name, "1.0.0", [
      `.swamp/pulled-extensions/${name}/models/a_new.ts`,
      `.swamp/pulled-extensions/${name}/models/z_old.ts`,
    ]);
    const dirs = { additionalDirs: [modelsDir], indexOnly: true };
    const pass = async () => {
      await loaderFor(repo, repository).buildIndex(repo.modelsDir, dirs);
    };
    const moved = `${repo.type}-v2`;
    try {
      await writeModel(oldFile, repo.type);
      await pass();
      await pass();
      assertEquals(repo.catalog.isTypelessHealDone("model"), true);
      assertEquals(typedRows(repo), [canonicalizePath(oldFile)]);

      // The upgrade moves the type to a file that sorts first and gives
      // the old file a new type. The new file is rebundled while the old
      // row still holds the type, so it is written typeless at first.
      await writeModel(newFile, repo.type);
      await writeModel(oldFile, moved);
      await pass();

      assertEquals(typedRows(repo), [canonicalizePath(newFile)]);
      assertEquals(
        repo.catalog.findBySourcePath(oldFile)?.type_normalized,
        moved,
      );
    } finally {
      modelRegistry.invalidateType(moved);
    }
  });
});
