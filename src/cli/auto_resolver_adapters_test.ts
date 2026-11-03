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
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import {
  AUTO_RESOLVE_INSTALL_DEADLINE_MS,
  createAutoResolveInstallerAdapter,
  EXTENSION_INSTALL_LOCK_MAX_WAIT_MS,
  hotLoadDatastoreDirs,
  isBundleArtifactPath,
  isPulledSkillPath,
} from "./auto_resolver_adapters.ts";
import { createTarGz } from "../infrastructure/archive/tar_archive.ts";
import { computeChecksum } from "../domain/models/checksum.ts";
import type { ExtensionArchiveCache } from "../domain/extensions/extension_archive_cache.ts";
import type { DenoRuntime } from "../domain/runtime/deno_runtime.ts";
import { ExtensionCatalogStore } from "../infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../infrastructure/persistence/lockfile_repository.ts";
import { PathTraversalError } from "../infrastructure/persistence/safe_path.ts";
import { canonicalizePath } from "../infrastructure/persistence/canonicalize_path.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../infrastructure/persistence/paths.ts";
import { modelRegistry } from "../domain/models/model.ts";
import { ModelType } from "../domain/models/model_type.ts";
import type { ModelDefinition } from "../domain/models/model.ts";
import { z } from "zod";

// import the models barrel so command/shell is registered and does not collide
// with user-fixture registrations
import "../domain/models/models.ts";

// bundling fails cleanly against a bogus path and is recorded in
// `result.failed`; the tests care about the enumerate to primary/rest plumbing,
// not bundling
const stubDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve("/usr/bin/false"),
  getDenoEnv: () => Deno.env.toObject(),
};

const stubCallbacks = {
  getExtension: () => Promise.resolve(null),
  downloadArchive: () =>
    Promise.reject(new Error("not used in hot-load tests")),
  getChecksum: () => Promise.resolve(null),
};

function makeRepoForCatalog(
  catalog: ExtensionCatalogStore,
  repoRoot: string,
): ExtensionRepository {
  return new ExtensionRepository({
    catalog,
    lockfileRepository: new LockfileRepository(
      "/test/repo/upstream_extensions.json",
      {},
    ),
    repoRoot,
  });
}

async function seedLockfile(
  repoDir: string,
  entries: Record<string, string[]>,
): Promise<string> {
  const lockfilePath = join(
    repoDir,
    "extensions",
    "models",
    "upstream_extensions.json",
  );
  await ensureDir(join(repoDir, "extensions", "models"));
  const map: Record<string, unknown> = {};
  for (const [name, files] of Object.entries(entries)) {
    map[name] = {
      version: "2026.01.01.1",
      pulledAt: "2026-01-01T00:00:00Z",
      files,
    };
  }
  await Deno.writeTextFile(lockfilePath, JSON.stringify(map, null, 2));
  return lockfilePath;
}

function registryRecord(name: string, latestVersion: string | null) {
  return { name, description: "", latestVersion };
}

// each extension owns `.swamp/pulled-extensions/<ext-name>/<type>/`, so the
// adapter must discover dirs via `enumeratePulledExtensionDirs` and pass them
// to the loader as (primary, additionalDirs)

Deno.test("auto_resolver_adapters: hotLoadModels returns 0 when lockfile missing", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(
      tmpDir,
      "extensions",
      "models",
      "upstream_extensions.json",
    );
    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
    });

    assertEquals(await adapter.hotLoadModels(), 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("auto_resolver_adapters: hotLoadModels returns 0 when lockfile has entries but no on-disk dirs", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/never-installed": [
        ".swamp/pulled-extensions/@fake/never-installed/models/foo.ts",
      ],
    });

    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
    });

    assertEquals(await adapter.hotLoadModels(), 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("auto_resolver_adapters: hotLoadModels reaches the loader for each installed per-extension dir", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    // the stub DenoRuntime makes bundling fail; what is proven is that the
    // adapter reaches the loader instead of early-returning
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/a": [".swamp/pulled-extensions/@fake/a/models/foo.ts"],
      "@fake/b": [".swamp/pulled-extensions/@fake/b/models/bar.ts"],
    });

    for (const name of ["@fake/a", "@fake/b"]) {
      const dir = join(tmpDir, ".swamp/pulled-extensions", name, "models");
      await ensureDir(dir);
      await Deno.writeTextFile(
        join(dir, name === "@fake/a" ? "foo.ts" : "bar.ts"),
        "export const model = {};",
      );
    }

    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
    });

    const loaded = await adapter.hotLoadModels();
    assertEquals(typeof loaded, "number");
    assertEquals(loaded, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("auto_resolver_adapters: hotLoadVaults is a no-op when no pulled vault dirs exist", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/ext": [".swamp/pulled-extensions/@fake/ext/models/foo.ts"],
    });
    await ensureDir(
      join(tmpDir, ".swamp/pulled-extensions/@fake/ext/models"),
    );

    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
    });

    await adapter.hotLoadVaults();
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// #121 coverage that the auto-resolver adapter must refuse to silently

async function seedPulledTree(
  repoDir: string,
  extensionName: string,
  files: string[],
): Promise<void> {
  for (const rel of files) {
    const absPath = join(repoDir, rel);
    await ensureDir(join(absPath, ".."));
    await Deno.writeTextFile(absPath, "// fixture\n");
  }
  await ensureDir(join(repoDir, ".swamp/pulled-extensions", extensionName));
}

Deno.test("auto_resolver_adapters: inspectInstallation returns missing when lockfile is missing", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(
      tmpDir,
      "extensions",
      "models",
      "upstream_extensions.json",
    );
    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
    });

    const result = await adapter.inspectInstallation("@fake/anything");
    assertEquals(result, { state: "missing" });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("auto_resolver_adapters: inspectInstallation returns missing when extension not in lockfile", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/other": [".swamp/pulled-extensions/@fake/other/models/x.ts"],
    });
    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
    });

    const result = await adapter.inspectInstallation("@fake/not-listed");
    assertEquals(result, { state: "missing" });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("auto_resolver_adapters: inspectInstallation returns missing when directory is absent", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    // returning "intact" for a removed directory would surface a confusing
    // "already installed but failed" error; a clean reinstall is correct
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/deleted-on-disk": [
        ".swamp/pulled-extensions/@fake/deleted-on-disk/models/x.ts",
      ],
    });
    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
    });

    const result = await adapter.inspectInstallation("@fake/deleted-on-disk");
    // carries the pinned version so the install progress line reports the
    // version that will actually be installed
    assertEquals(result, { state: "missing", lockedVersion: "2026.01.01.1" });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("auto_resolver_adapters: inspectInstallation preserves legacy files outside the current extension root", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const legacyPath = "extensions/models/legacy_extension.ts";
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/legacy-extension": [legacyPath],
    });
    await ensureDir(join(tmpDir, "extensions", "models"));
    await Deno.writeTextFile(join(tmpDir, legacyPath), "// legacy\n");
    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
    });

    const result = await adapter.inspectInstallation("@fake/legacy-extension");

    assertEquals(result, { state: "legacy", paths: [legacyPath] });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// a recorded skill dir is current-layout wherever it is, so one surviving the
