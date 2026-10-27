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

/**
 * Push and quality treat the extension's lockfile as read-only
 * (swamp-club#3613): the module graph read and the bundle run with
 * `--frozen` when the project has a lock and `--no-lock` when it has none,
 * so a stale lock is refused rather than rewritten and no lock is created.
 * Wires the real Deno, module graph reader and bundler as push does, offline:
 * the shared cache supplies esbuild and the npm registry is unreachable.
 *
 * `extension fmt` reads the module graph the same way (swamp-club#3717), but
 * leniently: a stale lock is reported, and the entry points it refused are
 * formatted alone, rather than failing the run.
 *
 * The extension loader, which every command runs at startup, reads the lock
 * read-only too (swamp-club#3869), so an extension in the repository's
 * loaded extensions dir keeps its lock: a stale one warns and loads without
 * it, and the lock is part of the bundle's fingerprint.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { TarStream } from "@std/tar/tar-stream";
import { stringify as stringifyYaml } from "@std/yaml";
import { configure, getLogger, type LogRecord, reset } from "@logtape/logtape";
import { UserError } from "../src/domain/errors.ts";
import {
  checkExtensionQuality,
  denoToolConfigArgs,
  extensionLintArgs,
} from "../src/domain/extensions/extension_quality_checker.ts";
import { bundleExtension } from "../src/domain/models/bundle.ts";
import { resolveExtensionFiles } from "../src/cli/resolve_extension_files.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import {
  extensionFmt,
  type ExtensionFmtData,
  type ExtensionFmtDeps,
} from "../src/libswamp/extensions/fmt.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { collect } from "../src/libswamp/testing.ts";
import {
  type ExtensionProject,
  readOnlyLockFor,
} from "../src/infrastructure/runtime/deno_lockfile_reader.ts";
import { SHARED_SWAMP_DENO_CACHE } from "./test_helpers.ts";
import { ExtensionLoader } from "../src/domain/extensions/extension_loader.ts";
import { findStaleFiles } from "../src/domain/extensions/bundle_freshness.ts";
import { modelKindAdapter } from "../src/domain/extensions/model_kind_adapter.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import { ReconcileFromDiskService } from "../src/libswamp/extensions/reconcile_from_disk_service.ts";
import {
  createDenoInfoModuleGraphReader,
  DenoInfoModuleGraphReader,
} from "../src/infrastructure/runtime/deno_info_module_graph_reader.ts";

import "../src/domain/models/models.ts";

const ENV = {
  DENO_DIR: SHARED_SWAMP_DENO_CACHE,
  NPM_CONFIG_REGISTRY: "http://127.0.0.1:1/",
};

// The issue's repro: the lock records npm:ms@^2.0.0 at 2.0.0, and deno.json
// has since moved the specifier past it.
const MS_LOCK = JSON.stringify(
  {
    version: "5",
    specifiers: { "npm:ms@2": "2.0.0" },
    npm: {
      "ms@2.0.0": {
        integrity:
          "sha512-Tpp60P6IUJDTuOq/5Z8cdskzJujfwqfOTkrwIwj7IRISpnkJnT6SyJ4PCPnGMoFjC9ddhal5KVIYtAt97ix05A==",
      },
    },
    workspace: { dependencies: ["npm:ms@^2.0.0"] },
  },
  null,
  2,
) + "\n";

async function withProject(
  files: Record<string, string>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-lock-read-only-" }),
  );
  try {
    await Deno.writeTextFile(join(dir, "mod.ts"), "export const x = 1;\n");
    for (const [name, text] of Object.entries(files)) {
      await Deno.writeTextFile(join(dir, name), text);
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

/** Reads the module graph and bundles `mod.ts` the way push and quality do. */
async function readAndBundle(
  dir: string,
  project: ExtensionProject,
): Promise<void> {
  const entry = join(dir, "mod.ts");
  await new DenoInfoModuleGraphReader(Deno.execPath(), ENV, {
    readOnlyLock: true,
  }).read(entry, project);
  await bundleExtension(entry, Deno.execPath(), {
    ...project,
    readOnlyLock: await readOnlyLockFor(project),
    env: ENV,
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("push lockfile: a stale deno.lock is refused, not rewritten, by the graph read and the bundle", async () => {
  await withProject({
    "deno.json": JSON.stringify({ imports: { ms: "npm:ms@^2.1.0" } }),
    "deno.lock": MS_LOCK,
  }, async (dir) => {
    const project = { denoConfigPath: join(dir, "deno.json") };
    const lockPath = join(dir, "deno.lock");
    const entry = join(dir, "mod.ts");

    const graphError = await assertRejects(
      () =>
        new DenoInfoModuleGraphReader(Deno.execPath(), ENV, {
          readOnlyLock: true,
        }).read(entry, project),
      UserError,
    );
    assertStringIncludes(
      graphError.message,
      `${lockPath} is out of date with ${project.denoConfigPath}`,
    );
    assertStringIncludes(
      graphError.message,
      `deno install --entrypoint ${entry}`,
    );
    assertEquals(await Deno.readTextFile(lockPath), MS_LOCK);

    const readOnlyLock = await readOnlyLockFor(project);
    await assertRejects(
      () =>
        bundleExtension(entry, Deno.execPath(), {
          ...project,
          readOnlyLock,
          env: ENV,
        }),
      UserError,
      `${lockPath} is out of date`,
    );
    assertEquals(await Deno.readTextFile(lockPath), MS_LOCK);
  });
});

Deno.test("push lockfile: a current deno.lock bundles under --frozen and is unchanged", async () => {
  await withProject({
    "deno.json": JSON.stringify({ imports: { ms: "npm:ms@^2.0.0" } }),
    "deno.lock": MS_LOCK,
  }, async (dir) => {
    await readAndBundle(dir, { denoConfigPath: join(dir, "deno.json") });
    assertEquals(await Deno.readTextFile(join(dir, "deno.lock")), MS_LOCK);
  });
});

Deno.test("push lockfile: a deno.json project without a lock gets none", async () => {
  await withProject({
    "deno.json": JSON.stringify({ imports: { ms: "npm:ms@^2.0.0" } }),
  }, async (dir) => {
    await readAndBundle(dir, { denoConfigPath: join(dir, "deno.json") });
    assertEquals(await exists(join(dir, "deno.lock")), false);
  });
});

Deno.test("push lockfile: a package.json project without a lock gets none", async () => {
  await withProject({ "package.json": "{}" }, async (dir) => {
    await Deno.mkdir(join(dir, "node_modules"));
    await readAndBundle(dir, { packageJsonDir: dir });
    assertEquals(await exists(join(dir, "deno.lock")), false);
  });
});

/**
 * A one-package npm registry on a free localhost port, so the module graph
 * read resolves a real npm import, and writes a lock unless told not to,
 * without the network. `fn` gets the environment that points deno at it,
 * with a fresh DENO_DIR so nothing it caches outlives the test, and the
 * deno.lock a project mapping `lockpkg` to `^1.0.0` resolves to.
 */
async function withLockRegistry(
  fn: (env: Record<string, string>, currentLock: string) => Promise<void>,
): Promise<void> {
  const encoder = new TextEncoder();
  const entry = (path: string, text: string) => {
    const bytes = encoder.encode(text);
    return {
      type: "file" as const,
      path,
      size: bytes.length,
      readable: ReadableStream.from([bytes]),
    };
  };
  const tarball = new Uint8Array(
    await new Response(
      ReadableStream.from([
        entry(
          "package/package.json",
          JSON.stringify({ name: "lockpkg", version: "1.0.0" }),
        ),
        entry("package/index.js", "module.exports = 1;\n"),
      ]).pipeThrough(new TarStream()).pipeThrough(
        new CompressionStream("gzip"),
      ),
    ).arrayBuffer(),
  );
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-512", tarball),
  );
  const integrity = `sha512-${btoa(String.fromCharCode(...digest))}`;
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/lockpkg") {
      return Response.json({
        name: "lockpkg",
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            name: "lockpkg",
            version: "1.0.0",
            dist: { tarball: `${url.origin}/lockpkg.tgz`, integrity },
          },
        },
      });
    }
    if (url.pathname === "/lockpkg.tgz") return new Response(tarball);
    return new Response("not found", { status: 404 });
  });
  const origin = `http://127.0.0.1:${server.addr.port}`;
  // As deno install writes it; deno info writes none on Windows.
  const currentLock = JSON.stringify(
    {
      version: "5",
      specifiers: { "npm:lockpkg@1": "1.0.0" },
      npm: {
        "lockpkg@1.0.0": { integrity, tarball: `${origin}/lockpkg.tgz` },
      },
      workspace: { dependencies: ["npm:lockpkg@1"] },
    },
    null,
    2,
  ) + "\n";
  const denoDir = await Deno.makeTempDir({ prefix: "swamp-lock-deno-dir-" });
  try {
    await fn({
      DENO_DIR: denoDir,
      NPM_CONFIG_REGISTRY: `${origin}/`,
    }, currentLock);
  } finally {
    await server.shutdown();
    await Deno.remove(denoDir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

/** Runs `deno <args>` in `env` and returns its output. */
async function runDeno(
  args: string[],
  env: Record<string, string>,
): Promise<string> {
  const output = await new Deno.Command(Deno.execPath(), {
    args,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return (decoder.decode(output.stderr) + decoder.decode(output.stdout))
    .trim();
}

/** fmt's dependencies, as createExtensionFmtDeps wires them, in `env`. */
function fmtDeps(env: Record<string, string>): ExtensionFmtDeps {
  return {
    checkQuality: (files, denoConfigPath) =>
      checkExtensionQuality(files, Deno.execPath(), denoConfigPath, env),
    runFmt: (files, denoConfigPath) =>
      runDeno(["fmt", ...denoToolConfigArgs(denoConfigPath), ...files], env),
    runLint: async (files, denoConfigPath) =>
      runDeno(
        [...(await extensionLintArgs(denoConfigPath)), "--fix", ...files],
        env,
      ),
  };
}

/**
 * A one-model extension at the repository root, which holds the project
 * deno.json mapping `lockpkg`; the model imports it. Returns the manifest.
 */
async function writeLockExtension(
  dir: string,
  range: string,
): Promise<string> {
  await Deno.writeTextFile(
    join(dir, ".swamp.yaml"),
    stringifyYaml({ swampVersion: "0.1.0" }),
  );
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ imports: { lockpkg: `npm:lockpkg@${range}` } }),
  );
  await Deno.mkdir(join(dir, "extensions", "models"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "extensions", "models", "m.ts"),
    'import value from "lockpkg";\n\nexport const m = value;\n',
  );
  const manifestPath = join(dir, "manifest.yaml");
  await Deno.writeTextFile(
    manifestPath,
    stringifyYaml({
      manifestVersion: 1,
      name: "@test/lock",
      version: "2026.10.21.1",
      models: ["m.ts"],
    }),
  );
  return manifestPath;
}

/** Writes `lock`, the lock the project resolves to, and returns it. */
async function writeCurrentLock(dir: string, lock: string): Promise<string> {
  await Deno.writeTextFile(join(dir, "deno.lock"), lock);
  return lock;
}

/**
 * Runs `extension fmt` (or `fmt --check`) as the command does: resolves the
 * extension's files leniently with the read-only graph reader, then formats
 * and lints them under the project config.
 */
async function fmtExtension(
  dir: string,
  manifestPath: string,
  env: Record<string, string>,
  check: boolean,
): Promise<ExtensionFmtData> {
  const resolved = await resolveExtensionFiles({
    repoDir: dir,
    manifestPath,
    repoContext: {} as unknown as RepositoryContext,
    logger: getLogger(["test", "fmt-lockfile"]),
    moduleGraphReader: new DenoInfoModuleGraphReader(Deno.execPath(), env, {
      readOnlyLock: true,
    }),
    lenientSources: true,
  });
  const events = await collect(
    extensionFmt(createLibSwampContext(), fmtDeps(env), {
      tsFiles: resolved.allModelFiles,
      check,
      denoConfigPath: resolved.denoConfigPath,
      staleLockfiles: resolved.staleLockfiles,
    }),
  );
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind !== "completed") {
    throw new Error(`fmt did not complete: ${JSON.stringify(events)}`);
  }
  return completed.data;
}

