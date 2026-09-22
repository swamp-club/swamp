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

import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { join } from "@std/path";
import { toFileUrl } from "@std/path";
import { findStaleFiles, type FreshnessCatalog } from "./bundle_freshness.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import type { ExtensionTypeRow } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { bundleImportUrl, ExtensionLoader } from "./extension_loader.ts";
import type { KindAdapter } from "./kind_adapter.ts";
import { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import type { DenoRuntime } from "../runtime/deno_runtime.ts";

// -- Content-addressed bundle import URLs (swamp-club#1140, #2340) -------

Deno.test("bundleImportUrl: identical content produces the same URL", async () => {
  const js = 'export const v = "V1";\n';
  const first = await bundleImportUrl("/tmp/bundle.js", js, "abc");
  const second = await bundleImportUrl("/tmp/bundle.js", js, "abc");
  assertEquals(first, second);
});

Deno.test("bundleImportUrl: different content produces a different URL", async () => {
  const v1 = await bundleImportUrl(
    "/tmp/bundle.js",
    'export const v = "V1";\n',
  );
  const v2 = await bundleImportUrl(
    "/tmp/bundle.js",
    'export const v = "V2";\n',
  );
  assertNotEquals(v1, v2);
});

Deno.test("bundleImportUrl: includes fp= when a fingerprint is given", async () => {
  const url = await bundleImportUrl("/tmp/bundle.js", "export {};\n", "abc123");
  assertStringIncludes(url, "?fp=abc123&h=");
});

Deno.test("bundleImportUrl: omits fp= when the fingerprint is empty", async () => {
  const url = await bundleImportUrl("/tmp/bundle.js", "export {};\n", "");
  assertEquals(url.includes("fp="), false);
  assertStringIncludes(url, "?h=");
});

Deno.test("importBundleByPath: unchanged bundle reuses the cached module", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_import_reuse_" });
  try {
    const bundlePath = join(dir, "reuse.js");
    await Deno.writeTextFile(bundlePath, 'export const v = "V1";\n');
    const loader = new ExtensionLoader(
      stubDenoRuntime,
      makeStubAdapter(new Set()),
      dir,
    );
    const paths = { bundlePath, sourcePath: join(dir, "reuse.ts") };

    const first = await loader.importBundleByPath(paths);
    const second = await loader.importBundleByPath(paths);

    assertStrictEquals(second, first);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("importBundleByPath: changed bundle imports the new code", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_import_change_" });
  try {
    const bundlePath = join(dir, "change.js");
    await Deno.writeTextFile(bundlePath, 'export const v = "V1";\n');
    const loader = new ExtensionLoader(
      stubDenoRuntime,
      makeStubAdapter(new Set()),
      dir,
    );
    const paths = { bundlePath, sourcePath: join(dir, "change.ts") };

    const v1 = await loader.importBundleByPath(paths);
    assertEquals(v1.v, "V1");

    await Deno.writeTextFile(bundlePath, 'export const v = "V2";\n');
    const v2 = await loader.importBundleByPath(paths);
    assertEquals(v2.v, "V2");

    await Deno.writeTextFile(bundlePath, 'export const v = "V1";\n');
    const v1Again = await loader.importBundleByPath(paths);
    assertStrictEquals(v1Again, v1);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// -- Discovery _test.ts filtering (swamp-club#389) -----------------------

class StubCatalog implements FreshnessCatalog {
  findByKind(): ExtensionTypeRow[] {
    return [];
  }
  removeBySourcePath(): void {}
}

const discoverExcludingTestFiles = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (
      entry.isFile && entry.name.endsWith(".ts") &&
      !entry.name.endsWith("_test.ts")
    ) {
      out.push(entry.name);
    }
  }
  return out.sort();
};

const discoverIncludingTestFiles = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".ts")) {
      out.push(entry.name);
    }
  }
  return out.sort();
};