// per-extension dir is not a legacy install
for (
  const skillPath of [
    ".claude/skills/kept-skill",
    ".swamp/pulled-extensions/skills/kept-skill",
  ]
) {
  Deno.test(`auto_resolver_adapters: inspectInstallation returns missing when only the recorded skill dir ${skillPath} survives`, async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const lockfilePath = await seedLockfile(tmpDir, {
        "@fake/skilled": [
          ".swamp/pulled-extensions/@fake/skilled/models/x.ts",
          skillPath,
        ],
      });
      await ensureDir(join(tmpDir, skillPath));
      await Deno.writeTextFile(join(tmpDir, skillPath, "SKILL.md"), "# s\n");
      const adapter = createAutoResolveInstallerAdapter({
        ...stubCallbacks,
        lockfilePath,
        repoDir: tmpDir,
        denoRuntime: stubDenoRuntime,
      });

      assertEquals(await adapter.inspectInstallation("@fake/skilled"), {
        state: "missing",
        lockedVersion: "2026.01.01.1",
      });
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  });
}

Deno.test("auto_resolver_adapters: inspectInstallation reports only the legacy source when a recorded skill dir survives beside it", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const legacyPath = "extensions/models/mixed.ts";
    const skillPath = ".claude/skills/mixed";
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/mixed": [legacyPath, skillPath],
    });
    await ensureDir(join(tmpDir, skillPath));
    await Deno.writeTextFile(join(tmpDir, legacyPath), "// legacy\n");
    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
    });

    assertEquals(await adapter.inspectInstallation("@fake/mixed"), {
      state: "legacy",
      paths: [legacyPath],
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("auto_resolver_adapters: inspectInstallation still reports a deleted recorded skill dir as truncated", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const kept = [".swamp/pulled-extensions/@fake/no-skill/models/x.ts"];
    const gone = ".claude/skills/no-skill";
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/no-skill": [...kept, gone],
    });
    await seedPulledTree(tmpDir, "@fake/no-skill", kept);
    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
    });

    assertEquals(await adapter.inspectInstallation("@fake/no-skill"), {
      state: "truncated",
      path: join(tmpDir, ".swamp", "pulled-extensions", "@fake/no-skill"),
      missing: [gone],
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("auto_resolver_adapters: inspectInstallation rejects unsafe lockfile paths before statting", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    for (const path of ["../outside", "/outside"]) {
      const lockfilePath = await seedLockfile(tmpDir, {
        "@fake/unsafe": [path],
      });
      const adapter = createAutoResolveInstallerAdapter({
        ...stubCallbacks,
        lockfilePath,
        repoDir: tmpDir,
        denoRuntime: stubDenoRuntime,
      });

      await assertRejects(
        () => adapter.inspectInstallation("@fake/unsafe"),
        PathTraversalError,
      );
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("auto_resolver_adapters: inspectInstallation returns intact when every declared file exists", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const files = [
      ".swamp/pulled-extensions/@fake/on-disk/models/x.ts",
      ".swamp/pulled-extensions/@fake/on-disk/models/y.ts",
      ".swamp/pulled-extensions/@fake/on-disk/manifest.yaml",
    ];
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/on-disk": files,
    });
    await seedPulledTree(tmpDir, "@fake/on-disk", files);

    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
    });

    const result = await adapter.inspectInstallation("@fake/on-disk");
    assertEquals(result, {
      state: "intact",
      installedVersion: "2026.01.01.1",
      path: join(tmpDir, ".swamp", "pulled-extensions", "@fake/on-disk"),
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("auto_resolver_adapters: inspectInstallation returns truncated when one declared file is missing", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const kept = [
      ".swamp/pulled-extensions/@fake/partial/manifest.yaml",
      ".swamp/pulled-extensions/@fake/partial/models/x.ts",
    ];
    const gone = ".swamp/pulled-extensions/@fake/partial/datastores/s3.ts";
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/partial": [...kept, gone],
    });
    await seedPulledTree(tmpDir, "@fake/partial", kept);

    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
    });

    const result = await adapter.inspectInstallation("@fake/partial");
    assertEquals(result, {
      state: "truncated",
      path: join(tmpDir, ".swamp", "pulled-extensions", "@fake/partial"),
      missing: [gone],
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("auto_resolver_adapters: inspectInstallation collects every missing file", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const declared = [
      ".swamp/pulled-extensions/@fake/empty/manifest.yaml",
      ".swamp/pulled-extensions/@fake/empty/models/a.ts",
      ".swamp/pulled-extensions/@fake/empty/models/b.ts",
      ".swamp/pulled-extensions/@fake/empty/datastores/s3.ts",
    ];
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/empty": declared,
    });
    await ensureDir(join(tmpDir, ".swamp/pulled-extensions/@fake/empty"));

    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
    });

    const result = await adapter.inspectInstallation("@fake/empty");
    assertEquals(result, {
      state: "truncated",
      path: join(tmpDir, ".swamp", "pulled-extensions", "@fake/empty"),
      missing: declared,
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("auto_resolver_adapters: inspectInstallation returns intact when lockfile entry has no files", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/no-files": [],
    });
    await ensureDir(join(tmpDir, ".swamp/pulled-extensions/@fake/no-files"));

    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
    });

    const result = await adapter.inspectInstallation("@fake/no-files");
    assertEquals(result, {
      state: "intact",
      installedVersion: "2026.01.01.1",
      path: join(tmpDir, ".swamp", "pulled-extensions", "@fake/no-files"),
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

async function inspectWithCatalogRows(
  tmpDir: string,
  extensionName: string,
  rows: { sourceRel: string; state: string }[],
) {
  const files = [`.swamp/pulled-extensions/${extensionName}/manifest.yaml`];
  const lockfilePath = await seedLockfile(tmpDir, { [extensionName]: files });
  await seedPulledTree(tmpDir, extensionName, files);
  const catalog = new ExtensionCatalogStore(
    join(tmpDir, ".swamp", "_extension_catalog.db"),
  );
  try {
    for (const { sourceRel, state } of rows) {
      catalog.upsert({
        type_normalized: `@fake/${crypto.randomUUID()}`,
        kind: "model",
        bundle_path: "",
        source_path: canonicalizePath(join(tmpDir, sourceRel)),
        version: "",
        description: "",
        extends_type: "",
        source_mtime: "",
        state,
      });
    }
    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
      repository: makeRepoForCatalog(catalog, tmpDir),
    });
    return await adapter.inspectInstallation(extensionName);
  } finally {
    catalog.close();
  }
}