for (const check of [true, false]) {
  const command = check ? "fmt --check" : "fmt";

  Deno.test(`fmt lockfile: ${command} on a deno.json project without a lock creates none`, async () => {
    await withLockRegistry(async (env) => {
      await withProject({}, async (dir) => {
        const manifestPath = await writeLockExtension(dir, "^1.0.0");
        const data = await fmtExtension(dir, manifestPath, env, check);
        assertEquals(data.passed, true);
        assertEquals(data.staleLockfiles, []);
        assertEquals(await exists(join(dir, "deno.lock")), false);
      });
    });
  });

  Deno.test(`fmt lockfile: ${command} leaves a current deno.lock byte-for-byte unchanged`, async () => {
    await withLockRegistry(async (env, currentLock) => {
      await withProject({}, async (dir) => {
        const manifestPath = await writeLockExtension(dir, "^1.0.0");
        const lock = await writeCurrentLock(dir, currentLock);
        const data = await fmtExtension(dir, manifestPath, env, check);
        assertEquals(data.passed, true);
        assertEquals(data.staleLockfiles, []);
        assertEquals(await Deno.readTextFile(join(dir, "deno.lock")), lock);
      });
    });
  });

  Deno.test(`fmt lockfile: ${command} leaves a stale deno.lock unchanged and reports it`, async () => {
    await withLockRegistry(async (env, currentLock) => {
      await withProject({}, async (dir) => {
        const manifestPath = await writeLockExtension(dir, "^1.0.0");
        const lock = await writeCurrentLock(dir, currentLock);
        // deno.json moves the specifier on; the lock still records ^1.0.0.
        await writeLockExtension(dir, "~1.0.0");
        const data = await fmtExtension(dir, manifestPath, env, check);
        assertEquals(data.passed, true);
        assertEquals(data.staleLockfiles, [{
          lockPath: join(dir, "deno.lock"),
          projectFile: join(dir, "deno.json"),
          projectDir: dir,
          entryPoints: [join(dir, "extensions", "models", "m.ts")],
        }]);
        assertEquals(await Deno.readTextFile(join(dir, "deno.lock")), lock);
      });
    });
  });
}

