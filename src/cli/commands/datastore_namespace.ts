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

import { Command } from "@cliffy/command";
import { ensureDir, walk } from "@std/fs";
import { join } from "@std/path";
import {
  consumeStream,
  createLibSwampContext,
  datastoreNamespaceMigrate,
  datastoreNamespaceSet,
  datastoreNamespaceUnset,
  INFRASTRUCTURE_FILES,
} from "../../libswamp/mod.ts";
import {
  createNamespaceMigrateRenderer,
} from "../../presentation/renderers/datastore_namespace_migrate.ts";
import {
  createNamespaceSetRenderer,
} from "../../presentation/renderers/datastore_namespace_set.ts";
import {
  createNamespaceUnsetRenderer,
} from "../../presentation/renderers/datastore_namespace_unset.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { resolveDatastoreForRepo } from "../repo_context.ts";
import { datastoreBasePath } from "../resolve_datastore.ts";
import {
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import {
  createCatalogStore,
} from "../../infrastructure/persistence/repository_factory.ts";
import {
  listNamespaceManifests,
  removeNamespaceManifest,
  writeNamespaceManifest,
} from "../../infrastructure/persistence/namespace_manifest.ts";
import { basename } from "@std/path";
import {
  type CustomDatastoreConfig,
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import type { DatastoreProvider } from "../../domain/datastore/datastore_provider.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const datastoreNamespaceSetCommand = new Command()
  .description("Assign a namespace to this repository")
  .example("Set namespace", "swamp datastore namespace set infra")
  .arguments("<slug:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions, slug: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "datastore",
      "namespace",
      "set",
    ]);
    cliCtx.logger.debug("Executing datastore namespace set command");

    const repoDir = resolveRepoDir(options.repoDir);
    const { datastoreConfig, marker } = await resolveDatastoreForRepo(repoDir);
    const dsBasePath = datastoreBasePath(datastoreConfig);
    const markerRepo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(repoDir);
    const repoId = marker?.repoId ?? crypto.randomUUID();

    let supportsRegistration = true;
    let resolvedProvider: DatastoreProvider | undefined;
    if (isCustomDatastoreConfig(datastoreConfig)) {
      await datastoreTypeRegistry.ensureLoaded();
      await datastoreTypeRegistry.ensureTypeLoaded(datastoreConfig.type);
      const typeInfo = datastoreTypeRegistry.get(datastoreConfig.type);
      resolvedProvider = typeInfo?.createProvider?.(datastoreConfig.config);
      supportsRegistration = !!resolvedProvider?.registerNamespace;
    }

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = {
      getDatastorePath: () => dsBasePath,
      getCurrentNamespace: () => datastoreConfig.namespace,
      supportsRegistration,
      listNamespaces: async () => {
        if (resolvedProvider?.listNamespaces) {
          const slugs = await resolvedProvider.listNamespaces(
            (datastoreConfig as CustomDatastoreConfig).datastorePath,
          );
          return slugs.map((ns) => ({ namespace: ns, repoId: "" }));
        }
        const manifests = await listNamespaceManifests(dsBasePath);
        return manifests.map((m) => ({
          namespace: m.namespace,
          repoId: m.repoId,
        }));
      },
      registerNamespace: async (namespace: string, rId: string) => {
        if (resolvedProvider?.registerNamespace) {
          await resolvedProvider.registerNamespace(
            (datastoreConfig as CustomDatastoreConfig).datastorePath,
            namespace,
            rId,
          );
          return;
        }
        await writeNamespaceManifest(dsBasePath, namespace, rId);
      },
      updateMarkerNamespace: async (namespace: string) => {
        const current = await markerRepo.read(repoPath);
        if (!current) {
          throw new UserError(
            "Cannot update namespace: .swamp.yaml marker not found.",
          );
        }
        current.datastore = current.datastore ??
          { type: "filesystem", path: join(repoDir, ".swamp") };
        current.datastore.namespace = namespace;
        await markerRepo.write(repoPath, current);
      },
      getRepoId: () => repoId,
    };

    const renderer = createNamespaceSetRenderer(cliCtx.outputMode);
    await consumeStream(
      datastoreNamespaceSet(ctx, deps, { slug }),
      renderer.handlers(),
    );
  });