Deno.test("auto_resolver_adapters: inspectInstallation reports loadFailures false when no source under the extension failed", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const result = await inspectWithCatalogRows(tmpDir, "@fake/clean", [
      {
        sourceRel: ".swamp/pulled-extensions/@fake/clean/models/x.ts",
        state: "Indexed",
      },
    ]);
    assertEquals(result, {
      state: "intact",
      path: join(tmpDir, ".swamp", "pulled-extensions", "@fake/clean"),
      installedVersion: "2026.01.01.1",
      loadFailures: false,
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

for (
  const state of [
    "BundleBuildFailed",
    "ValidationFailed",
    "EntryPointUnreadable",
  ]
) {
  Deno.test(`auto_resolver_adapters: inspectInstallation reports loadFailures true for a source in state ${state}`, async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const result = await inspectWithCatalogRows(tmpDir, "@fake/broken", [
        {
          sourceRel: ".swamp/pulled-extensions/@fake/broken/models/x.ts",
          state,
        },
      ]);
      assertEquals(result.state === "intact" && result.loadFailures, true);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  });
}

Deno.test("auto_resolver_adapters: inspectInstallation ignores failed sources of a sibling extension sharing its name prefix", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    // '@fake/foo-bar' starts with '@fake/foo' but is another extension.
    const result = await inspectWithCatalogRows(tmpDir, "@fake/foo", [
      {
        sourceRel: ".swamp/pulled-extensions/@fake/foo-bar/models/x.ts",
        state: "BundleBuildFailed",
      },
    ]);
    assertEquals(result.state === "intact" && result.loadFailures, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("auto_resolver_adapters: inspectInstallation ignores rows matched only by an SQL LIKE wildcard in the name", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    // Under LIKE, the '_' in '@fake/foo_bar' matches the 'x' in
    // '@fake/fooxbar'; the startsWith re-check must discard that row.
    const result = await inspectWithCatalogRows(tmpDir, "@fake/foo_bar", [
      {
        sourceRel: ".swamp/pulled-extensions/@fake/fooxbar/models/x.ts",
        state: "ValidationFailed",
      },
    ]);
    assertEquals(result.state === "intact" && result.loadFailures, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// bundles are regenerable build artifacts, so clearing a bundle cache must not
// flip the inspection to truncated
Deno.test("auto_resolver_adapters: inspectInstallation ignores absent bundle artifacts and stays intact", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const sourceRel = ".swamp/pulled-extensions/@fake/with-bundles/models/x.ts";
    const bundleRels = [
      ".swamp/bundles/abc123/x.js",
      ".swamp/vault-bundles/abc123/v.js",
      ".swamp/datastore-bundles/abc123/ds.js",
      ".swamp/report-bundles/abc123/r.js",
    ];
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/with-bundles": [sourceRel, ...bundleRels],
    });
    await seedPulledTree(tmpDir, "@fake/with-bundles", [sourceRel]);

    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
    });

    const result = await adapter.inspectInstallation("@fake/with-bundles");
    assertEquals(result, {
      state: "intact",
      installedVersion: "2026.01.01.1",
      path: join(
        tmpDir,
        ".swamp",
        "pulled-extensions",
        "@fake/with-bundles",
      ),
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("auto_resolver_adapters: inspectInstallation reports truncated only for missing source, not missing bundles", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const keptManifest = ".swamp/pulled-extensions/@fake/mixed/manifest.yaml";
    const goneSource = ".swamp/pulled-extensions/@fake/mixed/models/x.ts";
    const goneBundle = ".swamp/bundles/abc123/x.js";
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/mixed": [keptManifest, goneSource, goneBundle],
    });
    await seedPulledTree(tmpDir, "@fake/mixed", [keptManifest]);

    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
    });

    const result = await adapter.inspectInstallation("@fake/mixed");
    assertEquals(result, {
      state: "truncated",
      path: join(tmpDir, ".swamp", "pulled-extensions", "@fake/mixed"),
      missing: [goneSource],
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("auto_resolver_adapters: hotLoadDatastores is a no-op when no pulled datastore dirs exist", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/ext": [".swamp/pulled-extensions/@fake/ext/models/foo.ts"],
    });

    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
    });

    await adapter.hotLoadDatastores();
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

async function seedResolvedLockfile(
  repoDir: string,
  entries: Record<string, { version: string; checksum?: string }>,
): Promise<string> {
  const dir = join(repoDir, "cache", "config");
  await ensureDir(dir);
  const lockfilePath = join(dir, "upstream_extensions.json");
  const map: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(entries)) {
    map[name] = {
      ...entry,
      pulledAt: "2026-01-01T00:00:00Z",
      files: [`.swamp/pulled-extensions/${name}/models/thing.ts`],
    };
  }
  await Deno.writeTextFile(lockfilePath, JSON.stringify(map, null, 2));
  return lockfilePath;
}

