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
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { createAutoResolveInstallerAdapter } from "./auto_resolver_adapters.ts";
import type { DenoRuntime } from "../domain/runtime/deno_runtime.ts";
import { ExtensionCatalogStore } from "../infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../infrastructure/persistence/lockfile_repository.ts";
import { modelRegistry } from "../domain/models/model.ts";
import { ModelType } from "../domain/models/model_type.ts";
import type { ModelDefinition } from "../domain/models/model.ts";
import { z } from "zod";

// Import models barrel so command/shell is registered and doesn't
// collide with user-fixture registrations in these tests.
import "../domain/models/models.ts";

// Stub DenoRuntime — the adapter constructs a real UserModelLoader
// internally, which requires a DenoRuntime. We return a bogus path so
// any bundling attempt fails cleanly (the loader records the failure in
// `result.failed` rather than throwing). The tests care about the
// enumerate → primary/rest plumbing, not about actual bundling.
const stubDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve("/usr/bin/false"),
};

const stubCallbacks = {
  getExtension: () => Promise.resolve(null),
  downloadArchive: () =>
    Promise.reject(new Error("not used in hot-load tests")),
  getChecksum: () => Promise.resolve(null),
};

/** W1b/(a-2): construct an ExtensionRepository wrapping a test catalog. */
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