/**
 * A one-model extension in the repository's loaded extensions/models
 * directory, the tutorial layout, with its own deno.json mapping `ms` and
 * its manifest beside it. The model imports nothing the lock records, so
 * the bundle runs offline; the lock is checked against the config alone.
 */
async function writeLoadedLockExtension(
  dir: string,
  range: string,
  type: string,
): Promise<{ entry: string; manifestPath: string; modelsDir: string }> {
  const modelsDir = join(dir, "extensions", "models");
  await Deno.mkdir(join(dir, ".swamp"), { recursive: true });
  await Deno.mkdir(modelsDir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, ".swamp.yaml"),
    stringifyYaml({ swampVersion: "0.1.0" }),
  );
  await Deno.writeTextFile(
    join(modelsDir, "deno.json"),
    JSON.stringify({ imports: { ms: `npm:ms@${range}` } }),
  );
  const entry = join(modelsDir, "m.ts");
  await Deno.writeTextFile(
    entry,
    `import { z } from "npm:zod@4";

export const model = {
  type: "${type}",
  version: "2026.10.27.1",
  description: "loaded",
  globalArguments: z.object({}),
  resources: {},
  methods: {
    noop: {
      description: "noop",
      arguments: z.object({}),
      execute: () => Promise.resolve({ dataHandles: [] }),
    },
  },
};
`,
  );
  const manifestPath = join(modelsDir, "manifest.yaml");
  await Deno.writeTextFile(
    manifestPath,
    stringifyYaml({
      manifestVersion: 1,
      name: "@test/loaded-lock",
      version: "2026.10.27.1",
      models: ["m.ts"],
    }),
  );
  return { entry, manifestPath, modelsDir };
}