Deno.test("auto_resolver_adapters: inspectInstallation reads a pin from the resolved lockfile, which wins", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/pinned": [".swamp/pulled-extensions/@fake/pinned/models/thing.ts"],
    });
    const resolvedPath = await seedResolvedLockfile(tmpDir, {
      "@fake/pinned": { version: "1.2.0" },
      "@fake/team-only": { version: "3.0.0" },
    });

    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
      resolvedLockfilePath: () => resolvedPath,
    });

    assertEquals(await adapter.inspectInstallation("@fake/team-only"), {
      state: "missing",
      lockedVersion: "3.0.0",
    });
    assertEquals(await adapter.inspectInstallation("@fake/pinned"), {
      state: "missing",
      lockedVersion: "1.2.0",
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("auto_resolver_adapters: install pins the version and checksum from the resolved lockfile", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = await seedLockfile(tmpDir, {});
    const resolvedPath = await seedResolvedLockfile(tmpDir, {
      "@fake/team-only": { version: "1.2.0", checksum: "sha-from-team" },
    });
    const requestedVersions: string[] = [];

    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      getExtension: () =>
        Promise.resolve({
          name: "@fake/team-only",
          description: "",
          latestVersion: "1.5.0",
        }),
      downloadArchive: (_name, version) => {
        requestedVersions.push(version);
        return Promise.resolve(new Uint8Array([1, 2, 3]));
      },
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
      resolvedLockfilePath: () => resolvedPath,
    });

    await assertRejects(
      () =>
        adapter.install(
          "@fake/team-only",
          registryRecord("@fake/team-only", "1.5.0"),
        ),
      Error,
      "Checksum mismatch for @fake/team-only@1.2.0 (stored sha-from-team",
    );
    assertEquals(requestedVersions, ["1.2.0"]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("auto_resolver_adapters: install treats a dependency in the resolved lockfile as installed", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const id = crypto.randomUUID().slice(0, 8);
    const parent = `@t/parent-${id}`;
    const dep = `@t/dep-${id}`;
    const version = "2026.01.01.1";
    const lockfilePath = await seedLockfile(repoDir, {});
    await seedResolvedLockfile(repoDir, { [dep]: { version } });
    const resolvedPath = join(
      repoDir,
      "cache",
      "config",
      "upstream_extensions.json",
    );

    const archiveDir = await Deno.makeTempDir({ prefix: "swamp_test_arc_" });
    let archive: Uint8Array;
    try {
      const extDir = join(archiveDir, "extension");
      await ensureDir(join(extDir, "skills", `parent-${id}`));
      await Deno.writeTextFile(
        join(extDir, "manifest.yaml"),
        `manifestVersion: 1\nname: "${parent}"\nversion: "${version}"\n` +
          `skills:\n  - parent-${id}\ndependencies:\n  - "${dep}"\n`,
      );
      await Deno.writeTextFile(
        join(extDir, "skills", `parent-${id}`, "SKILL.md"),
        "x",
      );
      await createTarGz(extDir, join(archiveDir, "a.tar.gz"));
      archive = await Deno.readFile(join(archiveDir, "a.tar.gz"));
    } finally {
      await Deno.remove(archiveDir, { recursive: true }).catch(() => {});
    }

    const fetched: string[] = [];
    const adapter = createAutoResolveInstallerAdapter({
      getExtension: (name) => {
        fetched.push(name);
        return Promise.resolve({
          name,
          description: "",
          latestVersion: version,
        });
      },
      downloadArchive: () => Promise.resolve(archive),
      getChecksum: () => Promise.resolve(null),
      lockfilePath,
      repoDir,
      denoRuntime: stubDenoRuntime,
      resolvedLockfilePath: () => resolvedPath,
    });
    const result = await adapter.install(
      parent,
      registryRecord(parent, version),
    );

    assertEquals(result?.version, version);
    // the root's record comes from the resolver
    assertEquals(fetched, []);
    const recorded = await LockfileRepository.create(lockfilePath);
    assertEquals(Object.keys(recorded.getAllEntries()), [parent]);
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
});

async function packExtension(
  name: string,
  version: string,
  dependencies: string[],
  skill = `skill-${crypto.randomUUID().slice(0, 8)}`,
): Promise<Uint8Array> {
  const archiveDir = await Deno.makeTempDir({ prefix: "swamp_test_arc_" });
  try {
    const extDir = join(archiveDir, "extension");
    await ensureDir(join(extDir, "skills", skill));
    const deps = dependencies.length > 0
      ? `dependencies:\n${dependencies.map((d) => `  - "${d}"\n`).join("")}`
      : "";
    await Deno.writeTextFile(
      join(extDir, "manifest.yaml"),
      `manifestVersion: 1\nname: "${name}"\nversion: "${version}"\n` +
        `skills:\n  - ${skill}\n${deps}`,
    );
    await Deno.writeTextFile(join(extDir, "skills", skill, "SKILL.md"), "x");
    await createTarGz(extDir, join(archiveDir, "a.tar.gz"));
    return await Deno.readFile(join(archiveDir, "a.tar.gz"));
  } finally {
    await Deno.remove(archiveDir, { recursive: true }).catch(() => {});
  }
}

Deno.test("auto_resolver_adapters: the install deadline ends before a waiter gives up on the lock", () => {
  // leaves room for the local extract and bundle work, which the registry
  // deadline does not bound
  assertEquals(
    EXTENSION_INSTALL_LOCK_MAX_WAIT_MS - AUTO_RESOLVE_INSTALL_DEADLINE_MS >=
      30_000,
    true,
  );
});

Deno.test("auto_resolver_adapters: install shares one registry deadline across an extension and its dependencies", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const id = crypto.randomUUID().slice(0, 8);
    const parent = `@t/parent-${id}`;
    const dep = `@t/dep-${id}`;
    const version = "2026.01.01.1";
    const lockfilePath = await seedLockfile(repoDir, {});
    const archives: Record<string, Uint8Array> = {
      [parent]: await packExtension(parent, version, [dep]),
      [dep]: await packExtension(dep, version, []),
    };

    const calls: { call: string; name: string; signal?: AbortSignal }[] = [];
    const adapter = createAutoResolveInstallerAdapter({
      getExtension: (name, signal) => {
        calls.push({ call: "getExtension", name, signal });
        return Promise.resolve({
          name,
          description: "",
          latestVersion: version,
        });
      },
      downloadArchive: (name, _version, _channel, signal) => {
        calls.push({ call: "downloadArchive", name, signal });
        return Promise.resolve(archives[name]);
      },
      getChecksum: (name, _version, _channel, signal) => {
        calls.push({ call: "getChecksum", name, signal });
        return Promise.resolve(null);
      },
      lockfilePath,
      repoDir,
      denoRuntime: stubDenoRuntime,
    });
    const result = await adapter.install(
      parent,
      registryRecord(parent, version),
    );

    assertEquals(result?.version, version);
    assertEquals(new Set(calls.map((c) => c.name)), new Set([parent, dep]));
    assertEquals(
      new Set(calls.map((c) => c.call)),
      new Set(["getExtension", "downloadArchive", "getChecksum"]),
    );
    const deadline = calls[0].signal;
    assertEquals(deadline instanceof AbortSignal, true);
    assertEquals(calls.every((c) => c.signal === deadline), true);

    const before = calls.length;
    await adapter.install(dep, registryRecord(dep, version)).catch(() => {});
    const later = calls.slice(before);
    assertEquals(later.length > 0, true);
    assertEquals(later.every((c) => c.signal !== deadline), true);
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("auto_resolver_adapters: a forced re-run after a skill conflict keeps the install's deadline", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const id = crypto.randomUUID().slice(0, 8);
    const name = `@t/conflict-${id}`;
    const skill = `skill-${id}`;
    const version = "2026.01.01.1";
    const lockfilePath = await seedLockfile(repoDir, {});
    const archive = await packExtension(name, version, [], skill);
    const skillDir = swampPath(repoDir, SWAMP_SUBDIRS.pulledSkills, skill);
    await ensureDir(skillDir);
    await Deno.writeTextFile(join(skillDir, "SKILL.md"), "old");

    const signals: (AbortSignal | undefined)[] = [];
    const adapter = createAutoResolveInstallerAdapter({
      getExtension: (n, signal) => {
        signals.push(signal);
        return Promise.resolve({
          name: n,
          description: "",
          latestVersion: version,
        });
      },
      downloadArchive: (_n, _v, _c, signal) => {
        signals.push(signal);
        return Promise.resolve(archive);
      },
      getChecksum: (_n, _v, _c, signal) => {
        signals.push(signal);
        return Promise.resolve(null);
      },
      lockfilePath,
      repoDir,
      denoRuntime: stubDenoRuntime,
    });
    const result = await adapter.install(name, registryRecord(name, version));

    assertEquals(result?.version, version);
    assertEquals(signals.length, 4);
    assertEquals(signals.every((s) => s === signals[0]), true);
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
});

async function seedDatastoreExtension(
  repoDir: string,
  rootSegments: string[],
  name: string,
): Promise<string> {
  const extRoot = join(repoDir, ...rootSegments, ...name.split("/"));
  await ensureDir(join(extRoot, "datastores"));
  await Deno.writeTextFile(
    join(extRoot, "manifest.yaml"),
    `manifestVersion: 1\nname: "${name}"\nversion: "2026.01.01.1"\n`,
  );
  await Deno.writeTextFile(
    join(extRoot, "datastores", "store.ts"),
    "export const datastore = {};\n",
  );
  return join(extRoot, "datastores");
}

Deno.test("hotLoadDatastoreDirs: adds datastore extensions found on disk, once each, sorted", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const listedDir = await seedDatastoreExtension(
      tmpDir,
      [".swamp", "pulled-extensions"],
      "@fake/listed",
    );
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/listed": [
        ".swamp/pulled-extensions/@fake/listed/datastores/store.ts",
      ],
    });
    const unlistedDir = await seedDatastoreExtension(
      tmpDir,
      [".swamp", "config", "pulled-extensions"],
      "@acme/store",
    );

    const dirs = await hotLoadDatastoreDirs(lockfilePath, tmpDir, true);

    assertEquals(dirs, [listedDir, unlistedDir].sort());
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("hotLoadDatastoreDirs: reads only lockfile-listed dirs without datastoresOnDisk", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const listedDir = await seedDatastoreExtension(
      tmpDir,
      [".swamp", "pulled-extensions"],
      "@fake/listed",
    );
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/listed": [
        ".swamp/pulled-extensions/@fake/listed/datastores/store.ts",
      ],
    });
    await seedDatastoreExtension(
      tmpDir,
      [".swamp", "config", "pulled-extensions"],
      "@acme/store",
    );

    const dirs = await hotLoadDatastoreDirs(lockfilePath, tmpDir, false);

    assertEquals(dirs, [listedDir]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("auto_resolver_adapters: hotLoadWebhooks is a no-op when no pulled webhook dirs exist", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/ext": [".swamp/pulled-extensions/@fake/ext/models/foo.ts"],
    });

    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
    });

    await adapter.hotLoadWebhooks();
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// hotLoadModels must retry user-extension attachment against the shared catalog
// after a newly-installed base registers; these tests verify the guards, the
// integration test covers the positive path

