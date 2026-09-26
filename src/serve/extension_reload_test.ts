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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { withMockedCommand } from "@swamp-club/swamp-testing";
import {
  collectRegisteredPulledSources,
  createExtensionDiscoverer,
  isReloading,
  performServeReload,
  reloadPulledExtensions,
  resolveLockfilePath,
} from "./extension_reload.ts";
import {
  ExtensionCatalogStore,
  type ExtensionKind,
} from "../infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../infrastructure/persistence/lockfile_repository.ts";
import {
  bundleNamespace,
  swampPath,
} from "../infrastructure/persistence/paths.ts";
import { canonicalizePath } from "../infrastructure/persistence/canonicalize_path.ts";
import { ExtensionLoader } from "../domain/extensions/extension_loader.ts";
import { modelKindAdapter } from "../domain/extensions/model_kind_adapter.ts";
import { modelRegistry } from "../domain/models/model.ts";
import { ModelType } from "../domain/models/model_type.ts";
import type { DenoRuntime } from "../domain/runtime/deno_runtime.ts";
import "../domain/models/models.ts";

Deno.test("isReloading: returns false when no reload is in progress", () => {
  assertEquals(isReloading(), false);
});

Deno.test("resolveLockfilePath: returns path ending in upstream_extensions.json", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    await Deno.writeTextFile(
      join(tmpDir, ".swamp.yaml"),
      "version: 1\n",
    );
    const result = await resolveLockfilePath(tmpDir);
    assertStringIncludes(result, "upstream_extensions.json");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: succeeds with no-op for missing lockfile", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    const result = await performServeReload(
      tmpDir,
      join(tmpDir, "nonexistent_lockfile.json"),
    );
    assertEquals(result.success, true);
    assertEquals(result.reloadedCount, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: returns zero count for empty lockfile", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await Deno.writeTextFile(lockfilePath, "{}");
    const catalogDbPath = join(tmpDir, ".swamp", "_extension_catalog.db");
    await Deno.writeTextFile(catalogDbPath, "");
    const result = await performServeReload(tmpDir, lockfilePath);
    assertEquals(result.success, true);
    assertEquals(result.reloadedCount, 0);
    assertEquals(result.errors.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: resets isReloading flag after failure", async () => {
  assertEquals(isReloading(), false);
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    await performServeReload(tmpDir, join(tmpDir, "missing.json"));
    assertEquals(isReloading(), false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: calls triggerOverrideUpdater with overrides from serve.yaml", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    await Deno.writeTextFile(
      join(tmpDir, ".swamp", "serve.yaml"),
      `triggers:\n  my-workflow:\n    schedule: "0 3 * * *"\n`,
    );

    let receivedOverrides: ReadonlyMap<string, unknown> | undefined;
    const result = await performServeReload(
      tmpDir,
      join(tmpDir, "nonexistent_lockfile.json"),
      {
        triggerOverrideUpdater: (overrides) => {
          receivedOverrides = overrides;
          return Promise.resolve(overrides.size);
        },
      },
    );

    assertEquals(result.success, true);
    assertEquals(result.triggerOverridesChanged, 1);
    assertEquals(receivedOverrides?.size, 1);
    const entry = receivedOverrides?.get("my-workflow") as
      | { schedule?: string }
      | undefined;
    assertEquals(entry?.schedule, "0 3 * * *");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: passes empty map when serve.yaml has no triggers", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    await Deno.writeTextFile(
      join(tmpDir, ".swamp", "serve.yaml"),
      `port: 8080\n`,
    );

    let receivedOverrides: ReadonlyMap<string, unknown> | undefined;
    const result = await performServeReload(
      tmpDir,
      join(tmpDir, "nonexistent_lockfile.json"),
      {
        triggerOverrideUpdater: (overrides) => {
          receivedOverrides = overrides;
          return Promise.resolve(overrides.size);
        },
      },
    );

    assertEquals(result.success, true);
    assertEquals(result.triggerOverridesChanged, 0);
    assertEquals(receivedOverrides?.size, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: calls workflowReloader and includes count in response", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });

    let reloaderCalled = false;
    const result = await performServeReload(
      tmpDir,
      join(tmpDir, "nonexistent_lockfile.json"),
      {
        workflowReloader: () => {
          reloaderCalled = true;
          return Promise.resolve(4);
        },
      },
    );

    assertEquals(result.success, true);
    assertEquals(reloaderCalled, true);
    assertEquals(result.workflowsReloaded, 4);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: workflowReloader error is soft failure", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });

    const result = await performServeReload(
      tmpDir,
      join(tmpDir, "nonexistent_lockfile.json"),
      {
        workflowReloader: () =>
          Promise.reject(new Error("workflow scan failed")),
      },
    );

    assertEquals(result.success, true);
    assertStringIncludes(result.errors[0], "Failed to reload workflows");
    assertStringIncludes(result.errors[0], "workflow scan failed");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: trigger override updater error is soft failure", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    await Deno.writeTextFile(
      join(tmpDir, ".swamp", "serve.yaml"),
      `triggers:\n  my-wf:\n    schedule: "0 3 * * *"\n`,
    );

    const result = await performServeReload(
      tmpDir,
      join(tmpDir, "nonexistent_lockfile.json"),
      {
        triggerOverrideUpdater: () =>
          Promise.reject(new Error("scheduler broke")),
      },
    );

    assertEquals(result.success, true);
    assertStringIncludes(
      result.errors[0],
      "Failed to reload trigger overrides",
    );
    assertStringIncludes(result.errors[0], "scheduler broke");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: calls extensionDiscoverer and adds count to reloadedCount", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });

    let discovererCalled = false;
    const result = await performServeReload(
      tmpDir,
      join(tmpDir, "nonexistent_lockfile.json"),
      {
        extensionDiscoverer: () => {
          discovererCalled = true;
          return Promise.resolve(3);
        },
      },
    );

    assertEquals(result.success, true);
    assertEquals(discovererCalled, true);
    assertEquals(result.reloadedCount, 3);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: extensionDiscoverer error is soft failure", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });

    const result = await performServeReload(
      tmpDir,
      join(tmpDir, "nonexistent_lockfile.json"),
      {
        extensionDiscoverer: () =>
          Promise.reject(new Error("discovery failed")),
      },
    );

    assertEquals(result.success, true);
    assertStringIncludes(
      result.errors[0],
      "Failed to discover new extensions",
    );
    assertStringIncludes(result.errors[0], "discovery failed");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: calls webhookUpdater with configs from serve.yaml", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    await Deno.writeTextFile(
      join(tmpDir, ".swamp", "serve.yaml"),
      `webhooks:\n  - route: /hooks/gh\n    workflow: deploy\n    secret: s3cret\n`,
    );

    let receivedConfigs:
      | readonly import("./serve_config.ts").WebhookConfigEntry[]
      | undefined;
    const result = await performServeReload(
      tmpDir,
      join(tmpDir, "nonexistent_lockfile.json"),
      {
        webhookUpdater: (configs) => {
          receivedConfigs = configs;
          return Promise.resolve(configs.length);
        },
      },
    );

    assertEquals(result.success, true);
    assertEquals(result.webhooksReloaded, 1);
    assertEquals(receivedConfigs?.length, 1);
    assertEquals(receivedConfigs?.[0].route, "/hooks/gh");
    assertEquals(receivedConfigs?.[0].workflow, "deploy");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: passes empty array when serve.yaml has no webhooks", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    await Deno.writeTextFile(
      join(tmpDir, ".swamp", "serve.yaml"),
      `port: 8080\n`,
    );

    let receivedConfigs:
      | readonly import("./serve_config.ts").WebhookConfigEntry[]
      | undefined;
    const result = await performServeReload(
      tmpDir,
      join(tmpDir, "nonexistent_lockfile.json"),
      {
        webhookUpdater: (configs) => {
          receivedConfigs = configs;
          return Promise.resolve(configs.length);
        },
      },
    );

    assertEquals(result.success, true);
    assertEquals(result.webhooksReloaded, 0);
    assertEquals(receivedConfigs?.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: webhookUpdater error is soft failure", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    await Deno.writeTextFile(
      join(tmpDir, ".swamp", "serve.yaml"),
      `webhooks:\n  - route: /hooks/gh\n    workflow: deploy\n    secret: s\n`,
    );

    const result = await performServeReload(
      tmpDir,
      join(tmpDir, "nonexistent_lockfile.json"),
      {
        webhookUpdater: () => Promise.reject(new Error("parse failed")),
      },
    );

    assertEquals(result.success, true);
    assertStringIncludes(
      result.errors[0],
      "Failed to reload webhook config",
    );
    assertStringIncludes(result.errors[0], "parse failed");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: shares config read between triggers and webhooks", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    await Deno.writeTextFile(
      join(tmpDir, ".swamp", "serve.yaml"),
      `triggers:\n  my-wf:\n    schedule: "0 3 * * *"\nwebhooks:\n  - route: /hooks/a\n    workflow: wf\n    secret: s\n`,
    );

    let triggersCalled = false;
    let webhooksCalled = false;
    const result = await performServeReload(
      tmpDir,
      join(tmpDir, "nonexistent_lockfile.json"),
      {
        triggerOverrideUpdater: (overrides) => {
          triggersCalled = true;
          return Promise.resolve(overrides.size);
        },
        webhookUpdater: (configs) => {
          webhooksCalled = true;
          return Promise.resolve(configs.length);
        },
      },
    );

    assertEquals(result.success, true);
    assertEquals(triggersCalled, true);
    assertEquals(webhooksCalled, true);
    assertEquals(result.triggerOverridesChanged, 1);
    assertEquals(result.webhooksReloaded, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

// -- Uncatalogued pulled extensions and discovery skip (swamp-club#2355) ----

const stubDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve("/nonexistent/swamp-test/deno"),
  getDenoEnv: () => Deno.env.toObject(),
};