/**
 * Indexes `modelsDir` with the real loader and its module graph reader, as
 * every command does at startup, and returns the warnings it logged.
 */
async function loadModels(
  dir: string,
  modelsDir: string,
  catalog: ExtensionCatalogStore,
  env: Record<string, string>,
  options?: {
    /** Run the startup reconcile first, as the first command in a repo does. */
    reconcileFirst?: boolean;
    /** Runs between the reconcile and the index. */
    afterReconcile?: () => Promise<void>;
  },
): Promise<string[]> {
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
    const runtime: DenoRuntime = {
      ensureDeno: () => Promise.resolve(Deno.execPath()),
      getDenoEnv: () => env,
    };
    const lockfileRepository = new LockfileRepository(
      join(dir, "upstream_extensions.json"),
    );
    const repository = new ExtensionRepository({
      catalog,
      lockfileRepository,
      repoRoot: dir,
    });
    if (options?.reconcileFirst) {
      await new ReconcileFromDiskService({
        denoRuntime: runtime,
        repository,
        lockfileRepository,
        repoDir: dir,
      }).execute();
      await options.afterReconcile?.();
    }
    await new ExtensionLoader(
      runtime,
      modelKindAdapter,
      dir,
      undefined,
      repository,
      undefined,
      createDenoInfoModuleGraphReader,
    ).buildIndex(modelsDir);
  } finally {
    await reset();
  }
  return records.map((r) =>
    r.message.map((part) => typeof part === "string" ? part : String(part))
      .join("")
  );
}