function makeStubBase(typeNormalized: string): ModelDefinition {
  return {
    type: ModelType.create(typeNormalized),
    version: "2026.02.09.1",
    description: "",
    globalArguments: z.object({}),
    methods: {},
    resources: {},
    upgrades: [],
  } as unknown as ModelDefinition;
}

Deno.test("auto_resolver_adapters: hotLoadModels tolerates catalog being undefined", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    // callers that pass no catalog must keep working
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/ext": [".swamp/pulled-extensions/@fake/ext/models/foo.ts"],
    });
    await ensureDir(join(tmpDir, ".swamp/pulled-extensions/@fake/ext/models"));
    await Deno.writeTextFile(
      join(tmpDir, ".swamp/pulled-extensions/@fake/ext/models/foo.ts"),
      "export const model = {};",
    );

    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
    });

    assertEquals(typeof (await adapter.hotLoadModels()), "number");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("auto_resolver_adapters: hotLoadModels skips catalog walk when catalog has no extension rows", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  const dbPath = join(tmpDir, ".swamp", "_extension_catalog.db");
  try {
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/ext": [".swamp/pulled-extensions/@fake/ext/models/foo.ts"],
    });
    await ensureDir(join(tmpDir, ".swamp/pulled-extensions/@fake/ext/models"));
    await Deno.writeTextFile(
      join(tmpDir, ".swamp/pulled-extensions/@fake/ext/models/foo.ts"),
      "export const model = {};",
    );

    const catalog = new ExtensionCatalogStore(dbPath);
    assertEquals(catalog.findByKind("extension").length, 0);

    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
      repository: makeRepoForCatalog(catalog, tmpDir),
    });

    assertEquals(await adapter.hotLoadModels(), 0);
    catalog.close();
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("auto_resolver_adapters: hotLoadModels catalog walk skips types whose base is not fully loaded", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  const dbPath = join(tmpDir, ".swamp", "_extension_catalog.db");
  const unknownBase = "@user/auto-resolver-adapter-unknown-base";
  try {
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/ext": [".swamp/pulled-extensions/@fake/ext/models/foo.ts"],
    });
    await ensureDir(join(tmpDir, ".swamp/pulled-extensions/@fake/ext/models"));
    await Deno.writeTextFile(
      join(tmpDir, ".swamp/pulled-extensions/@fake/ext/models/foo.ts"),
      "export const model = {};",
    );

    const catalog = new ExtensionCatalogStore(dbPath);
    // an extension row pointing at a base not in modelRegistry must be skipped
    // by the guard, or attachPendingExtensionsForType would throw or warn
    catalog.upsert({
      type_normalized: unknownBase,
      kind: "extension",
      bundle_path: "/does/not/exist.js",
      source_path: "/does/not/exist.ts",
      version: "",
      description: "",
      extends_type: unknownBase,
      source_mtime: "",
      source_fingerprint: "",
    });
    assertEquals(catalog.findByKind("extension").length, 1);
    assertEquals(modelRegistry.get(unknownBase), undefined);

    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
      repository: makeRepoForCatalog(catalog, tmpDir),
    });

    assertEquals(typeof (await adapter.hotLoadModels()), "number");
    catalog.close();
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// bundle-only ConflictErrors are safe to force-overwrite while source-file
// conflicts are user work in progress, so every bundle store must be recognised

Deno.test("isBundleArtifactPath: recognises every bundle store", () => {
  assertEquals(isBundleArtifactPath(".swamp/bundles/abc123/x.js"), true);
  assertEquals(isBundleArtifactPath(".swamp/vault-bundles/abc123/v.js"), true);
  assertEquals(
    isBundleArtifactPath(".swamp/datastore-bundles/abc123/ds.js"),
    true,
  );
  assertEquals(
    isBundleArtifactPath(".swamp/report-bundles/abc123/r.js"),
    true,
  );
  assertEquals(
    isBundleArtifactPath(".swamp/webhook-bundles/abc123/w.js"),
    true,
  );
});

Deno.test("isBundleArtifactPath: rejects non-bundle paths", () => {
  assertEquals(
    isBundleArtifactPath(
      ".swamp/pulled-extensions/@fake/ext/models/foo.ts",
    ),
    false,
  );
  assertEquals(
    isBundleArtifactPath(
      ".swamp/pulled-extensions/@fake/ext/datastores/bar.ts",
    ),
    false,
  );
  assertEquals(isBundleArtifactPath(".swamp/definitions/my-model.yaml"), false);
  assertEquals(isBundleArtifactPath("models/foo.ts"), false);
});

Deno.test("isBundleArtifactPath: bundle-only conflict set is detected as all-bundles", () => {
  const conflicts = [
    ".swamp/bundles/abc123/model.js",
    ".swamp/vault-bundles/def456/vault.js",
    ".swamp/datastore-bundles/789ghi/s3.js",
    ".swamp/report-bundles/jkl012/report.js",
  ];
  assertEquals(conflicts.every(isBundleArtifactPath), true);
});

Deno.test("isBundleArtifactPath: mixed conflict set is not all-bundles", () => {
  const conflicts = [
    ".swamp/datastore-bundles/abc123/s3.js",
    ".swamp/pulled-extensions/@swamp/s3-datastore/datastores/s3.ts",
  ];
  assertEquals(conflicts.every(isBundleArtifactPath), false);
});

Deno.test("auto_resolver_adapters: hotLoadModels catalog walk attempts attach when base is fully loaded", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  const dbPath = join(tmpDir, ".swamp", "_extension_catalog.db");
  const ts = Date.now();
  const baseType = `@user/auto-resolver-adapter-loaded-${ts}`;
  try {
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/ext": [".swamp/pulled-extensions/@fake/ext/models/foo.ts"],
    });
    await ensureDir(join(tmpDir, ".swamp/pulled-extensions/@fake/ext/models"));
    // with the stub deno bundling fails, so result.loaded is 0 and the
    // `result.loaded.length > 0` guard skips the catalog walk; a bogus bundle
    // row makes this fail if the guard regressed to always run
    await Deno.writeTextFile(
      join(tmpDir, ".swamp/pulled-extensions/@fake/ext/models/foo.ts"),
      "export const model = {};",
    );

    const catalog = new ExtensionCatalogStore(dbPath);
    catalog.upsert({
      type_normalized: baseType,
      kind: "extension",
      bundle_path: "/does/not/exist.js",
      source_path: "/does/not/exist.ts",
      version: "",
      description: "",
      extends_type: baseType,
      source_mtime: "",
      source_fingerprint: "",
    });

    try {
      modelRegistry.register(makeStubBase(baseType));
    } catch {
      // Test re-runs within the same process — already registered.
    }

    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
      repository: makeRepoForCatalog(catalog, tmpDir),
    });

    assertEquals(await adapter.hotLoadModels(), 0);
    catalog.close();
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// skills land in a dir shared across extensions, so a same-named skill from
// another extension raises a ConflictError on its dir; auto-install retries
// those with force, as it does stale bundles