const pulledModelCode = (typeId: string, description: string) => `
import { z } from "npm:zod@4";

export const model = {
  type: "${typeId}",
  version: "2026.09.26.1",
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
      description: "${description}",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

/** A pulled-extension fixture repo: lockfile, catalog and staged sources. */
async function withPulledRepo(
  extensionNames: readonly string[],
  fn: (args: {
    repoDir: string;
    lockfilePath: string;
    catalog: ExtensionCatalogStore;
    stage: (
      extName: string,
      fileBase: string,
      code: string,
    ) => Promise<string>;
  }) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_2355_reload_" });
  await ensureDir(join(repoDir, "extensions", "models"));
  const lockfilePath = join(
    repoDir,
    "extensions",
    "models",
    "upstream_extensions.json",
  );
  await Deno.writeTextFile(
    lockfilePath,
    JSON.stringify(
      Object.fromEntries(
        extensionNames.map((n) => [n, { version: "1.0.0", files: [] }]),
      ),
    ),
  );
  await ensureDir(swampPath(repoDir));
  const catalog = new ExtensionCatalogStore(
    swampPath(repoDir, "_extension_catalog.db"),
  );
  // Writes a source plus a matching pre-built bundle, as a sync delivers
  // both, so no load path has to spawn `deno bundle`.
  const stage = async (extName: string, fileBase: string, code: string) => {
    const modelsDir = join(
      swampPath(repoDir, "pulled-extensions"),
      extName,
      "models",
    );
    await ensureDir(modelsDir);
    const sourcePath = join(modelsDir, `${fileBase}.ts`);
    await Deno.writeTextFile(sourcePath, code);
    const bundleDir = join(
      swampPath(repoDir, "bundles"),
      bundleNamespace(modelsDir, repoDir),
    );
    await ensureDir(bundleDir);
    await Deno.writeTextFile(join(bundleDir, `${fileBase}.js`), code);
    return sourcePath;
  };
  try {
    await fn({ repoDir, lockfilePath, catalog, stage });
  } finally {
    catalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

/** Mock `deno bundle`: copies the source file to the `-o` output path. */
const copyingBundler = async (_cmd: string, args: string[]) => {
  const out = args[args.indexOf("-o") + 1];
  await Deno.writeTextFile(out, await Deno.readTextFile(args[args.length - 1]));
  return { stdout: "", stderr: "", code: 0 };
};

Deno.test("reloadPulledExtensions: catalogues an uncatalogued pulled extension and hot-reloads its next version", async () => {
  const id = crypto.randomUUID();
  const extName = `@test/synced-${id}`;
  const typeId = `@test/synced-model-${id}`;
  await withPulledRepo([extName], async ({ repoDir, lockfilePath, stage }) => {
    const sourcePath = await stage(
      extName,
      "noop",
      pulledModelCode(typeId, "noop v1"),
    );
    const typeCatalog = new ExtensionCatalogStore(
      swampPath(repoDir, "_extension_catalog.db"),
    );
    const repository = new ExtensionRepository({
      catalog: typeCatalog,
      lockfileRepository: await LockfileRepository.create(lockfilePath),
      repoRoot: repoDir,
    });
    const typeLoader = new ExtensionLoader(
      stubDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      repository,
    );
    modelRegistry.setTypeLoader((type, lazy) =>
      typeLoader.loadSingleType(type, lazy)
    );
    try {
      const first = await reloadPulledExtensions(
        repoDir,
        lockfilePath,
        undefined,
        stubDenoRuntime,
      );
      assertEquals(
        first,
        1,
        "the synced type is registered on the first reload",
      );
      assertEquals(
        modelRegistry.get(typeId)?.methods.noop.description,
        "noop v1",
      );

      // The next sync delivers a changed source and bundle.
      await stage(extName, "noop", pulledModelCode(typeId, "noop v2"));
      const { calls } = await withMockedCommand(
        copyingBundler,
        () =>
          reloadPulledExtensions(
            repoDir,
            lockfilePath,
            undefined,
            stubDenoRuntime,
          ),
      );

      assertEquals(
        calls.filter((c) => c.args.includes(sourcePath)).length,
        1,
        "the changed source is rebundled by the catalog pass",
      );
      assertEquals(
        modelRegistry.get(typeId)?.methods.noop.description,
        "noop v2",
        "the registered definition must be the new version",
      );
    } finally {
      modelRegistry.clearLoadersForTesting();
      modelRegistry.invalidateType(typeId);
      typeCatalog.close();
    }
  });
});

Deno.test("collectRegisteredPulledSources: returns only registered rows of the adapter's kind under the lockfile prefixes", async () => {
  const id = crypto.randomUUID();
  const extName = `@test/rows-${id}`;
  const otherExt = `@test/not-in-lockfile-${id}`;
  await withPulledRepo([extName], ({ repoDir, catalog }) => {
    const pulledRoot = swampPath(repoDir, "pulled-extensions");
    const row = (
      ext: string,
      file: string,
      kind: ExtensionKind,
      type: string,
    ) => {
      const sourcePath = canonicalizePath(join(pulledRoot, ext, file));
      catalog.upsert({
        type_normalized: type,
        kind,
        bundle_path: "",
        source_path: sourcePath,
        version: "",
        description: "",
        extends_type: kind === "extension" ? type : "",
        source_mtime: "",
        source_fingerprint: "",
      });
      return sourcePath;
    };
    const registered = row(extName, "models/a.ts", "model", `${extName}/a`);
    row(extName, "models/b.ts", "model", `${extName}/unregistered`);
    row(extName, "vaults/c.ts", "vault", `${extName}/c`);
    row(extName, "models/d.ts", "extension", `${extName}/a`);
    row(otherExt, "models/e.ts", "model", `${otherExt}/e`);

    const registeredTypes = new Set([
      `${extName}/a`,
      `${extName}/c`,
      `${otherExt}/e`,
    ]);
    const adapter = {
      ...modelKindAdapter,
      hasType: (type: string) => registeredTypes.has(type),
    };

    assertEquals(
      [...collectRegisteredPulledSources(
        catalog,
        pulledRoot,
        [extName],
        adapter,
      )],
      [registered],
    );
    return Promise.resolve();
  });
});

Deno.test("createExtensionDiscoverer: skips catalogued registered sources before import and still discovers new ones", async () => {
  const id = crypto.randomUUID();
  const knownExt = `@test/known-${id}`;
  const newExt = `@test/new-${id}`;
  const knownType = `@test/known-model-${id}`;
  const newType = `@test/new-model-${id}`;
  const importedFlag = `__swamp2355_imported_${id.replaceAll("-", "_")}`;
  await withPulledRepo(
    [knownExt, newExt],
    async ({ repoDir, lockfilePath, catalog, stage }) => {
      // The catalogued source's bundle records that it was imported.
      const knownPath = await stage(
        knownExt,
        "known",
        `globalThis.${importedFlag} = true;\n` +
          pulledModelCode(knownType, "known"),
      );
      await stage(newExt, "fresh", pulledModelCode(newType, "fresh"));
      catalog.upsert({
        type_normalized: knownType,
        kind: "model",
        bundle_path: "",
        source_path: canonicalizePath(knownPath),
        version: "",
        description: "",
        extends_type: "",
        source_mtime: "",
        source_fingerprint: "",
      });
      modelRegistry.registerLazy({
        type: ModelType.create(knownType),
        bundlePath: "",
        sourcePath: knownPath,
        version: "",
      });
      try {
        const discover = createExtensionDiscoverer({
          lockfilePath,
          repoDir,
          denoRuntime: stubDenoRuntime,
        });

        const discovered = await discover();

        assertEquals(
          (globalThis as Record<string, unknown>)[importedFlag],
          undefined,
          "a catalogued source with a registered type must not be imported",
        );
        assertEquals(discovered, 1, "the uncatalogued source is discovered");
        assertEquals(modelRegistry.has(newType), true);
      } finally {
        modelRegistry.invalidateType(knownType);
        modelRegistry.invalidateType(newType);
        delete (globalThis as Record<string, unknown>)[importedFlag];
      }
    },
  );
});