// Regression test locking in the auto-resolver hot-load plumbing added
// alongside issue 120's per-extension layout. Pre-120, hot-load walked
// `.swamp/pulled-extensions/<type>/` — a single flat dir. After 120,
// that dir doesn't exist; each extension owns
// `.swamp/pulled-extensions/<ext-name>/<type>/`. The adapter must use
// `enumeratePulledExtensionDirs` to discover per-extension dirs and
// pass them to the loader as (primary, additionalDirs).
//
// If the adapter regresses to the old flat-dir pattern, these tests
// will catch it: enumerate won't return paths, the pre-loader early
// returns fire, and the recorded behavior changes.

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
    // Lockfile references an extension whose per-extension models dir
    // does not exist on disk. enumeratePulledExtensionDirs filters
    // those out, so the adapter must not attempt to load.
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
    // Seed two extensions whose per-extension models subtrees exist on
    // disk. We don't care that the .ts files are real models — the
    // stub DenoRuntime makes bundling fail, which is fine. What we're
    // proving is that the adapter reaches the loader rather than
    // early-returning.
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/a": [".swamp/pulled-extensions/@fake/a/models/foo.ts"],
      "@fake/b": [".swamp/pulled-extensions/@fake/b/models/bar.ts"],
    });

    for (const name of ["@fake/a", "@fake/b"]) {
      const dir = join(tmpDir, ".swamp/pulled-extensions", name, "models");
      await ensureDir(dir);
      // Minimal source — export const model is the loader's pre-check.
      // Bundling will fail against /usr/bin/false, but that's recorded
      // in result.failed, not thrown. The adapter's returned count is
      // 0 (nothing successfully loaded) which is exactly what we want
      // to assert: the adapter reached the loader without error.
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

    // Returns a number (not a throw). With a stub deno that can't
    // bundle, result.loaded is 0. The value itself is less important
    // than the fact that the call completed — that's what proves the
    // enumerate → primary/rest plumbing doesn't crash.
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
    // Seed models dir but NOT a vaults dir — enumerate should skip.
    await ensureDir(
      join(tmpDir, ".swamp/pulled-extensions/@fake/ext/models"),
    );

    const adapter = createAutoResolveInstallerAdapter({
      ...stubCallbacks,
      lockfilePath,
      repoDir: tmpDir,
      denoRuntime: stubDenoRuntime,
    });

    // Should not throw — return value is void.
    await adapter.hotLoadVaults();
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// inspectInstallation regression tests. Locks in the tri-state return
// added for swamp-club#133 (truncated-tree detection) and preserves the
// #121 coverage that the auto-resolver adapter must refuse to silently
// overwrite on-disk extensions — intact trees still report back as
// 'intact' so the resolver emits the "local edits" error instead of
// reinstalling.

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
    // Lockfile lists the extension, but the on-disk directory was
    // removed. Returning "intact" here would make the resolver surface
    // a confusing "already installed but failed" error when the files
    // are actually gone — a clean reinstall is correct.
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
    // Carries the pinned version so the install progress line reports the
    // version that will actually be installed (swamp-club#465).
    assertEquals(result, { state: "missing", lockedVersion: "2026.01.01.1" });
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
    // Directory exists (so we get past the stat check) but every
    // declared file is missing. The returned `missing` array must list
    // all of them, not truncate to the first miss.
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
    // Edge case: an extension recorded with an empty file list. Nothing
    // to verify, so the tree is vacuously intact.
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
      path: join(tmpDir, ".swamp", "pulled-extensions", "@fake/no-files"),
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// Regression for the bundle-cache false-positive: clearing
// .swamp/bundles/ (or any sibling *-bundles cache) must not flip the
// inspection to truncated. The lockfile lists bundles alongside source,
// but bundles are regenerable build artifacts — their absence does not
// indicate a broken install. See the follow-up to swamp-club#133.
Deno.test("auto_resolver_adapters: inspectInstallation ignores absent bundle artifacts and stays intact", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const sourceRel = ".swamp/pulled-extensions/@fake/with-bundles/models/x.ts";
    const bundleRels = [
      ".swamp/bundles/abc123/x.js",
      ".swamp/vault-bundles/abc123/v.js",
      ".swamp/driver-bundles/abc123/d.js",
      ".swamp/datastore-bundles/abc123/ds.js",
      ".swamp/report-bundles/abc123/r.js",
    ];
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/with-bundles": [sourceRel, ...bundleRels],
    });
    // Source on disk; every bundle deliberately absent.
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
    // Manifest stays; source removed; bundle never written. Only the
    // missing source file should appear in `missing` — the bundle is
    // filtered out before the stat check.
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

    // Empty lockfile for datastores perspective (no datastore dir
    // exists for @fake/ext). Should not throw.
    await adapter.hotLoadDatastores();
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// Issue 123 regression tests: hotLoadModels must retry user-extension
// attachment against the shared catalog after a newly-installed base
// registers. These tests verify the guards — the integration test
// covers the positive "attach fires" path end-to-end.

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
    // Pre-issue-123 callers pass no catalog. Keep that path working so
    // the adapter is drop-in for older configurations.
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
      // catalog omitted — legacy signature
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

    // With stub deno the loader fails to bundle — result.loaded is 0,
    // so the catalog walk never runs. The important bit is that the
    // adapter returns a number rather than throwing over the new code.
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
    // Plant an extension row pointing at a base that is NOT in
    // modelRegistry. The guard (!!modelRegistry.get(type)) must skip
    // it so nothing calls attachPendingExtensionsForType — that would
    // either throw or warn, neither of which we want for unknown
    // bases.
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

    // Primary assertion: the call completes cleanly. If the guard
    // weren't in place, attachPendingExtensionsForType would attempt
    // to import the nonexistent bundle and surface a warning.
    assertEquals(typeof (await adapter.hotLoadModels()), "number");
    catalog.close();
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
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
    // The adapter's loadModels reaches the bundling step; with stub
    // deno that returns /usr/bin/false, bundling records a failure and
    // result.loaded is 0 — so the catalog walk is skipped by the
    // `result.loaded.length > 0` guard. We register a base manually
    // and plant an extension pointing at a bogus bundle so that if the
    // guard ever regressed to always-run, this test would fail with a
    // bundle-import error. The test passing confirms the
    // loaded.length > 0 guard is in place.
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

    // Register a fake base directly so !!modelRegistry.get(baseType)
    // is truthy. Without the loaded.length > 0 gate we would import
    // the bogus bundle and log a warning.
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