Deno.test("isPulledSkillPath: recognises pulled skill dirs only", () => {
  assertEquals(isPulledSkillPath(".swamp/pulled-extensions/skills/foo"), true);
  assertEquals(
    isPulledSkillPath(".swamp/pulled-extensions/@fake/ext/models/foo.ts"),
    false,
  );
  assertEquals(isPulledSkillPath(".claude/skills/foo"), false);
});

Deno.test("auto_resolver_adapters: install retries past a skill dir another extension owns", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const name = `@t/skill-${crypto.randomUUID().slice(0, 8)}`;
    const version = "2026.01.01.1";
    const lockfilePath = await seedLockfile(repoDir, {
      "@t/other": [".swamp/pulled-extensions/skills/foo/other.md"],
    });
    const skillDir = join(
      repoDir,
      ".swamp",
      "pulled-extensions",
      "skills",
      "foo",
    );
    await ensureDir(skillDir);
    await Deno.writeTextFile(join(skillDir, "other.md"), "other");

    const archiveDir = await Deno.makeTempDir({ prefix: "swamp_test_arc_" });
    let archive: Uint8Array;
    try {
      const extDir = join(archiveDir, "extension");
      await ensureDir(join(extDir, "skills", "foo"));
      await Deno.writeTextFile(
        join(extDir, "manifest.yaml"),
        `manifestVersion: 1\nname: "${name}"\nversion: "${version}"\nskills:\n  - foo\n`,
      );
      await Deno.writeTextFile(join(extDir, "skills", "foo", "SKILL.md"), "x");
      await createTarGz(extDir, join(archiveDir, "a.tar.gz"));
      archive = await Deno.readFile(join(archiveDir, "a.tar.gz"));
    } finally {
      await Deno.remove(archiveDir, { recursive: true }).catch(() => {});
    }

    const adapter = createAutoResolveInstallerAdapter({
      getExtension: () =>
        Promise.resolve({ name, description: "", latestVersion: version }),
      downloadArchive: () => Promise.resolve(archive),
      getChecksum: () => Promise.resolve(null),
      lockfilePath,
      repoDir,
      denoRuntime: stubDenoRuntime,
    });
    const result = await adapter.install(name, registryRecord(name, version));

    assertEquals(result?.version, version);
    assertEquals(await Deno.readTextFile(join(skillDir, "SKILL.md")), "x");
    assertEquals(await Deno.readTextFile(join(skillDir, "other.md")), "other");
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("auto_resolver_adapters: install re-installs a pinned beta entry on its channel", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const id = crypto.randomUUID().slice(0, 8);
    const name = `@t/beta-${id}`;
    const version = "2026.01.01.1";
    const lockfilePath = await seedLockfile(repoDir, {});
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        [name]: {
          version,
          pulledAt: "2026-01-01T00:00:00Z",
          files: [`.swamp/pulled-extensions/${name}/manifest.yaml`],
          channel: "beta",
        },
      }),
    );

    const archiveDir = await Deno.makeTempDir({ prefix: "swamp_test_arc_" });
    let archive: Uint8Array;
    try {
      const extDir = join(archiveDir, "extension");
      await ensureDir(join(extDir, "skills", `beta-${id}`));
      await Deno.writeTextFile(
        join(extDir, "manifest.yaml"),
        `manifestVersion: 1\nname: "${name}"\nversion: "${version}"\n` +
          `skills:\n  - beta-${id}\n`,
      );
      await Deno.writeTextFile(
        join(extDir, "skills", `beta-${id}`, "SKILL.md"),
        "x",
      );
      await createTarGz(extDir, join(archiveDir, "a.tar.gz"));
      archive = await Deno.readFile(join(archiveDir, "a.tar.gz"));
    } finally {
      await Deno.remove(archiveDir, { recursive: true }).catch(() => {});
    }

    const channels: Array<string | undefined> = [];
    const adapter = createAutoResolveInstallerAdapter({
      getExtension: () =>
        Promise.resolve({
          name,
          description: "",
          latestVersion: null,
          latestBeta: version,
        }),
      downloadArchive: (_name, _version, channel) => {
        channels.push(channel);
        return Promise.resolve(archive);
      },
      getChecksum: (_name, _version, channel) => {
        channels.push(channel);
        return Promise.resolve(null);
      },
      lockfilePath,
      repoDir,
      denoRuntime: stubDenoRuntime,
    });
    const result = await adapter.install(name, {
      ...registryRecord(name, null),
      latestBeta: version,
    });

    assertEquals(result?.version, version);
    assertEquals(channels, ["beta", "beta"]);
    const recorded = await LockfileRepository.create(lockfilePath);
    assertEquals(recorded.getEntry(name)?.channel, "beta");
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
});

