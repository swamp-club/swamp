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
 * Integration tests for managed config base resolution at startup
 * (swamp-club#2483).
 *
 * A managedConfig repo on an extension-backed datastore must resolve its
 * config base before any loader reads a lockfile. The datastore extension
 * here is a real on-disk fixture: the datastore loader scans it, bundles it,
 * registers it and resolves the base end to end, which a filesystem
 * datastore cannot exercise. Everything runs in-process on a temp dir; the
 * loader may spawn `deno` to bundle, as other loader tests do.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import {
  configureStartupExtensions,
  type DeferredWarning,
} from "../src/cli/mod.ts";
import {
  getManagedConfigBase,
  isManagedConfig,
  isManagedConfigBaseResolved,
  resetManagedConfigRegistry,
  resolvePulledExtensionsRoot,
} from "../src/infrastructure/persistence/paths.ts";
import {
  type RepoMarkerData,
  RepoMarkerRepository,
} from "../src/infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { vaultTypeRegistry } from "../src/domain/vaults/vault_type_registry.ts";
import { datastoreTypeRegistry } from "../src/domain/datastore/datastore_type_registry.ts";
import { reportRegistry } from "../src/domain/reports/report_registry.ts";
import { webhookTypeRegistry } from "../src/domain/webhooks/webhook_type_registry.ts";
import {
  getAutoResolver,
  setAutoResolver,
} from "../src/domain/extensions/auto_resolver_context.ts";
import {
  type AutoResolveOutputPort,
  ExtensionAutoResolver,
} from "../src/domain/extensions/extension_auto_resolver.ts";
import { assertPathEquals } from "../src/infrastructure/persistence/path_test_helpers.ts";

const unsetDatastoreEnv = () => undefined;

const DATASTORE_CODE = (typeId: string, cacheDir: string) => `
export const datastore = {
  type: "${typeId}",
  name: "Test Store",
  description: "An extension-backed test datastore",
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
    resolveDatastorePath: (_repoDir: string) => ${JSON.stringify(cacheDir)},
    resolveCachePath: (_repoDir: string) => ${JSON.stringify(cacheDir)},
  }),
};
`;

const MODEL_CODE = (typeId: string) => `
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

interface Fixture {
  repoDir: string;
  cacheDir: string;
  scope: string;
  datastoreType: string;
  marker: RepoMarkerData;
}

/** Writes a pulled extension root with its manifest. */
async function writeExtension(
  root: string,
  name: string,
  kind: string,
  file: string,
  code: string,
): Promise<string> {
  const extRoot = join(root, ...name.split("/"));
  await ensureDir(join(extRoot, kind));
  await Deno.writeTextFile(
    join(extRoot, "manifest.yaml"),
    `manifestVersion: 1\nname: "${name}"\nversion: "1.0.0"\n`,
  );
  const path = join(extRoot, kind, file);
  await Deno.writeTextFile(path, code);
  return path;
}

async function writeLockfile(
  path: string,
  entries: Record<string, { files: string[] }>,
): Promise<void> {
  await ensureDir(join(path, ".."));
  const map: Record<string, unknown> = {};
  for (const [name, { files }] of Object.entries(entries)) {
    map[name] = { version: "1.0.0", pulledAt: "2026-01-01T00:00:00Z", files };
  }
  await Deno.writeTextFile(path, JSON.stringify(map));
}

/**
 * Runs `fn` against a temp managedConfig repo and restores every piece of
 * process-global state the startup sequence touches.
 */
async function withManagedRepo(
  fn: (fixture: Fixture) => Promise<void>,
  opts: { datastoreRoot?: "managed" | "legacy" | "none" } = {},
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_mc_startup_" });
  const cacheDir = join(repoDir, "cache");
  const scope = `@t${crypto.randomUUID().slice(0, 8)}`;
  const datastoreType = `${scope}/store`;
  const marker: RepoMarkerData = {
    swampVersion: "0.1.0",
    initializedAt: "2026-01-01T00:00:00.000Z",
    repoId: crypto.randomUUID(),
    tools: [],
    datastore: { type: datastoreType, managedConfig: true },
  };
  const previousResolver = getAutoResolver();
  setAutoResolver(null);
  try {
    await new RepoMarkerRepository().write(RepoPath.create(repoDir), marker);
    const where = opts.datastoreRoot ?? "managed";
    if (where !== "none") {
      const root = where === "managed"
        ? join(repoDir, ".swamp", "config", "pulled-extensions")
        : join(repoDir, ".swamp", "pulled-extensions");
      await writeExtension(
        root,
        datastoreType,
        "datastores",
        "store.ts",
        DATASTORE_CODE(datastoreType, cacheDir),
      );
    }
    await fn({ repoDir, cacheDir, scope, datastoreType, marker });
  } finally {
    for (
      const registry of [
        modelRegistry,
        vaultTypeRegistry,
        datastoreTypeRegistry,
        reportRegistry,
        webhookTypeRegistry,
      ]
    ) {
      registry.clearLoadersForTesting();
    }
    datastoreTypeRegistry.invalidateType(datastoreType);
    resetManagedConfigRegistry();
    setAutoResolver(previousResolver);
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

async function startup(
  fixture: Fixture,
  opts: {
    thinClient?: boolean;
    suppressWarning?: (warning: DeferredWarning) => boolean;
  } = {},
): Promise<{ warnings: DeferredWarning[]; dispose: () => void }> {
  const warnings: DeferredWarning[] = [];
  const dispose = await configureStartupExtensions({
    repoDir: fixture.repoDir,
    marker: fixture.marker,
    resolvedSources: [],
    deferredWarnings: warnings,
    quiet: true,
    thinClient: opts.thinClient ?? false,
    readDatastoreEnv: unsetDatastoreEnv,
    suppressWarning: opts.suppressWarning,
  });
  return { warnings, dispose };
}

Deno.test("configureStartupExtensions: resolves the managed config base from a datastore extension on disk", async () => {
  await withManagedRepo(async (fixture) => {
    const { dispose } = await startup(fixture);
    try {
      assertEquals(isManagedConfigBaseResolved(fixture.repoDir), true);
      const base = getManagedConfigBase(fixture.repoDir) ?? "";
      assertEquals(
        base.startsWith(fixture.cacheDir),
        true,
        `base ${base} should be under the cache ${fixture.cacheDir}`,
      );
      assertPathEquals(
        resolvePulledExtensionsRoot(fixture.repoDir),
        join(fixture.repoDir, ".swamp", "config", "pulled-extensions"),
      );
    } finally {
      dispose();
    }
  });
});

Deno.test("configureStartupExtensions: finds a datastore extension left under the legacy root after migrate", async () => {
  await withManagedRepo(async (fixture) => {
    const { dispose } = await startup(fixture);
    try {
      assertEquals(isManagedConfigBaseResolved(fixture.repoDir), true);
    } finally {
      dispose();
    }
  }, { datastoreRoot: "legacy" });
});

Deno.test("configureStartupExtensions: loaders read the resolved lockfile and the transitional local one", async () => {
  await withManagedRepo(async (fixture) => {
    // Resolve once to learn the base, then write its lockfile.
    const first = await startup(fixture);
    const base = getManagedConfigBase(fixture.repoDir) ?? "";
    first.dispose();
    const pulledRoot = join(
      fixture.repoDir,
      ".swamp",
      "config",
      "pulled-extensions",
    );
    const teamType = `${fixture.scope}/team/thing`;
    const autoType = `${fixture.scope}/auto/thing`;
    await writeExtension(
      pulledRoot,
      `${fixture.scope}/team`,
      "models",
      "thing.ts",
      MODEL_CODE(teamType),
    );
    await writeExtension(
      pulledRoot,
      `${fixture.scope}/auto`,
      "models",
      "thing.ts",
      MODEL_CODE(autoType),
    );
    await writeLockfile(join(base, "upstream_extensions.json"), {
      [`${fixture.scope}/team`]: { files: [] },
    });
    await writeLockfile(
      join(fixture.repoDir, ".swamp", "config", "upstream_extensions.json"),
      { [`${fixture.scope}/auto`]: { files: [] } },
    );
    modelRegistry.resetLoadedFlag();

    const { dispose } = await startup(fixture);
    try {
      await modelRegistry.ensureLoaded();
      await modelRegistry.ensureTypeLoaded(teamType);
      await modelRegistry.ensureTypeLoaded(autoType);
      assertEquals(modelRegistry.has(teamType), true);
      assertEquals(modelRegistry.has(autoType), true);
    } finally {
      dispose();
    }
  });
});

Deno.test("configureStartupExtensions: the missing-files warning reads the resolved lockfile, and reports a truncated auto-resolved entry separately with a delete hint", async () => {
  await withManagedRepo(async (fixture) => {
    const { repoDir, scope } = fixture;
    const first = await startup(fixture);
    const base = getManagedConfigBase(repoDir) ?? "";
    first.dispose();
    const missing = (name: string) =>
      `.swamp/config/pulled-extensions/${name}/models/gone.ts`;
    await writeLockfile(join(base, "upstream_extensions.json"), {
      [`${scope}/team-gone`]: { files: [missing(`${scope}/team-gone`)] },
    });
    // auto-cut and auto-cut2 keep their directories with a file missing
    // (truncated trees); auto-gone has no directory left.
    for (const name of ["auto-cut", "auto-cut2"]) {
      await Deno.mkdir(
        join(repoDir, ".swamp", "config", "pulled-extensions", scope, name),
        { recursive: true },
      );
    }
    const skill = ".swamp/pulled-extensions/skills/auto-cut-skill/SKILL.md";
    await Deno.mkdir(join(repoDir, dirname(skill)), { recursive: true });
    await Deno.writeTextFile(join(repoDir, skill), "x");
    await writeLockfile(
      join(repoDir, ".swamp", "config", "upstream_extensions.json"),
      {
        [`${scope}/auto-cut`]: { files: [missing(`${scope}/auto-cut`), skill] },
        [`${scope}/auto-cut2`]: { files: [missing(`${scope}/auto-cut2`)] },
        [`${scope}/auto-gone`]: { files: [missing(`${scope}/auto-gone`)] },
      },
    );

    const { warnings, dispose } = await startup(fixture);
    try {
      const team = warnings.find((w) =>
        w.error.includes("pulled extension(s) have missing source files")
      );
      const local = warnings.find((w) =>
        w.error.includes("auto-resolved extension(s) have missing source")
      );
      assertStringIncludes(team?.error ?? "", `${scope}/team-gone`);
      assertEquals((team?.error ?? "").includes(`${scope}/auto-cut`), false);
      assertStringIncludes(local?.error ?? "", `${scope}/auto-cut`);
      // Everything to delete is named, the skill dir included: a surviving
      // skill would stop the auto-resolver from reinstalling.
      assertStringIncludes(
        local?.error ?? "",
        `${
          join(".swamp", "config", "pulled-extensions", scope, "auto-cut")
        }, ` +
          join(".swamp", "pulled-extensions", "skills", "auto-cut-skill"),
      );
      assertEquals((local?.error ?? "").includes("--force"), false);
      // Every truncated extension's paths are named, not just the first.
      assertStringIncludes(
        local?.error ?? "",
        `${scope}/auto-cut2: ${
          join(".swamp", "config", "pulled-extensions", scope, "auto-cut2")
        }`,
      );
      // Gone entirely, it awaits reinstall on next use: nothing to report.
      assertEquals(
        warnings.some((w) => w.error.includes(`${scope}/auto-gone`)),
        false,
      );
    } finally {
      dispose();
    }
  });
});

Deno.test("configureStartupExtensions: the deferred missing-files check honours suppressWarning", async () => {
  await withManagedRepo(async (fixture) => {
    const first = await startup(fixture);
    const base = getManagedConfigBase(fixture.repoDir) ?? "";
    first.dispose();
    await writeLockfile(join(base, "upstream_extensions.json"), {
      [`${fixture.scope}/team-gone`]: {
        files: [
          `.swamp/config/pulled-extensions/${fixture.scope}/team-gone/models/gone.ts`,
        ],
      },
    });
    const offered: DeferredWarning[] = [];
    // Forget the base the first startup resolved, so the thin client below
    // starts unresolved.
    resetManagedConfigRegistry();

    // A thin client skips startup resolution, so the missing-files check
    // runs deferred, on the first load.
    const { warnings, dispose } = await startup(fixture, {
      thinClient: true,
      suppressWarning: (warning) => {
        offered.push(warning);
        return true;
      },
    });
    try {
      assertEquals(warnings, []);
      await modelRegistry.ensureLoaded();
      assertStringIncludes(
        offered.map((w) => w.error).join("\n"),
        `${fixture.scope}/team-gone`,
      );
    } finally {
      dispose();
    }
  });
});

Deno.test("configureStartupExtensions: a failed datastore resolution is remembered in a repo without managedConfig", async () => {
  await withManagedRepo(async (fixture) => {
    // No managedConfig, and a datastore extension nobody can install.
    const marker: RepoMarkerData = {
      ...fixture.marker,
      datastore: { type: `${fixture.scope}/missing-datastore` },
    };
    const lookups: string[] = [];
    // A no-op output port that stays valid when the port gains methods.
    const silentOutput = new Proxy({}, {
      get: () => () => {},
    }) as AutoResolveOutputPort;
    setAutoResolver(
      new ExtensionAutoResolver({
        allowedCollectives: [fixture.scope.slice(1)],
        extensionLookup: {
          getExtension: (name) => {
            lookups.push(name);
            return Promise.resolve(null);
          },
          searchExtensions: () => Promise.resolve({ extensions: [] }),
        },
        extensionInstaller: {
          inspectInstallation: () => Promise.resolve({ state: "missing" }),
          install: () => Promise.resolve(null),
          hotLoadModels: () => Promise.resolve(0),
          hotLoadVaults: () => Promise.resolve(),
          hotLoadDatastores: () => Promise.resolve(),
          hotLoadWebhooks: () => Promise.resolve(),
          failedLocalSourceMatchesType: () => false,
        },
        output: silentOutput,
      }),
    );
    const dispose = await configureStartupExtensions({
      repoDir: fixture.repoDir,
      marker,
      resolvedSources: [],
      deferredWarnings: [],
      quiet: true,
      thinClient: false,
      readDatastoreEnv: unsetDatastoreEnv,
    });
    try {
      await modelRegistry.ensureLoaded();
      const afterFirstLoader = lookups.length;
      assertEquals(afterFirstLoader > 0, true);
      await vaultTypeRegistry.ensureLoaded();
      assertEquals(lookups.length, afterFirstLoader);
    } finally {
      dispose();
    }
  }, { datastoreRoot: "none" });
});

Deno.test("configureStartupExtensions: a lockfile unreadable at startup leaves catalog repair to the first load", async () => {
  await withManagedRepo(async (fixture) => {
    const first = await startup(fixture);
    const base = getManagedConfigBase(fixture.repoDir) ?? "";
    first.dispose();
    const lockfilePath = join(base, "upstream_extensions.json");
    await ensureDir(base);
    await Deno.writeTextFile(lockfilePath, "null\n");
    const offered: DeferredWarning[] = [];

    const { warnings, dispose } = await startup(fixture, {
      suppressWarning: (warning) => {
        offered.push(warning);
        return true;
      },
    });
    try {
      // The sync finishes rewriting the lockfile before the first load.
      await writeLockfile(lockfilePath, {
        [`${fixture.scope}/team-gone`]: {
          files: [
            `.swamp/config/pulled-extensions/${fixture.scope}/team-gone/models/gone.ts`,
          ],
        },
      });
      await modelRegistry.ensureLoaded();
      assertEquals(warnings, []);
      assertStringIncludes(
        offered.map((w) => w.error).join("\n"),
        `${fixture.scope}/team-gone`,
      );
    } finally {
      dispose();
    }
  });
});

Deno.test("configureStartupExtensions: a load that cannot read the lockfile is retried by the next load", async () => {
  await withManagedRepo(async (fixture) => {
    const first = await startup(fixture);
    const base = getManagedConfigBase(fixture.repoDir) ?? "";
    first.dispose();
    const lockfilePath = join(base, "upstream_extensions.json");
    await ensureDir(base);
    await Deno.writeTextFile(lockfilePath, "null\n");

    const { dispose } = await startup(fixture);
    try {
      await assertRejects(() => modelRegistry.ensureLoaded(), SyntaxError);
      await writeLockfile(lockfilePath, {});
      await modelRegistry.ensureLoaded();
    } finally {
      dispose();
    }
  });
});

Deno.test("configureStartupExtensions: a transitional local lockfile containing null is skipped", async () => {
  await withManagedRepo(async (fixture) => {
    const first = await startup(fixture);
    const base = getManagedConfigBase(fixture.repoDir) ?? "";
    first.dispose();
    await writeLockfile(join(base, "upstream_extensions.json"), {
      [`${fixture.scope}/team-gone`]: {
        files: [
          `.swamp/config/pulled-extensions/${fixture.scope}/team-gone/models/gone.ts`,
        ],
      },
    });
    await Deno.writeTextFile(
      join(fixture.repoDir, ".swamp", "config", "upstream_extensions.json"),
      "null\n",
    );

    const { warnings, dispose } = await startup(fixture);
    try {
      const team = warnings.find((w) =>
        w.error.includes("pulled extension(s) have missing source files")
      );
      assertStringIncludes(team?.error ?? "", `${fixture.scope}/team-gone`);
    } finally {
      dispose();
    }
  });
});

Deno.test("configureStartupExtensions: a resolved lockfile containing null does not fail startup", async () => {
  await withManagedRepo(async (fixture) => {
    const first = await startup(fixture);
    const base = getManagedConfigBase(fixture.repoDir) ?? "";
    first.dispose();
    await ensureDir(base);
    await Deno.writeTextFile(join(base, "upstream_extensions.json"), "null\n");

    const { warnings, dispose } = await startup(fixture);
    try {
      assertEquals(isManagedConfigBaseResolved(fixture.repoDir), true);
      assertEquals(
        warnings.filter((w) => w.error.includes("missing source files")),
        [],
      );
    } finally {
      dispose();
    }
  });
});

Deno.test("configureStartupExtensions: malformed lockfile entries are skipped by the missing-files check", async () => {
  await withManagedRepo(async (fixture) => {
    const first = await startup(fixture);
    const base = getManagedConfigBase(fixture.repoDir) ?? "";
    first.dispose();
    await ensureDir(base);
    await Deno.writeTextFile(
      join(base, "upstream_extensions.json"),
      JSON.stringify({
        [`${fixture.scope}/null-entry`]: null,
        [`${fixture.scope}/null-file`]: { version: "1.0.0", files: [null] },
        [`${fixture.scope}/number-files`]: { version: "1.0.0", files: 5 },
        [`${fixture.scope}/team-gone`]: {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: [
            `.swamp/config/pulled-extensions/${fixture.scope}/team-gone/models/gone.ts`,
          ],
        },
      }),
    );

    const { warnings, dispose } = await startup(fixture);
    try {
      const team = warnings.find((w) =>
        w.error.includes("pulled extension(s) have missing source files")
      );
      assertStringIncludes(team?.error ?? "", `${fixture.scope}/team-gone`);
      assertEquals(
        (team?.error ?? "").includes(`${fixture.scope}/null-entry`),
        false,
      );
    } finally {
      dispose();
    }
  });
});

Deno.test("configureStartupExtensions: with no datastore extension installed the base stays unresolved", async () => {
  await withManagedRepo(async (fixture) => {
    const { dispose } = await startup(fixture);
    try {
      assertEquals(isManagedConfigBaseResolved(fixture.repoDir), false);
      assertEquals(isManagedConfig(fixture.repoDir), true);
      // A read-only load resolves installed-only and never auto-installs.
      await modelRegistry.ensureLoaded();
      assertEquals(isManagedConfigBaseResolved(fixture.repoDir), false);
    } finally {
      dispose();
    }
  }, { datastoreRoot: "none" });
});

Deno.test("configureStartupExtensions: a thin client skips eager resolution, and the first load resolves", async () => {
  await withManagedRepo(async (fixture) => {
    const { dispose } = await startup(fixture, { thinClient: true });
    try {
      assertEquals(isManagedConfig(fixture.repoDir), true);
      assertEquals(isManagedConfigBaseResolved(fixture.repoDir), false);
      await modelRegistry.ensureLoaded();
      assertEquals(isManagedConfigBaseResolved(fixture.repoDir), true);
    } finally {
      dispose();
    }
  });
});

Deno.test("configureStartupExtensions: a filesystem datastore at a custom path resolves even for a thin client", async () => {
  await withManagedRepo(async (fixture) => {
    const datastorePath = join(fixture.repoDir, "ds");
    await ensureDir(datastorePath);
    const marker: RepoMarkerData = {
      ...fixture.marker,
      datastore: {
        type: "filesystem",
        path: datastorePath,
        managedConfig: true,
      },
    };
    const warnings: DeferredWarning[] = [];
    const dispose = await configureStartupExtensions({
      repoDir: fixture.repoDir,
      marker,
      resolvedSources: [],
      deferredWarnings: warnings,
      quiet: true,
      thinClient: true,
      readDatastoreEnv: unsetDatastoreEnv,
    });
    try {
      assertEquals(isManagedConfigBaseResolved(fixture.repoDir), true);
      assertEquals(
        (getManagedConfigBase(fixture.repoDir) ?? "").startsWith(datastorePath),
        true,
      );
    } finally {
      dispose();
    }
  }, { datastoreRoot: "none" });
});
