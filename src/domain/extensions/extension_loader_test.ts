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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { join } from "@std/path";
import { toFileUrl } from "@std/path";
import { findStaleFiles, type FreshnessCatalog } from "./bundle_freshness.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import type { ExtensionTypeRow } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionLoader } from "./extension_loader.ts";
import type { KindAdapter } from "./kind_adapter.ts";
import { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import type { DenoRuntime } from "../runtime/deno_runtime.ts";

Deno.test("importBundleByPath: non-empty fingerprint appends ?fp= to import URL", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_fp_url_" });
  try {
    const bundlePath = join(dir, "fp_present.js");
    await Deno.writeTextFile(
      bundlePath,
      'export const model = { name: "test" };\n',
    );

    const baseUrl = toFileUrl(bundlePath).href;
    const fpUrl = `${baseUrl}?fp=abc123`;

    const mod = await import(fpUrl);
    assertEquals(mod.model.name, "test");
    assertStringIncludes(fpUrl, "?fp=abc123");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("importBundleByPath: empty fingerprint produces bare URL without ?fp=", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_fp_empty_url_" });
  try {
    const bundlePath = join(dir, "fp_empty.js");
    await Deno.writeTextFile(
      bundlePath,
      'export const model = { name: "legacy" };\n',
    );

    const fingerprint = "";
    const baseUrl = toFileUrl(bundlePath).href;
    const importUrl = fingerprint ? `${baseUrl}?fp=${fingerprint}` : baseUrl;

    assertEquals(importUrl.includes("?fp="), false);

    const mod = await import(importUrl);
    assertEquals(mod.model.name, "legacy");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("importBundleByPath: undefined fingerprint produces bare URL without ?fp=", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_fp_undef_url_" });
  try {
    const bundlePath = join(dir, "fp_undef.js");
    await Deno.writeTextFile(
      bundlePath,
      'export const model = { name: "no-fp" };\n',
    );

    const fingerprint: string | undefined = undefined;
    const baseUrl = toFileUrl(bundlePath).href;
    const importUrl = fingerprint ? `${baseUrl}?fp=${fingerprint}` : baseUrl;

    assertEquals(importUrl.includes("?fp="), false);

    const mod = await import(importUrl);
    assertEquals(mod.model.name, "no-fp");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

function buildImportUrl(
  baseUrl: string,
  fingerprint?: string,
  generation = 0,
): string {
  const params = [
    fingerprint ? `fp=${fingerprint}` : "",
    generation > 0 ? `gen=${generation}` : "",
  ].filter(Boolean).join("&");
  return params ? `${baseUrl}?${params}` : baseUrl;
}

// -- incrementReloadGeneration / URL cache busting (swamp-club#1140) ------

import { incrementReloadGeneration } from "./extension_loader.ts";

Deno.test("incrementReloadGeneration: import URL includes gen= after increment", () => {
  incrementReloadGeneration();
  const url = buildImportUrl("file:///bundle.js", "abc", 1);
  assertStringIncludes(url, "gen=1");
  assertStringIncludes(url, "fp=abc");
  assertEquals(url, "file:///bundle.js?fp=abc&gen=1");
});

Deno.test("incrementReloadGeneration: gen=0 omitted from URL", () => {
  const url = buildImportUrl("file:///bundle.js", "abc", 0);
  assertEquals(url, "file:///bundle.js?fp=abc");
  assertEquals(url.includes("gen="), false);
});

Deno.test("incrementReloadGeneration: gen-only URL when no fingerprint", () => {
  const url = buildImportUrl("file:///bundle.js", undefined, 2);
  assertEquals(url, "file:///bundle.js?gen=2");
});

Deno.test("incrementReloadGeneration: bare URL when no fingerprint and gen=0", () => {
  const url = buildImportUrl("file:///bundle.js", undefined, 0);
  assertEquals(url, "file:///bundle.js");
  assertEquals(url.includes("?"), false);
});

Deno.test("importBundleByPath: different gen= values bust Deno import cache", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_gen_bust_" });
  try {
    const bundlePath = join(dir, "gen_test.js");
    await Deno.writeTextFile(bundlePath, 'export const v = "V1";\n');

    const baseUrl = toFileUrl(bundlePath).href;
    const mod1 = await import(`${baseUrl}?gen=1`);
    assertEquals(mod1.v, "V1");

    await Deno.writeTextFile(bundlePath, 'export const v = "V2";\n');

    const mod1again = await import(`${baseUrl}?gen=1`);
    assertEquals(mod1again.v, "V1", "same gen= must return cached module");

    const mod2 = await import(`${baseUrl}?gen=2`);
    assertEquals(mod2.v, "V2", "different gen= must return fresh module");
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

Deno.test("fingerprint URL guard: distinct fingerprints produce distinct URLs", () => {
  const baseUrl = "file:///tmp/bundle.js";

  const url1 = buildImportUrl(baseUrl, "fp-aaa");
  const url2 = buildImportUrl(baseUrl, "fp-bbb");
  const url3 = buildImportUrl(baseUrl, "");
  const url4 = buildImportUrl(baseUrl, undefined);

  assertStringIncludes(url1, "?fp=fp-aaa");
  assertStringIncludes(url2, "?fp=fp-bbb");
  assertEquals(url3, baseUrl);
  assertEquals(url3.includes("?fp="), false);
  assertEquals(url4, baseUrl);
  assertEquals(url4.includes("?fp="), false);
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

const stubDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve("/usr/bin/deno"),
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

// -- load() cached-bundle logging (swamp-club#2354) -----------------------

async function loadWithExistingBundle(args: {
  pulled: boolean;
  indexOnly: boolean;
}): Promise<{ records: LogRecord[]; failed: string[] }> {
  const dir = await Deno.makeTempDir({ prefix: "swamp_2354_" });
  const records: LogRecord[] = [];
  try {
    const modelsDir = args.pulled
      ? join(dir, ".swamp", "pulled-extensions", "@test", "ext", "models")
      : join(dir, "extensions", "models");
    await Deno.mkdir(modelsDir, { recursive: true });
    const source =
      'export const model = { type: "@test/cached", name: "cached" };\n';
    await Deno.writeTextFile(join(modelsDir, "cached.ts"), source);

    const { bundleNamespace: bn } = await import(
      "../../infrastructure/persistence/paths.ts"
    );
    const bundleDir = join(dir, ".swamp", "bundles", bn(modelsDir, dir));
    await Deno.mkdir(bundleDir, { recursive: true });
    await Deno.writeTextFile(join(bundleDir, "cached.js"), source);

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

    // A deno binary that does not exist makes any rebundle attempt fail
    // the same way on every platform.
    const missingDenoRuntime: DenoRuntime = {
      ensureDeno: () => Promise.resolve(join(dir, "no-such-deno")),
      getDenoEnv: () => Deno.env.toObject(),
    };
    const loader = new ExtensionLoader(
      missingDenoRuntime,
      makeStubAdapter(new Set<string>()),
      dir,
    );
    const result = await loader.load(modelsDir, {
      indexOnly: args.indexOnly,
    });
    return { records, failed: result.failed.map((f) => f.file) };
  } finally {
    await reset();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function warningTexts(records: LogRecord[]): string[] {
  return records
    .filter((r) => r.level === "warning")
    .map((r) => r.message.map(String).join(""));
}

for (const indexOnly of [true, false]) {
  Deno.test(`load: pulled extension with an existing bundle logs no warning (indexOnly=${indexOnly})`, async () => {
    const { records, failed } = await loadWithExistingBundle({
      pulled: true,
      indexOnly,
    });

    assertEquals(failed, [], "trusted pulled bundle must load");
    assertEquals(
      warningTexts(records),
      [],
      "reusing a pulled extension's bundle is not a failure",
    );
    const trusted = records.filter((r) =>
      r.message.map(String).join("").includes(
        "Using existing bundle for pulled extension",
      )
    );
    assertEquals(trusted.map((r) => r.level), ["debug"]);
  });

  Deno.test(`load: failed rebundle with an existing bundle warns once with the error (indexOnly=${indexOnly})`, async () => {
    const { records, failed } = await loadWithExistingBundle({
      pulled: false,
      indexOnly,
    });

    assertEquals(failed, [], "cached bundle must be used after the failure");
    const warnings = warningTexts(records);
    assertEquals(warnings.length, 1, "exactly one warning per failed rebundle");
    assertStringIncludes(warnings[0], "Rebundle failed for");
    assertStringIncludes(warnings[0], "using cached bundle:");
  });
}
