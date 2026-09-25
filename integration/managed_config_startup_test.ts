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
 * Integration tests for managedConfig repos on an extension-backed datastore
 * (swamp-club#2483): datastore extensions discovered on disk, and the
 * transitional in-repo auto-resolve lockfile read alongside the resolved one.
 *
 * The datastore extension here is a real on-disk fixture that the datastore
 * loader scans, bundles and registers; nothing lists it in a lockfile.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import {
  configureExtensionLoaders,
  type DeferredWarning,
} from "../src/cli/mod.ts";
import {
  ensureManagedConfigBase,
  resolveManagedConfigPaths,
} from "../src/cli/repo_context.ts";
import {
  getManagedConfigBase,
  managedConfigLockfilePath,
  resetManagedConfigRegistry,
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
import { assertPathEquals } from "../src/infrastructure/persistence/path_test_helpers.ts";

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

/** Writes a pulled extension root with its manifest. */
async function writeExtension(
  root: string,
  name: string,
  kind: string,
  file: string,
  code: string,
): Promise<void> {
  const extRoot = join(root, ...name.split("/"));
  await ensureDir(join(extRoot, kind));
  await Deno.writeTextFile(
    join(extRoot, "manifest.yaml"),
    `manifestVersion: 1\nname: "${name}"\nversion: "1.0.0"\n`,
  );
  await Deno.writeTextFile(join(extRoot, kind, file), code);
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

interface Fixture {
  repoDir: string;
  marker: RepoMarkerData;
  cacheDir: string;
  scope: string;
  /** The in-repo lockfile, where auto-resolve records installs. */
  localLockfilePath: string;
  /** The lockfile at the datastore's config base. */
  resolvedLockfilePath: string;
  warnings: DeferredWarning[];
}

/**
 * Configures the extension loaders for a temp managedConfig repo whose
 * datastore extension sits under `root` (or nowhere), runs `fn`, and
 * restores the process-global state it touched.
 *
 * `setup` runs before the loaders are configured. With `lockfile: "resolved"`
 * the loaders read the lockfile at the datastore's config base, as they do
 * once the base resolves; by default they read the in-repo lockfile.
 */
async function withExtensionBackedRepo(
  root: "managed" | "legacy" | "none",
  fn: (fixture: Fixture) => Promise<void>,
  opts: {
    setup?: (fixture: Fixture) => Promise<void>;
    lockfile?: "local" | "resolved";
  } = {},
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_ds_on_disk_" });
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
  const fixture: Fixture = {
    repoDir,
    marker,
    cacheDir,
    scope,
    localLockfilePath: managedConfigLockfilePath(repoDir),
    resolvedLockfilePath: join(cacheDir, "config", "upstream_extensions.json"),
    warnings: [],
  };
  const previousResolver = getAutoResolver();
  setAutoResolver(null);
  try {
    await new RepoMarkerRepository().write(RepoPath.create(repoDir), marker);
    if (root !== "none") {
      const pulledRoot = root === "managed"
        ? join(repoDir, ".swamp", "config", "pulled-extensions")
        : join(repoDir, ".swamp", "pulled-extensions");
      await writeExtension(
        pulledRoot,
        datastoreType,
        "datastores",
        "store.ts",
        DATASTORE_CODE(datastoreType, cacheDir),
      );
    }
    await opts.setup?.(fixture);
    // As runCli does: record the repo as managed before the loaders ask for
    // the pulled root.
    resolveManagedConfigPaths(repoDir, marker);
    await configureExtensionLoaders(
      repoDir,
      marker,
      [],
      fixture.warnings,
      true,
      undefined,
      opts.lockfile === "resolved"
        ? fixture.resolvedLockfilePath
        : fixture.localLockfilePath,
    );
    await fn(fixture);
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

// ── datastore extensions found on disk ─────────────────────────────────────

Deno.test("configureExtensionLoaders: a datastore extension on disk resolves the managed config base with no lockfile", async () => {
  await withExtensionBackedRepo("managed", async (fixture) => {
    const resolved = await ensureManagedConfigBase(
      fixture.repoDir,
      fixture.marker,
      undefined,
      { autoResolve: false },
    );
    assertEquals(resolved, true);
    assertPathEquals(
      getManagedConfigBase(fixture.repoDir) ?? "",
      join(fixture.cacheDir, "config"),
    );
  });
});

Deno.test("configureExtensionLoaders: finds a datastore extension left under the legacy root after migrate", async () => {
  await withExtensionBackedRepo("legacy", async ({ repoDir, marker }) => {
    assertEquals(
      await ensureManagedConfigBase(repoDir, marker, undefined, {
        autoResolve: false,
      }),
      true,
    );
  });
});

Deno.test("configureExtensionLoaders: with no datastore extension on disk the base stays unresolved", async () => {
  await withExtensionBackedRepo("none", async ({ repoDir, marker }) => {
    assertEquals(
      await ensureManagedConfigBase(repoDir, marker, undefined, {
        autoResolve: false,
      }),
      false,
    );
  });
});

// ── the transitional in-repo auto-resolve lockfile ─────────────────────────

Deno.test("configureExtensionLoaders: loaders read the resolved lockfile and the transitional local one", async () => {
  let teamType = "";
  let autoType = "";
  await withExtensionBackedRepo("managed", async () => {
    await modelRegistry.ensureLoaded();
    await modelRegistry.ensureTypeLoaded(teamType);
    await modelRegistry.ensureTypeLoaded(autoType);
    assertEquals(modelRegistry.has(teamType), true);
    assertEquals(modelRegistry.has(autoType), true);
  }, {
    lockfile: "resolved",
    setup: async (fixture) => {
      const pulledRoot = join(
        fixture.repoDir,
        ".swamp",
        "config",
        "pulled-extensions",
      );
      teamType = `${fixture.scope}/team/thing`;
      autoType = `${fixture.scope}/auto/thing`;
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
      await writeLockfile(fixture.resolvedLockfilePath, {
        [`${fixture.scope}/team`]: { files: [] },
      });
      await writeLockfile(fixture.localLockfilePath, {
        [`${fixture.scope}/auto`]: { files: [] },
      });
    },
  });
});

Deno.test("configureExtensionLoaders: the missing-files warning reports a truncated auto-resolved entry separately, with a delete hint", async () => {
  await withExtensionBackedRepo("managed", ({ scope, warnings }) => {
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
      `${join(".swamp", "config", "pulled-extensions", scope, "auto-cut")}, ` +
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
    return Promise.resolve();
  }, {
    lockfile: "resolved",
    setup: async (
      { repoDir, scope, resolvedLockfilePath, localLockfilePath },
    ) => {
      const missing = (name: string) =>
        `.swamp/config/pulled-extensions/${name}/models/gone.ts`;
      await writeLockfile(resolvedLockfilePath, {
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
      await writeLockfile(localLockfilePath, {
        [`${scope}/auto-cut`]: {
          files: [missing(`${scope}/auto-cut`), skill],
        },
        [`${scope}/auto-cut2`]: { files: [missing(`${scope}/auto-cut2`)] },
        [`${scope}/auto-gone`]: { files: [missing(`${scope}/auto-gone`)] },
      });
    },
  });
});

Deno.test("configureExtensionLoaders: malformed lockfile entries are skipped by the missing-files check", async () => {
  await withExtensionBackedRepo("managed", ({ scope, warnings }) => {
    const team = warnings.find((w) =>
      w.error.includes("pulled extension(s) have missing source files")
    );
    assertStringIncludes(team?.error ?? "", `${scope}/team-gone`);
    assertEquals((team?.error ?? "").includes(`${scope}/null-entry`), false);
    return Promise.resolve();
  }, {
    lockfile: "resolved",
    setup: async ({ scope, resolvedLockfilePath }) => {
      await ensureDir(join(resolvedLockfilePath, ".."));
      await Deno.writeTextFile(
        resolvedLockfilePath,
        JSON.stringify({
          [`${scope}/null-entry`]: null,
          [`${scope}/null-file`]: { version: "1.0.0", files: [null] },
          [`${scope}/number-files`]: { version: "1.0.0", files: 5 },
          [`${scope}/team-gone`]: {
            version: "1.0.0",
            pulledAt: "2026-01-01T00:00:00Z",
            files: [
              `.swamp/config/pulled-extensions/${scope}/team-gone/models/gone.ts`,
            ],
          },
        }),
      );
    },
  });
});

Deno.test("configureExtensionLoaders: a transitional local lockfile containing null is skipped", async () => {
  await withExtensionBackedRepo("managed", ({ scope, warnings }) => {
    const team = warnings.find((w) =>
      w.error.includes("pulled extension(s) have missing source files")
    );
    assertStringIncludes(team?.error ?? "", `${scope}/team-gone`);
    return Promise.resolve();
  }, {
    lockfile: "resolved",
    setup: async ({ scope, resolvedLockfilePath, localLockfilePath }) => {
      await writeLockfile(resolvedLockfilePath, {
        [`${scope}/team-gone`]: {
          files: [
            `.swamp/config/pulled-extensions/${scope}/team-gone/models/gone.ts`,
          ],
        },
      });
      await ensureDir(join(localLockfilePath, ".."));
      await Deno.writeTextFile(localLockfilePath, "null\n");
    },
  });
});