/** Runs `fn` with a catalog for `dir`, closed afterwards. */
async function withCatalog(
  dir: string,
  fn: (catalog: ExtensionCatalogStore) => Promise<void>,
): Promise<void> {
  const catalog = new ExtensionCatalogStore(
    join(dir, ".swamp", "_extension_catalog.db"),
  );
  try {
    await fn(catalog);
  } finally {
    catalog.close();
  }
}

const loadedType = () => `@test/loaded-lock-${crypto.randomUUID().slice(0, 8)}`;

Deno.test("loader lockfile: loading and fmt in the loaded dir create no deno.lock (swamp-club#3869)", async () => {
  await withProject({}, async (dir) => {
    const type = loadedType();
    const { entry, manifestPath, modelsDir } = await writeLoadedLockExtension(
      dir,
      "^2.0.0",
      type,
    );
    const lockPath = join(modelsDir, "deno.lock");
    await withCatalog(dir, async (catalog) => {
      const warnings = await loadModels(dir, modelsDir, catalog, ENV);
      assertEquals(warnings, []);
      assertEquals(catalog.findBySourcePath(entry)?.type_normalized, type);
      assertEquals(await exists(lockPath), false);
      // The lock it would read is recorded, so one appearing rebundles.
      assertEquals(
        catalog.findSourceModules(entry)?.includes(lockPath),
        true,
      );
    });
    const data = await fmtExtension(dir, manifestPath, ENV, true);
    assertEquals(data.passed, true);
    assertEquals(await exists(lockPath), false);
  });
});

Deno.test("loader lockfile: a current deno.lock in the loaded dir is unchanged by loading (swamp-club#3869)", async () => {
  await withProject({}, async (dir) => {
    const type = loadedType();
    const { entry, modelsDir } = await writeLoadedLockExtension(
      dir,
      "^2.0.0",
      type,
    );
    const lockPath = join(modelsDir, "deno.lock");
    await Deno.writeTextFile(lockPath, MS_LOCK);
    await withCatalog(dir, async (catalog) => {
      assertEquals(await loadModels(dir, modelsDir, catalog, ENV), []);
      assertEquals(catalog.findBySourcePath(entry)?.type_normalized, type);
    });
    assertEquals(await Deno.readTextFile(lockPath), MS_LOCK);
  });
});