function installLockPath(repoDir: string): string {
  return join(repoDir, ".swamp", ".extension-install.lock");
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

function adapterFor(repoDir: string) {
  return createAutoResolveInstallerAdapter({
    ...stubCallbacks,
    lockfilePath: join(
      repoDir,
      "extensions",
      "models",
      "upstream_extensions.json",
    ),
    repoDir,
    denoRuntime: stubDenoRuntime,
  });
}

Deno.test("auto_resolver_adapters: withInstallLock holds the repo install lock while fn runs and releases it after", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const result = await adapterFor(tmpDir).withInstallLock(async () => {
      assertEquals(await exists(installLockPath(tmpDir)), true);
      return "done";
    });
    assertEquals(result, "done");
    assertEquals(await exists(installLockPath(tmpDir)), false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("auto_resolver_adapters: withInstallLock releases the lock when fn throws", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    await assertRejects(
      () =>
        adapterFor(tmpDir).withInstallLock(() =>
          Promise.reject(new Error("install failed"))
        ),
      Error,
      "install failed",
    );
    assertEquals(await exists(installLockPath(tmpDir)), false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("auto_resolver_adapters: withInstallLock serializes installs from separate adapters on one repo", async () => {
  // two adapters stand in for two processes sharing the repo; their critical
  // sections must never interleave
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const events: string[] = [];
    const section = (name: string) => async () => {
      events.push(`${name}:start`);
      // Filesystem I/O yields, giving the other caller a chance to run.
      for (let i = 0; i < 5; i++) await exists(installLockPath(tmpDir));
      events.push(`${name}:end`);
    };
    await Promise.all([
      adapterFor(tmpDir).withInstallLock(section("a")),
      adapterFor(tmpDir).withInstallLock(section("b")),
    ]);
    assertEquals(events.length, 4);
    for (let i = 0; i < events.length; i += 2) {
      const name = events[i].split(":")[0];
      assertEquals(events.slice(i, i + 2), [`${name}:start`, `${name}:end`]);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

async function buildSkillArchive(
  name: string,
  version: string,
  ...skills: string[]
): Promise<Uint8Array> {
  const archiveDir = await Deno.makeTempDir({ prefix: "swamp_test_arc_" });
  try {
    const extDir = join(archiveDir, "extension");
    await ensureDir(extDir);
    await Deno.writeTextFile(
      join(extDir, "manifest.yaml"),
      `manifestVersion: 1\nname: "${name}"\nversion: "${version}"\nskills:\n${
        skills.map((s) => `  - ${s}\n`).join("")
      }`,
    );
    for (const skill of skills) {
      await ensureDir(join(extDir, "skills", skill));
      await Deno.writeTextFile(join(extDir, "skills", skill, "SKILL.md"), "x");
    }
    await createTarGz(extDir, join(archiveDir, "a.tar.gz"));
    return await Deno.readFile(join(archiveDir, "a.tar.gz"));
  } finally {
    await Deno.remove(archiveDir, { recursive: true }).catch(() => {});
  }
}

async function readEntryFiles(
  lockfilePath: string,
  name: string,
): Promise<string[]> {
  const lockfile = JSON.parse(await Deno.readTextFile(lockfilePath));
  return lockfile[name].files;
}

// reinstalling a pinned entry puts its skill back in the dir the entry records,
// so the entry keeps its skill path and the commit prunes nothing, whether or
// not the skill dir survived
for (const skillSurvives of [true, false]) {
  Deno.test(
    `auto_resolver_adapters: install writes a pinned entry's skill back into its recorded dir (skill dir ${
      skillSurvives ? "present" : "gone"
    })`,
    async () => {
      const repoDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
      try {
        const name = `@t/pinned-${crypto.randomUUID().slice(0, 8)}`;
        const version = "2026.01.01.1";
        const skillPath = ".claude/skills/foo";
        const lockfilePath = await seedLockfile(repoDir, {
          [name]: [`.swamp/pulled-extensions/${name}/manifest.yaml`, skillPath],
        });
        if (skillSurvives) {
          await ensureDir(join(repoDir, skillPath));
          await Deno.writeTextFile(join(repoDir, skillPath, "SKILL.md"), "old");
        }
        const archive = await buildSkillArchive(name, version, "foo");

        const adapter = createAutoResolveInstallerAdapter({
          getExtension: () =>
            Promise.resolve({ name, description: "", latestVersion: version }),
          downloadArchive: () => Promise.resolve(archive),
          getChecksum: () => Promise.resolve(null),
          lockfilePath,
          repoDir,
          denoRuntime: stubDenoRuntime,
        });
        const result = await adapter.install(
          name,
          registryRecord(name, version),
        );

        assertEquals(result?.version, version);
        assertEquals(
          await Deno.readTextFile(join(repoDir, skillPath, "SKILL.md")),
          "x",
        );
        const files = await readEntryFiles(lockfilePath, name);
        assertEquals(files.includes(skillPath), true);
        assertEquals(
          files.some((f) => f.startsWith(".swamp/pulled-extensions/skills/")),
          false,
        );
        assertEquals(
          await Deno.stat(swampPath(repoDir, SWAMP_SUBDIRS.pulledSkills, "foo"))
            .then(() => true, () => false),
          false,
        );
      } finally {
        await Deno.remove(repoDir, { recursive: true }).catch(() => {});
      }
    },
  );
}

Deno.test("auto_resolver_adapters: install merges into a skill dir the resolved lockfile records", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const name = `@t/team-${crypto.randomUUID().slice(0, 8)}`;
    const version = "2026.01.01.1";
    const skillPath = ".claude/skills/foo";
    // The local lockfile has no entry, so the surviving skill dir is a
    // skill conflict for the install; the retry merges into it.
    const lockfilePath = await seedLockfile(repoDir, {});
    const resolvedDir = join(repoDir, "cache", "config");
    await ensureDir(resolvedDir);
    const resolvedPath = join(resolvedDir, "upstream_extensions.json");
    await Deno.writeTextFile(
      resolvedPath,
      JSON.stringify({
        [name]: {
          version,
          pulledAt: "2026-01-01T00:00:00Z",
          files: [`.swamp/pulled-extensions/${name}/manifest.yaml`, skillPath],
        },
      }),
    );
    await ensureDir(join(repoDir, skillPath));
    await Deno.writeTextFile(join(repoDir, skillPath, "other.md"), "other");
    const archive = await buildSkillArchive(name, version, "foo");

    const adapter = createAutoResolveInstallerAdapter({
      getExtension: () =>
        Promise.resolve({ name, description: "", latestVersion: version }),
      downloadArchive: () => Promise.resolve(archive),
      getChecksum: () => Promise.resolve(null),
      lockfilePath,
      repoDir,
      denoRuntime: stubDenoRuntime,
      resolvedLockfilePath: () => resolvedPath,
    });
    const result = await adapter.install(name, registryRecord(name, version));

    assertEquals(result?.version, version);
    assertEquals(
      await Deno.readTextFile(join(repoDir, skillPath, "SKILL.md")),
      "x",
    );
    assertEquals(
      await Deno.readTextFile(join(repoDir, skillPath, "other.md")),
      "other",
    );
    const files = await readEntryFiles(lockfilePath, name);
    assertEquals(
      files.some((f) => f.startsWith(".claude/skills/foo")),
      true,
    );
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("auto_resolver_adapters: install puts a pinned entry without a recorded skill in the pulled skills dir", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const name = `@t/plain-${crypto.randomUUID().slice(0, 8)}`;
    const version = "2026.01.01.1";
    const lockfilePath = await seedLockfile(repoDir, {
      [name]: [`.swamp/pulled-extensions/${name}/manifest.yaml`],
    });
    const archive = await buildSkillArchive(name, version, "foo");

    const adapter = createAutoResolveInstallerAdapter({
      getExtension: () =>
        Promise.resolve({ name, description: "", latestVersion: version }),
      downloadArchive: () => Promise.resolve(archive),
      getChecksum: () => Promise.resolve(null),
      lockfilePath,
      repoDir,
      denoRuntime: stubDenoRuntime,
    });
    const result = await adapter.install(name, registryRecord(name, version));

    assertEquals(result?.version, version);
    assertEquals(
      await Deno.readTextFile(
        swampPath(repoDir, SWAMP_SUBDIRS.pulledSkills, "foo", "SKILL.md"),
      ),
      "x",
    );
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("auto_resolver_adapters: install refuses a skill conflict the pinned entry does not record", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const name = `@t/drift-${crypto.randomUUID().slice(0, 8)}`;
    const version = "2026.01.01.1";
    // The entry is resolved from the team lockfile, so the local one has
    // no entry and both surviving skill dirs raise conflicts. Only foo is
    // the extension's; bar is the user's own skill.
    const lockfilePath = await seedLockfile(repoDir, {});
    const resolvedDir = join(repoDir, "cache", "config");
    await ensureDir(resolvedDir);
    const resolvedPath = join(resolvedDir, "upstream_extensions.json");
    await Deno.writeTextFile(
      resolvedPath,
      JSON.stringify({
        [name]: {
          version,
          pulledAt: "2026-01-01T00:00:00Z",
          files: [
            `.swamp/pulled-extensions/${name}/manifest.yaml`,
            ".claude/skills/foo",
          ],
        },
      }),
    );
    await ensureDir(join(repoDir, ".claude", "skills", "foo"));
    await ensureDir(join(repoDir, ".claude", "skills", "bar"));
    await Deno.writeTextFile(
      join(repoDir, ".claude", "skills", "bar", "SKILL.md"),
      "mine",
    );
    const archive = await buildSkillArchive(name, version, "foo", "bar");

    const adapter = createAutoResolveInstallerAdapter({
      getExtension: () =>
        Promise.resolve({ name, description: "", latestVersion: version }),
      downloadArchive: () => Promise.resolve(archive),
      getChecksum: () => Promise.resolve(null),
      lockfilePath,
      repoDir,
      denoRuntime: stubDenoRuntime,
      resolvedLockfilePath: () => resolvedPath,
    });

    assertEquals(
      await adapter.install(name, registryRecord(name, version)),
      null,
    );
    assertEquals(
      await Deno.readTextFile(
        join(repoDir, ".claude", "skills", "bar", "SKILL.md"),
      ),
      "mine",
    );
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("auto_resolver_adapters: install keeps a new dependency's skill out of the parent's recorded tool dir", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const id = crypto.randomUUID().slice(0, 8);
    const parent = `@t/parent-${id}`;
    const dep = `@t/dep-${id}`;
    const version = "2026.01.01.1";
    // The parent's entry records a claude skill, so its own skill goes
    // back there. The dependency has no entry and ships "bar", which the
    // user already has as their own claude skill.
    const lockfilePath = await seedLockfile(repoDir, {
      [parent]: [
        `.swamp/pulled-extensions/${parent}/manifest.yaml`,
        ".claude/skills/foo",
      ],
    });
    const userSkill = join(repoDir, ".claude", "skills", "bar", "SKILL.md");
    await ensureDir(join(repoDir, ".claude", "skills", "bar"));
    await Deno.writeTextFile(userSkill, "mine");
    const archives = new Map([
      [parent, await packExtension(parent, version, [dep], "foo")],
      [dep, await packExtension(dep, version, [], "bar")],
    ]);

    const adapter = createAutoResolveInstallerAdapter({
      getExtension: (name) =>
        Promise.resolve({ name, description: "", latestVersion: version }),
      downloadArchive: (name) => Promise.resolve(archives.get(name)!),
      getChecksum: () => Promise.resolve(null),
      lockfilePath,
      repoDir,
      denoRuntime: stubDenoRuntime,
    });
    const result = await adapter.install(
      parent,
      registryRecord(parent, version),
    );

    assertEquals(result?.version, version);
    assertEquals(await Deno.readTextFile(userSkill), "mine");
    assertEquals(
      await Deno.readTextFile(
        join(repoDir, ".claude", "skills", "foo", "SKILL.md"),
      ),
      "x",
    );
    assertEquals(
      await Deno.readTextFile(
        swampPath(repoDir, SWAMP_SUBDIRS.pulledSkills, "bar", "SKILL.md"),
      ),
      "x",
    );
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("auto_resolver_adapters: registeredModelCount counts the extension's registered behavior types only", async () => {
  // another caller may have loaded the types, so the count comes from the
  // catalog and the registry, not from this hot-load
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  const loaded = `@fake/count-${crypto.randomUUID()}`;
  const catalog = new ExtensionCatalogStore(
    join(tmpDir, ".swamp", "_extension_catalog.db"),
  );
  try {
    modelRegistry.register({
      type: ModelType.create(loaded),
      version: "2026.01.01.1",
      globalArguments: z.object({}),
      resources: {},
      methods: {},
    } as unknown as ModelDefinition);
    const row = (type: string, kind: "model" | "extension", rel: string) =>
      catalog.upsert({
        type_normalized: type,
        kind,
        bundle_path: "",
        source_path: canonicalizePath(join(tmpDir, rel)),
        version: "",
        description: "",
        extends_type: "",
        source_mtime: "",
      });
    const root = ".swamp/pulled-extensions";
    row(loaded, "model", `${root}/@fake/count/models/a.ts`);
    row(
      `@fake/gone-${crypto.randomUUID()}`,
      "model",
      `${root}/@fake/count/models/b.ts`,
    );
    row(loaded, "extension", `${root}/@fake/count/models/c.ts`);
    row(loaded, "model", `${root}/@fake/count-other/models/a.ts`);

    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath: join(tmpDir, "upstream_extensions.json"),
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
      repository: makeRepoForCatalog(catalog, tmpDir),
    });
    assertEquals(adapter.registeredModelCount?.("@fake/count"), 1);
    assertEquals(adapter.registeredModelCount?.("@fake/none"), 0);
  } finally {
    modelRegistry.invalidateType(loaded);
    catalog.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("auto_resolver_adapters: registeredModelCount finds rows stored under the symlink-resolved repo path", async () => {
  // a repo reached through a symlink (macOS /tmp) has catalog rows under the
  // resolved path; the count must not drop to 0
  const realDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  const linkParent = await Deno.makeTempDir({ prefix: "swamp_test_link_" });
  const linkDir = join(linkParent, "repo");
  const type = `@fake/linked-${crypto.randomUUID()}`;
  const catalog = new ExtensionCatalogStore(
    join(realDir, ".swamp", "_extension_catalog.db"),
  );
  try {
    await Deno.symlink(realDir, linkDir, { type: "dir" });
    await ensureDir(join(realDir, ".swamp", "pulled-extensions", "@fake"));
    modelRegistry.register({
      type: ModelType.create(type),
      version: "2026.01.01.1",
      globalArguments: z.object({}),
      resources: {},
      methods: {},
    } as unknown as ModelDefinition);
    catalog.upsert({
      type_normalized: type,
      kind: "model",
      bundle_path: "",
      source_path: canonicalizePath(
        join(
          Deno.realPathSync(realDir),
          ".swamp/pulled-extensions/@fake/linked/models/a.ts",
        ),
      ),
      version: "",
      description: "",
      extends_type: "",
      source_mtime: "",
    });

    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath: join(linkDir, "upstream_extensions.json"),
      repoDir: linkDir,
      denoRuntime: stubDenoRuntime,
      repository: makeRepoForCatalog(catalog, linkDir),
    });
    assertEquals(adapter.registeredModelCount?.("@fake/linked"), 1);
  } finally {
    modelRegistry.invalidateType(type);
    catalog.close();
    await Deno.remove(linkParent, { recursive: true });
    await Deno.remove(realDir, { recursive: true });
  }
});

Deno.test("auto_resolver_adapters: install reads and fills the archive cache", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const name = `@t/cached-${crypto.randomUUID().slice(0, 8)}`;
    const version = "2026.01.01.1";
    const lockfilePath = await seedLockfile(repoDir, {});
    const archive = await packExtension(name, version, []);
    const checksum = await computeChecksum(archive);
    const gets: string[] = [];
    const puts: string[] = [];
    const archiveCache: ExtensionArchiveCache = {
      get: (key) => {
        gets.push(key);
        return Promise.resolve(null);
      },
      put: (key) => {
        puts.push(key);
        return Promise.resolve();
      },
    };
    const adapter = createAutoResolveInstallerAdapter({
      getExtension: () => Promise.reject(new Error("root already looked up")),
      downloadArchive: () => Promise.resolve(archive),
      getChecksum: () => Promise.resolve(checksum),
      lockfilePath,
      repoDir,
      denoRuntime: stubDenoRuntime,
      archiveCache,
    });

    const result = await adapter.install(name, registryRecord(name, version));

    assertEquals(result?.version, version);
    assertEquals(gets, [checksum]);
    assertEquals(puts, [checksum]);
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
});