Deno.test("discovery: _test.ts files excluded from local dir discovery", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_discover_local_" });
  try {
    await Deno.writeTextFile(
      join(dir, "my_model.ts"),
      "export const model = {};",
    );
    await Deno.writeTextFile(
      join(dir, "my_model_test.ts"),
      "import { model } from './my_model.ts';",
    );

    const stale = await findStaleFiles({
      modelsDir: dir,
      catalog: new StubCatalog(),
      discoverFiles: discoverExcludingTestFiles,
      kinds: ["model"],
    });

    assertEquals(
      stale.map((s) => s.relativePath),
      ["my_model.ts"],
      "_test.ts files must be excluded from local dir discovery",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("discovery: _test.ts files included from additional dir discovery", async () => {
  const localDir = await Deno.makeTempDir({
    prefix: "swamp_discover_adl_local_",
  });
  const pulledDir = await Deno.makeTempDir({
    prefix: "swamp_discover_adl_pulled_",
  });
  try {
    await Deno.writeTextFile(
      join(localDir, "local_model.ts"),
      "export const model = {};",
    );
    await Deno.writeTextFile(
      join(localDir, "local_model_test.ts"),
      "import { model } from './local_model.ts';",
    );
    await Deno.writeTextFile(
      join(pulledDir, "docker_image_test.ts"),
      "export const model = {};",
    );

    const additionalSet = new Set([pulledDir]);
    const stale = await findStaleFiles({
      modelsDir: localDir,
      additionalDirs: [pulledDir],
      catalog: new StubCatalog(),
      discoverFiles: (d) =>
        additionalSet.has(d)
          ? discoverIncludingTestFiles(d)
          : discoverExcludingTestFiles(d),
      kinds: ["model"],
    });

    const found = stale.map((s) => s.relativePath).sort();
    assertEquals(
      found,
      ["docker_image_test.ts", "local_model.ts"],
      "_test.ts must be excluded from local dir but included from additional (pulled/source) dirs",
    );
  } finally {
    await Deno.remove(localDir, { recursive: true }).catch(() => {});
    await Deno.remove(pulledDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("fingerprint URL guard: distinct fingerprints produce distinct URLs", async () => {
  const js = "export {};\n";

  const url1 = await bundleImportUrl("/tmp/bundle.js", js, "fp-aaa");
  const url2 = await bundleImportUrl("/tmp/bundle.js", js, "fp-bbb");
  const url3 = await bundleImportUrl("/tmp/bundle.js", js, "");
  const url4 = await bundleImportUrl("/tmp/bundle.js", js, undefined);

  assertStringIncludes(url1, "?fp=fp-aaa");
  assertStringIncludes(url2, "?fp=fp-bbb");
  assertNotEquals(url1, url2);
  assertEquals(url3.includes("fp="), false);
  assertEquals(url4, url3);
});

// -- BundleBuildFailed stale-entry preservation (swamp-club#894) -----------

Deno.test("findStaleFiles: BundleBuildFailed entries for missing sources are preserved in catalog", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_stale_bbf_" });
  try {
    const dbPath = join(dir, "catalog.db");
    const catalog = new ExtensionCatalogStore(dbPath);
    try {
      const existingSource = join(dir, "valid_model.ts");
      const deletedSource = join(dir, "deleted_model.ts");
      await Deno.writeTextFile(existingSource, "export const model = {};");

      catalog.upsert({
        source_path: existingSource,
        type_normalized: "valid-model",
        kind: "model",
        bundle_path: join(dir, "valid_model.js"),
        version: "1.0.0",
        description: "",
        extends_type: "",
        source_mtime: "",
        source_fingerprint: "fp-valid",
        state: "Indexed",
        extension_name: "@local/test",
        extension_version: "1.0.0",
        last_error: "",
      });

      catalog.upsert({
        source_path: deletedSource,
        type_normalized: "",
        kind: "model",
        bundle_path: "",
        version: "1.0.0",
        description: "",
        extends_type: "",
        source_mtime: "",
        source_fingerprint: "fp-deleted",
        state: "BundleBuildFailed",
        extension_name: "@local/test",
        extension_version: "1.0.0",
        last_error: "some build error",
      });

      await findStaleFiles({
        modelsDir: dir,
        catalog,
        discoverFiles: discoverExcludingTestFiles,
        kinds: ["model"],
      });

      const remaining = catalog.findByKind("model");
      const bbfEntry = remaining.find((r) => r.state === "BundleBuildFailed");
      assertEquals(
        bbfEntry !== undefined,
        true,
        "BundleBuildFailed entry for deleted source must be preserved by findStaleFiles (reconcile handles cleanup)",
      );

      const indexedEntry = remaining.find((r) => r.state === "Indexed");
      assertEquals(
        indexedEntry !== undefined,
        true,
        "Indexed entry for existing source must survive",
      );
    } finally {
      catalog.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("findStaleFiles: ValidationFailed entries for missing sources are removed from catalog", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_stale_vf_" });
  try {
    const dbPath = join(dir, "catalog.db");
    const catalog = new ExtensionCatalogStore(dbPath);
    try {
      const deletedSource = join(dir, "deleted_model.ts");

      catalog.upsert({
        source_path: deletedSource,
        type_normalized: "",
        kind: "model",
        bundle_path: "",
        version: "1.0.0",
        description: "",
        extends_type: "",
        source_mtime: "",
        source_fingerprint: "fp-deleted",
        state: "ValidationFailed",
        extension_name: "@local/test",
        extension_version: "1.0.0",
        last_error: "validation error",
      });

      await findStaleFiles({
        modelsDir: dir,
        catalog,
        discoverFiles: discoverExcludingTestFiles,
        kinds: ["model"],
      });

      const remaining = catalog.findByKind("model");
      assertEquals(
        remaining.length,
        0,
        "ValidationFailed entry for deleted source must be removed by findStaleFiles",
      );
    } finally {
      catalog.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// -- loadSingleType skip-with-warning for broken bundles (swamp-club#1018) ----

function makeStubAdapter(loaded: Set<string>): KindAdapter {
  return {
    kind: "model",
    bundleSubdir: "bundles",
    catalogKinds: ["model"],
    primaryExportKey: "model",
    exportRegex: /export\s+const\s+model\s*[=:]/,
    useResolver: false,
    validatePrimaryExport() {
      return { success: true, data: {} };
    },
    formatValidationError() {
      return "validation error";
    },
    normalizeType() {
      return "";
    },
    extractTypeFromSource() {
      return null;
    },
    register() {},
    registerLazy() {},
    promoteFromLazy(_type, _validated, _module, _ctx) {
      loaded.add(_type);
    },
    hasType(type) {
      return loaded.has(type);
    },
    isFullyLoaded(type) {
      return loaded.has(type);
    },
  };
}

/**
 * A DenoRuntime whose binary does not exist.
 *
 * The path used to be `/usr/bin/deno`, which is where a distro package puts a
 * perfectly real Deno. `load: indexOnly records bundling failures` needs
 * bundling to fail, and it fails by not finding the binary — so on any machine
 * that installed Deno from its package manager the bundle succeeded,
 * `result.failed` came back empty, and the assertion blew up. It passed only
 * where Deno happened to live somewhere else, which is why it read as a flake
 * belonging to whoever hit it rather than as a wrong constant.
 *
 * Keep the path fictional. Nothing here wants a working Deno: the tests that
 * bundle successfully take the `trustPulledCache` fast path, which never
 * spawns one.
 */
const stubDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve("/nonexistent/swamp-test/deno"),
  getDenoEnv: () => Deno.env.toObject(),
};

// -- load() indexOnly (swamp-club#1684) -----------------------------------

Deno.test("load: indexOnly bundles files without importing or registering types", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_1684_" });
  try {
    // Set up a pulled-extensions directory structure so bundleWithCache
    // takes the trustPulledCache fast path (no Deno subprocess).
    const pulledDir = join(dir, ".swamp", "pulled-extensions", "@test", "ext");
    const modelsDir = join(pulledDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });

    const sourcePath = join(modelsDir, "my_type.ts");
    await Deno.writeTextFile(
      sourcePath,
      'export const model = { type: "@test/my-type", name: "my-type" };\n',
    );

    // Pre-create the bundle at the expected path so bundleWithCache
    // returns it from cache without shelling out to Deno.
    const { bundleNamespace: bn } = await import(
      "../../infrastructure/persistence/paths.ts"
    );
    const ns = bn(modelsDir, dir);
    const bundleDir = join(dir, ".swamp", "bundles", ns);
    await Deno.mkdir(bundleDir, { recursive: true });
    const bundlePath = join(bundleDir, "my_type.js");
    await Deno.writeTextFile(
      bundlePath,
      'export const model = { type: "@test/my-type", name: "my-type" };\n',
    );

    const registered = new Set<string>();
    const adapter = makeStubAdapter(registered);

    const loader = new ExtensionLoader(
      stubDenoRuntime,
      adapter,
      dir,
      undefined,
      undefined,
    );

    const result = await loader.load(modelsDir, { indexOnly: true });

    assertEquals(
      result.loaded.length > 0,
      true,
      "indexOnly should report files as loaded (bundled)",
    );
    assertEquals(
      registered.size,
      0,
      "indexOnly must not register any types — they should stay lazy",
    );
    assertEquals(
      result.extended.length,
      0,
      "indexOnly must not process secondary exports",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("load: without indexOnly imports and registers types normally", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_1684_eager_" });
  try {
    const pulledDir = join(dir, ".swamp", "pulled-extensions", "@test", "ext");
    const modelsDir = join(pulledDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });

    const sourcePath = join(modelsDir, "eager_type.ts");
    await Deno.writeTextFile(
      sourcePath,
      'export const model = { type: "@test/eager", name: "eager" };\n',
    );

    const { bundleNamespace: bn } = await import(
      "../../infrastructure/persistence/paths.ts"
    );
    const ns = bn(modelsDir, dir);
    const bundleDir = join(dir, ".swamp", "bundles", ns);
    await Deno.mkdir(bundleDir, { recursive: true });
    const bundlePath = join(bundleDir, "eager_type.js");
    await Deno.writeTextFile(
      bundlePath,
      'export const model = { type: "@test/eager", name: "eager" };\n',
    );

    const registered = new Set<string>();
    const adapter: KindAdapter = {
      kind: "model",
      bundleSubdir: "bundles",
      catalogKinds: ["model"],
      primaryExportKey: "model",
      exportRegex: /export\s+const\s+model\s*[=:]/,
      useResolver: false,
      validatePrimaryExport() {
        return { success: true, data: { type: "@test/eager" } };
      },
      formatValidationError() {
        return "validation error";
      },
      normalizeType(validated: Record<string, unknown>) {
        return String(validated.type ?? "");
      },
      extractTypeFromSource() {
        return null;
      },
      register(type: string) {
        registered.add(type);
      },
      registerLazy() {},
      promoteFromLazy() {},
      hasType(type) {
        return registered.has(type);
      },
      isFullyLoaded(type) {
        return registered.has(type);
      },
    };

    const loader = new ExtensionLoader(
      stubDenoRuntime,
      adapter,
      dir,
      undefined,
      undefined,
    );

    const result = await loader.load(modelsDir, {
      skipAlreadyRegistered: true,
    });

    assertEquals(
      result.loaded.length > 0,
      true,
      "eager load should report files as loaded",
    );
    assertEquals(
      registered.has("@test/eager"),
      true,
      "eager load must register the type",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("load: indexOnly records bundling failures", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_1684_fail_" });
  try {
    const modelsDir = join(dir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });

    // Source file that matches exportRegex but has no pre-existing bundle
    // and no real Deno to bundle it — bundleWithCache will fail.
    const sourcePath = join(modelsDir, "broken.ts");
    await Deno.writeTextFile(
      sourcePath,
      'export const model = { type: "@test/broken" };\n',
    );

    const registered = new Set<string>();
    const adapter = makeStubAdapter(registered);

    const loader = new ExtensionLoader(
      stubDenoRuntime,
      adapter,
      dir,
      undefined,
      undefined,
    );

    const result = await loader.load(modelsDir, { indexOnly: true });

    assertEquals(
      result.failed.length > 0,
      true,
      "bundling failure should be recorded",
    );
    assertEquals(
      registered.size,
      0,
      "failed bundles must not register types",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("loadSingleType: skips bundle without primary export and removes catalog entry", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_1018_" });
  try {
    const bundlePath = join(dir, "helper.js");
    await Deno.writeTextFile(
      bundlePath,
      "export const helper = true;\n",
    );

    const sourcePath = join(dir, "helper.ts");
    await Deno.writeTextFile(sourcePath, "");

    const dbPath = join(dir, "catalog.db");
    const catalog = new ExtensionCatalogStore(dbPath);
    try {
      catalog.upsert({
        type_normalized: "@test/broken",
        kind: "model",
        bundle_path: bundlePath,
        source_path: sourcePath,
        version: "1.0.0",
        description: "",
        extends_type: "",
        source_mtime: "",
        source_fingerprint: "",
      });

      assertEquals(
        catalog.findByType("@test/broken", "model") !== undefined,
        true,
        "catalog entry must exist before loadSingleType",
      );

      const loaded = new Set<string>();
      const adapter = makeStubAdapter(loaded);
      const lockfileRepo = new LockfileRepository(join(dir, "lockfile.json"));
      const repository = new ExtensionRepository({
        catalog,
        lockfileRepository: lockfileRepo,
        repoRoot: dir,
      });
      const loader = new ExtensionLoader(
        stubDenoRuntime,
        adapter,
        dir,
        undefined,
        repository,
      );

      await loader.loadSingleType("@test/broken", {
        bundlePath,
        sourcePath,
      });

      assertEquals(
        loaded.has("@test/broken"),
        false,
        "broken bundle must not be promoted",
      );
      assertEquals(
        catalog.findByType("@test/broken", "model"),
        undefined,
        "stale catalog entry must be removed after skip",
      );
    } finally {
      catalog.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("importBundle: file URL import error propagates instead of falling to data URL", async () => {
  // A bundle that throws ERR_INVALID_ARG_VALUE when imported via data: URL
  // because createRequire rejects non-file URLs. The file URL import should
  // succeed, so this test verifies the data: URL fallback is NOT reached
  // when the bundle file exists on disk.
  const dir = await Deno.makeTempDir({ prefix: "swamp_import_propagate_" });
  try {
    const bundlePath = join(dir, "throwing_bundle.js");
    const throwingJs = `import { createRequire } from "node:module";\n` +
      `const require = createRequire(import.meta.url);\n` +
      `export const model = { type: "@test/propagate" };\n`;
    await Deno.writeTextFile(bundlePath, throwingJs);

    // Importing from a file URL should succeed (createRequire accepts file URLs)
    const baseUrl = toFileUrl(bundlePath).href;
    const mod = await import(`${baseUrl}?fp=test`);
    assertEquals(mod.model.type, "@test/propagate");

    // Importing from a data: URL should fail (createRequire rejects data: URLs)
    const encoded = btoa(throwingJs);
    await assertRejects(
      () => import(`data:application/javascript;base64,${encoded}`),
      TypeError,
      "must be a file URL",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// -- helper-module skip message (swamp-club#2318) ----------------------------

async function loadHelperOnlyDir(
  indexOnly: boolean,
): Promise<{ records: LogRecord[]; loaded: string[]; failed: string[] }> {
  const dir = await Deno.makeTempDir({ prefix: "swamp_2318_" });
  const records: LogRecord[] = [];
  try {
    const modelsDir = join(dir, "models");
    await Deno.mkdir(join(modelsDir, "demo", "lib"), { recursive: true });
    await Deno.writeTextFile(
      join(modelsDir, "demo", "lib", "helper.ts"),
      "export function greet(n: string): string { return n; }\n",
    );

    await configure({
      sinks: { capture: (record: LogRecord) => records.push(record) },
      loggers: [
        {
          category: ["swamp", "model", "loader"],
          lowestLevel: "debug",
          sinks: ["capture"],
        },
        { category: ["logtape", "meta"], lowestLevel: "warning", sinks: [] },
      ],
      reset: true,
    });

    const loader = new ExtensionLoader(
      stubDenoRuntime,
      makeStubAdapter(new Set<string>()),
      dir,
    );
    const result = await loader.load(modelsDir, { indexOnly });
    return {
      records,
      loaded: result.loaded,
      failed: result.failed.map((f) => f.file),
    };
  } finally {
    await reset();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

for (const indexOnly of [true, false]) {
  Deno.test(`load: file without model export is logged at debug as a helper module (indexOnly=${indexOnly})`, async () => {
    const { records, loaded, failed } = await loadHelperOnlyDir(indexOnly);

    assertEquals(loaded, [], "helper modules must not be loaded");
    assertEquals(failed, [], "helper modules must not be reported as failed");

    const helperFile = join("demo", "lib", "helper.ts");
    const helperRecords = records.filter((r) =>
      r.message.some((part) => part === helperFile)
    );
    assertEquals(
      helperRecords.map((r) => r.level),
      ["debug"],
      "helper module must be logged exactly once, at debug",
    );
    const text = helperRecords[0].message.map(String).join("");
    assertStringIncludes(text, "as a helper module");
    assertStringIncludes(text, "not a model entry point");
  });
}