Deno.test("loader lockfile: a stale deno.lock in the loaded dir loads, warns once and is unchanged, and fmt still reports it (swamp-club#3869)", async () => {
  await withProject({}, async (dir) => {
    const type = loadedType();
    // deno.json has moved past the ^2.0.0 the lock records.
    const { entry, manifestPath, modelsDir } = await writeLoadedLockExtension(
      dir,
      "^2.1.0",
      type,
    );
    const lockPath = join(modelsDir, "deno.lock");
    await Deno.writeTextFile(lockPath, MS_LOCK);
    await withCatalog(dir, async (catalog) => {
      const warnings = await loadModels(dir, modelsDir, catalog, ENV);
      assertEquals(warnings.length, 1, warnings.join("\n"));
      assertStringIncludes(warnings[0], "is out of date with");
      assertStringIncludes(warnings[0], "deno install --entrypoint");
      assertEquals(catalog.findBySourcePath(entry)?.type_normalized, type);
      // Nothing changed, so the next load neither rebundles nor warns.
      assertEquals(await loadModels(dir, modelsDir, catalog, ENV), []);
    });
    assertEquals(await Deno.readTextFile(lockPath), MS_LOCK);
    const data = await fmtExtension(dir, manifestPath, ENV, true);
    assertEquals(data.staleLockfiles.map((s) => s.lockPath), [lockPath]);
    assertEquals(await Deno.readTextFile(lockPath), MS_LOCK);
  });
});

Deno.test("loader lockfile: the first command's startup reconcile and model load bundle a stale-locked extension once and warn once (swamp-club#3869)", async () => {
  await withProject({}, async (dir) => {
    const type = loadedType();
    const { entry, modelsDir } = await writeLoadedLockExtension(
      dir,
      "^2.1.0",
      type,
    );
    const lockPath = join(modelsDir, "deno.lock");
    await Deno.writeTextFile(lockPath, MS_LOCK);
    await withCatalog(dir, async (catalog) => {
      const epoch = new Date(0);
      let bundlePath = "";
      const warnings = await loadModels(dir, modelsDir, catalog, ENV, {
        reconcileFirst: true,
        afterReconcile: async () => {
          // The model load reuses the bundle reconcile indexed rather than
          // building it again.
          bundlePath = catalog.findBySourcePath(entry)?.bundle_path ?? "";
          await Deno.utime(bundlePath, epoch, epoch);
        },
      });
      assertEquals(warnings.length, 1, warnings.join("\n"));
      assertStringIncludes(warnings[0], "is out of date with");
      assertEquals(catalog.findBySourcePath(entry)?.type_normalized, type);
      assertEquals((await Deno.stat(bundlePath)).mtime, epoch);
    });
    assertEquals(await Deno.readTextFile(lockPath), MS_LOCK);
  });
});

Deno.test("loader lockfile: a deno.lock appearing in the loaded dir makes the bundle stale (swamp-club#3869)", async () => {
  await withProject({}, async (dir) => {
    const { modelsDir } = await writeLoadedLockExtension(
      dir,
      "^2.0.0",
      loadedType(),
    );
    await withCatalog(dir, async (catalog) => {
      await loadModels(dir, modelsDir, catalog, ENV);
      const staleNow = async () =>
        (await findStaleFiles({
          modelsDir,
          catalog,
          discoverFiles: () => Promise.resolve(["m.ts"]),
          kinds: ["model"],
          repoDir: dir,
        })).map((s) => s.relativePath);
      assertEquals(await staleNow(), []);
      await Deno.writeTextFile(join(modelsDir, "deno.lock"), MS_LOCK);
      assertEquals(await staleNow(), ["m.ts"]);
    });
  });
});