export const datastoreNamespaceUnsetCommand = new Command()
  .description("Remove namespace from this repository")
  .example("Unset namespace", "swamp datastore namespace unset")
  .example(
    "Unset and reverse-migrate data",
    "swamp datastore namespace unset --migrate --confirm",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--migrate",
    "Also reverse-migrate data back to un-namespaced layout",
  )
  .option(
    "--confirm",
    "Execute the migration (required with --migrate, ignored otherwise)",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "datastore",
      "namespace",
      "unset",
    ]);
    cliCtx.logger.debug("Executing datastore namespace unset command");

    const repoDir = resolveRepoDir(options.repoDir);
    const { datastoreConfig } = await resolveDatastoreForRepo(repoDir);
    const dsBasePath = isCustomDatastoreConfig(datastoreConfig) &&
        datastoreConfig.cachePath
      ? datastoreConfig.cachePath
      : datastoreBasePath(datastoreConfig);
    const markerRepo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(repoDir);

    let unsetProvider: DatastoreProvider | undefined;
    if (isCustomDatastoreConfig(datastoreConfig)) {
      await datastoreTypeRegistry.ensureLoaded();
      await datastoreTypeRegistry.ensureTypeLoaded(datastoreConfig.type);
      const typeInfo = datastoreTypeRegistry.get(datastoreConfig.type);
      unsetProvider = typeInfo?.createProvider?.(datastoreConfig.config);
    }

    if (options.migrate) {
      const savedNamespace = datastoreConfig.namespace;
      if (!savedNamespace) {
        throw new UserError(
          "No namespace is configured. Nothing to unset or migrate.",
        );
      }

      const namespaces = unsetProvider?.listNamespaces
        ? await unsetProvider.listNamespaces(
          (datastoreConfig as CustomDatastoreConfig).datastorePath,
        )
        : (await listNamespaceManifests(dsBasePath)).map((m) => m.namespace);

      if (namespaces.length > 1) {
        throw new UserError(
          `Cannot unset namespace: datastore contains ${namespaces.length} namespaces ` +
            `(${
              namespaces.join(", ")
            }). Unsetting is only allowed when a single namespace exists.`,
        );
      }

      const ctx = createLibSwampContext({ logger: cliCtx.logger });
      const migrateDeps = buildMigrateDeps(
        repoDir,
        dsBasePath,
        datastoreConfig,
        savedNamespace,
        unsetProvider,
      );

      const migrateRenderer = createNamespaceMigrateRenderer(
        cliCtx.outputMode,
      );
      await consumeStream(
        datastoreNamespaceMigrate(ctx, migrateDeps, {
          confirm: !!options.confirm,
          reverse: true,
        }),
        migrateRenderer.handlers(),
      );

      if (options.confirm) {
        const current = await markerRepo.read(repoPath);
        if (current?.datastore) {
          delete current.datastore.namespace;
          await markerRepo.write(repoPath, current);
        }
      }

      return;
    }

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = {
      getCurrentNamespace: () => datastoreConfig.namespace,
      listNamespaces: async () => {
        if (unsetProvider?.listNamespaces) {
          return await unsetProvider.listNamespaces(
            (datastoreConfig as CustomDatastoreConfig).datastorePath,
          );
        }
        const manifests = await listNamespaceManifests(dsBasePath);
        return manifests.map((m) => m.namespace);
      },
      removeMarkerNamespace: async () => {
        const current = await markerRepo.read(repoPath);
        if (current?.datastore) {
          delete current.datastore.namespace;
          await markerRepo.write(repoPath, current);
        }
      },
    };

    const renderer = createNamespaceUnsetRenderer(cliCtx.outputMode);
    await consumeStream(
      datastoreNamespaceUnset(ctx, deps),
      renderer.handlers(),
    );
  });

async function dirSize(
  path: string,
): Promise<{ fileCount: number; totalBytes: number }> {
  let fileCount = 0;
  let totalBytes = 0;
  try {
    for await (
      const entry of walk(path, { includeFiles: true, includeDirs: false })
    ) {
      fileCount++;
      try {
        const stat = await Deno.stat(entry.path);
        totalBytes += stat.size;
      } catch {
        // Skip files that can't be stat'd
      }
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return { fileCount: 0, totalBytes: 0 };
    }
    throw e;
  }
  return { fileCount, totalBytes };
}

function buildMigrateDeps(
  repoDir: string,
  dsBasePath: string,
  datastoreConfig: { namespace?: string; type: string },
  namespace: string,
  provider: DatastoreProvider | undefined,
): Parameters<typeof datastoreNamespaceMigrate>[1] {
  const isExtension = isCustomDatastoreConfig(
    datastoreConfig as Parameters<typeof isCustomDatastoreConfig>[0],
  );
  let catalogStore: ReturnType<typeof createCatalogStore> | null = null;

  return {
    getDatastorePath: () => dsBasePath,
    getNamespace: () => namespace,
    dirExists: async (path: string) => {
      try {
        const stat = await Deno.stat(path);
        return stat.isDirectory;
      } catch {
        return false;
      }
    },
    dirHasDataFiles: async (path: string) => {
      try {
        const stat = await Deno.stat(path);
        if (!stat.isDirectory) return false;
      } catch {
        return false;
      }
      for await (const entry of Deno.readDir(path)) {
        if (!INFRASTRUCTURE_FILES.has(basename(entry.name))) return true;
      }
      return false;
    },
    dirSize,
    renameDir: (source: string, destination: string) =>
      Deno.rename(source, destination),
    mergeDirInto: async (source: string, destination: string) => {
      const mergeRecursive = async (
        src: string,
        dst: string,
      ): Promise<number> => {
        let moved = 0;
        for await (const entry of Deno.readDir(src)) {
          const srcPath = join(src, entry.name);
          const dstPath = join(dst, entry.name);
          let dstExists = false;
          try {
            await Deno.stat(dstPath);
            dstExists = true;
          } catch {
            // doesn't exist
          }
          if (!dstExists) {
            await Deno.rename(srcPath, dstPath);
            moved++;
          } else if (entry.isDirectory) {
            moved += await mergeRecursive(srcPath, dstPath);
          }
        }
        return moved;
      };
      const moved = await mergeRecursive(source, destination);
      try {
        await Deno.remove(source, { recursive: true });
      } catch {
        // Best-effort cleanup
      }
      return moved;
    },
    ensureDir: (path: string) => ensureDir(path),
    invalidateCatalog: () => {
      catalogStore = createCatalogStore(repoDir);
      try {
        catalogStore.invalidate();
      } finally {
        catalogStore.close();
      }
    },
    markDirtyBulk: async () => {
      if (!provider?.createSyncService) return;
      const customConfig = datastoreConfig as CustomDatastoreConfig;
      const syncService = provider.createSyncService(
        repoDir,
        customConfig.cachePath ?? customConfig.datastorePath,
      );
      await syncService.markDirty();
    },
    removeNamespaceManifest: (ns: string) =>
      removeNamespaceManifest(dsBasePath, ns),
    isExtensionDatastore: isExtension,
  };
}

export const datastoreNamespaceMigrateCommand = new Command()
  .description("Migrate data to namespaced layout (use --reverse to undo)")
  .example(
    "Preview migration",
    "swamp datastore namespace migrate",
  )
  .example(
    "Execute migration",
    "swamp datastore namespace migrate --confirm",
  )
  .example(
    "Reverse migration (namespaced → solo)",
    "swamp datastore namespace migrate --reverse --confirm",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--confirm",
    "Execute the migration (without this flag, only a preview is shown)",
  )
  .option(
    "--reverse",
    "Reverse-migrate from namespaced layout back to solo layout",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "datastore",
      "namespace",
      "migrate",
    ]);
    cliCtx.logger.debug("Executing datastore namespace migrate command");

    const repoDir = resolveRepoDir(options.repoDir);
    const { datastoreConfig } = await resolveDatastoreForRepo(repoDir);
    const dsBasePath = isCustomDatastoreConfig(datastoreConfig) &&
        datastoreConfig.cachePath
      ? datastoreConfig.cachePath
      : datastoreBasePath(datastoreConfig);
    const namespace = datastoreConfig.namespace;

    if (!namespace) {
      throw new UserError(
        "No namespace is configured. Run 'swamp datastore namespace set <slug>' first.",
      );
    }

    let migrateProvider: DatastoreProvider | undefined;
    if (isCustomDatastoreConfig(datastoreConfig)) {
      await datastoreTypeRegistry.ensureLoaded();
      await datastoreTypeRegistry.ensureTypeLoaded(datastoreConfig.type);
      const typeInfo = datastoreTypeRegistry.get(datastoreConfig.type);
      migrateProvider = typeInfo?.createProvider?.(datastoreConfig.config);
    }

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = buildMigrateDeps(
      repoDir,
      dsBasePath,
      datastoreConfig,
      namespace,
      migrateProvider,
    );

    const renderer = createNamespaceMigrateRenderer(cliCtx.outputMode);
    await consumeStream(
      datastoreNamespaceMigrate(ctx, deps, {
        confirm: !!options.confirm,
        reverse: !!options.reverse,
      }),
      renderer.handlers(),
    );
  });
