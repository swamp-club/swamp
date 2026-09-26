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

import { dirname, isAbsolute, join, resolve } from "@std/path";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { modelRegistry } from "../domain/models/model.ts";
import { vaultTypeRegistry } from "../domain/vaults/vault_type_registry.ts";
import { reportRegistry } from "../domain/reports/report_registry.ts";
import { datastoreTypeRegistry } from "../domain/datastore/datastore_type_registry.ts";
import { webhookTypeRegistry } from "../domain/webhooks/webhook_type_registry.ts";
import { ExtensionCatalogStore } from "../infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../infrastructure/persistence/extension_repository.ts";
import {
  enumeratePulledExtensionDirs,
  LockfileRepository,
  ReconcileFromDiskService,
  type UncataloguedPulledResult,
} from "../libswamp/mod.ts";
import type { DenoRuntime } from "../domain/runtime/deno_runtime.ts";
import {
  modelKindAdapter,
  removeAttachedExtensionsForType,
} from "../domain/extensions/model_kind_adapter.ts";
import { extensionKindToKindDir } from "../domain/extensions/source_failure_recorder.ts";
import { computeSourceFingerprint } from "../domain/extensions/bundle_freshness.ts";
import { bundleExtension } from "../domain/models/bundle.ts";
import { EmbeddedDenoRuntime } from "../infrastructure/runtime/embedded_deno_runtime.ts";
import { ExtensionLoader } from "../domain/extensions/extension_loader.ts";
import { ModelType } from "../domain/models/model_type.ts";
import { swampPath } from "../infrastructure/persistence/paths.ts";
import { canonicalizePath } from "../infrastructure/persistence/canonicalize_path.ts";
import {
  type RepoMarkerData,
  RepoMarkerRepository,
} from "../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../domain/repo/repo_path.ts";
import { getAutoResolver } from "../domain/extensions/auto_resolver_context.ts";
import { AuthRepository } from "../infrastructure/persistence/auth_repository.ts";
import { resolveTrustedCollectives } from "../libswamp/mod.ts";
import {
  managedConfigLockfilePath,
  resolvePulledExtensionsRoot,
} from "../infrastructure/persistence/paths.ts";
import { resolveModelsDir } from "../cli/resolve_models_dir.ts";
import type { ServeReloadResponse } from "./protocol.ts";
import {
  readServeConfigFile,
  type WebhookConfigEntry,
} from "./serve_config.ts";
import type { TriggerOverride } from "../libswamp/mod.ts";
import { vaultKindAdapter } from "../domain/extensions/vault_kind_adapter.ts";
import { datastoreKindAdapter } from "../domain/extensions/datastore_kind_adapter.ts";
import { reportKindAdapter } from "../domain/extensions/report_kind_adapter.ts";
import { webhookKindAdapter } from "../domain/extensions/webhook_kind_adapter.ts";
import type { KindAdapter } from "../domain/extensions/kind_adapter.ts";

const logger = getSwampLogger(["serve", "reload"]);

let reloading = false;

export function isReloading(): boolean {
  return reloading;
}

/**
 * Catalogues lockfile entries that have no catalog rows, so the register
 * loop below picks their types up and later reloads hot-reload them.
 * Files reach a running serve without rows when a managed-config sync
 * copies them in (swamp-club#2355). Failures are logged, never thrown:
 * one bad extension must not stop the reload.
 */
async function catalogueUncataloguedPulled(args: {
  catalog: ExtensionCatalogStore;
  lockfile: LockfileRepository;
  names: readonly string[];
  repoDir: string;
  pulledRoot: string;
  denoRuntime: DenoRuntime;
}): Promise<void> {
  const reconciler = new ReconcileFromDiskService({
    denoRuntime: args.denoRuntime,
    repository: new ExtensionRepository({
      catalog: args.catalog,
      lockfileRepository: args.lockfile,
      repoRoot: args.repoDir,
    }),
    lockfileRepository: args.lockfile,
    repoDir: args.repoDir,
    pulledExtensionsRoot: args.pulledRoot,
  });
  let results: UncataloguedPulledResult[];
  try {
    results = await reconciler.reconcileUncataloguedPulled(args.names);
  } catch (err) {
    logger.warn(
      "Hot-reload: failed to catalogue new pulled extensions: {error}",
      { error: err instanceof Error ? err.message : String(err) },
    );
    return;
  }
  for (const result of results) {
    if (result.status === "catalogued" && result.transitions.length > 0) {
      logger.info(
        "Hot-reload: catalogued pulled extension {extension} ({count} source(s))",
        { extension: result.name, count: result.transitions.length },
      );
    } else if (result.status === "failed") {
      logger.warn(
        "Hot-reload: failed to catalogue pulled extension {extension}: {error}",
        {
          extension: result.name,
          error: result.error instanceof Error
            ? result.error.message
            : String(result.error),
        },
      );
    }
  }
}

/**
 * Re-registers every catalogued pulled type, after cataloguing lockfile
 * entries that have no rows yet and re-bundling changed sources.
 * `denoRuntimeOverride` lets tests supply a stub runtime; production
 * callers omit it and get an EmbeddedDenoRuntime created on first use.
 */
export async function reloadPulledExtensions(
  repoDir: string,
  lockfilePath: string,
  pulledExtensionsRoot?: string,
  denoRuntimeOverride?: DenoRuntime,
): Promise<number> {
  const catalogDbPath = swampPath(repoDir, "_extension_catalog.db");

  const catalog = new ExtensionCatalogStore(catalogDbPath);
  try {
    const lockfile = await LockfileRepository.create(lockfilePath);
    const entries = lockfile.getAllEntries();

    const pulledRoot = pulledExtensionsRoot ??
      resolvePulledExtensionsRoot(repoDir);
    const rebundled = new Set<string>();
    let denoRuntime: DenoRuntime | undefined = denoRuntimeOverride;
    let denoPath: string | undefined;

    const uncatalogued = Object.keys(entries).filter((extName) =>
      catalog.findBySourcePathPrefix(
        canonicalizePath(join(pulledRoot, extName) + "/"),
      ).length === 0
    );
    if (uncatalogued.length > 0) {
      denoRuntime ??= new EmbeddedDenoRuntime();
      await catalogueUncataloguedPulled({
        catalog,
        lockfile,
        names: uncatalogued,
        repoDir,
        pulledRoot,
        denoRuntime,
      });
    }

    for (const [extName] of Object.entries(entries)) {
      const sourcePrefix = canonicalizePath(
        join(pulledRoot, extName) + "/",
      );
      const allRows = catalog.findBySourcePathPrefix(sourcePrefix);
      for (const row of allRows) {
        if (
          !row.source_path || !row.bundle_path ||
          rebundled.has(row.source_path)
        ) continue;
        try {
          const kindDir = extensionKindToKindDir(
            row.kind as Parameters<typeof extensionKindToKindDir>[0],
          );
          const baseDir = join(pulledRoot, extName, kindDir);
          const currentFp = await computeSourceFingerprint(
            row.source_path,
            baseDir,
          );
          if (currentFp === row.source_fingerprint) continue;
          if (!denoRuntime) {
            denoRuntime = new EmbeddedDenoRuntime();
          }
          if (!denoPath) {
            denoPath = await denoRuntime.ensureDeno();
          }
          const js = await bundleExtension(row.source_path, denoPath, {
            env: denoRuntime.getDenoEnv(),
          });
          await Deno.mkdir(dirname(row.bundle_path), { recursive: true });
          await Deno.writeTextFile(row.bundle_path, js);
          catalog.updateSourceFingerprint(row.source_path, currentFp);
          rebundled.add(row.source_path);
        } catch (err) {
          logger.warn(
            "Hot-reload: failed to re-bundle {path}, keeping old bundle: {error}",
            {
              path: row.source_path,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
    }

    let reloadedCount = 0;
    for (const [name] of Object.entries(entries)) {
      const sourcePrefix = canonicalizePath(
        join(pulledRoot, name) + "/",
      );
      const rows = catalog.findBySourcePathPrefix(sourcePrefix);
      if (rows.length === 0) continue;

      for (const row of rows) {
        if (!row.type_normalized) continue;
        try {
          const kind = row.kind;

          if (kind === "model") {
            modelRegistry.invalidateType(row.type_normalized);
            removeAttachedExtensionsForType(row.type_normalized);
            modelRegistry.registerLazy({
              type: ModelType.create(row.type_normalized),
              bundlePath: row.bundle_path,
              sourcePath: row.source_path,
              version: row.version,
              sourceFingerprint: row.source_fingerprint,
            });
            await modelRegistry.ensureTypeLoaded(row.type_normalized);
            reloadedCount++;
          } else if (kind === "vault") {
            vaultTypeRegistry.invalidateType(row.type_normalized);
            vaultTypeRegistry.registerLazy({
              type: row.type_normalized,
              bundlePath: row.bundle_path,
              sourcePath: row.source_path,
              version: row.version,
            });
            await vaultTypeRegistry.ensureTypeLoaded(row.type_normalized);
            reloadedCount++;
          } else if (kind === "datastore") {
            datastoreTypeRegistry.invalidateType(row.type_normalized);
            datastoreTypeRegistry.registerLazy({
              type: row.type_normalized,
              bundlePath: row.bundle_path,
              sourcePath: row.source_path,
              version: row.version,
            });
            await datastoreTypeRegistry.ensureTypeLoaded(row.type_normalized);
            reloadedCount++;
          } else if (kind === "report") {
            reportRegistry.invalidateType(row.type_normalized);
            reportRegistry.registerLazy({
              type: row.type_normalized,
              bundlePath: row.bundle_path,
              sourcePath: row.source_path,
              version: row.version,
            });
            await reportRegistry.ensureTypeLoaded(row.type_normalized);
            reloadedCount++;
          } else if (kind === "webhook") {
            webhookTypeRegistry.invalidateType(row.type_normalized);
            webhookTypeRegistry.registerLazy({
              type: row.type_normalized,
              bundlePath: row.bundle_path,
              sourcePath: row.source_path,
              version: row.version,
            });
            await webhookTypeRegistry.ensureTypeLoaded(row.type_normalized);
            reloadedCount++;
          }
        } catch (err) {
          logger.warn(
            "Failed to reload type {type} from {extension}: {error}",
            {
              type: row.type_normalized,
              extension: name,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
    }
    return reloadedCount;
  } finally {
    catalog.close();
  }
}

export async function reloadTrustedCollectives(
  repoDir: string,
): Promise<void> {
  const markerRepo = new RepoMarkerRepository();
  const marker = await markerRepo.read(RepoPath.create(repoDir));

  let authCollectives: string[] | undefined;
  try {
    const authRepo = new AuthRepository();
    const creds = await authRepo.load();
    authCollectives = creds?.collectives;
  } catch {
    // Auth file unreadable — continue without membership collectives
  }

  const collectives = resolveTrustedCollectives(marker, authCollectives);
  const resolver = getAutoResolver();
  if (resolver) {
    resolver.updateAllowedCollectives(collectives);
  }
}

export async function resolveLockfilePath(
  repoDir: string,
  datastoreResolver?:
    import("../domain/datastore/datastore_path_resolver.ts").DatastorePathResolver,
): Promise<string> {
  let marker: RepoMarkerData | null = null;
  try {
    const markerRepo = new RepoMarkerRepository();
    marker = await markerRepo.read(RepoPath.create(repoDir));
  } catch {
    // Not in a swamp repo or marker unreadable — use default paths
  }
  if (marker?.datastore?.managedConfig) {
    if (datastoreResolver) {
      const configBase = datastoreResolver.resolvePath("config");
      return join(configBase, "upstream_extensions.json");
    }
    return managedConfigLockfilePath(repoDir);
  }
  const modelsDir = resolveModelsDir(marker);
  return join(
    isAbsolute(modelsDir) ? modelsDir : resolve(repoDir, modelsDir),
    "upstream_extensions.json",
  );
}

export interface ServeReloadOptions {
  triggerOverrideUpdater?: (
    overrides: ReadonlyMap<string, TriggerOverride>,
  ) => Promise<number>;
  workflowReloader?: () => Promise<number>;
  extensionDiscoverer?: () => Promise<number>;
  webhookUpdater?: (
    configs: readonly WebhookConfigEntry[],
  ) => Promise<number>;
}

export async function performServeReload(
  repoDir: string,
  lockfilePath: string,
  options?: ServeReloadOptions,
  pulledExtensionsRoot?: string,
): Promise<ServeReloadResponse> {
  if (reloading) {
    return {
      success: false,
      reloadedCount: 0,
      errors: ["Reload already in progress"],
    };
  }

  reloading = true;
  const errors: string[] = [];
  let reloadedCount = 0;
  let triggerOverridesChanged = 0;
  let workflowsReloaded = 0;
  let webhooksReloaded = 0;

  try {
    reloadedCount = await reloadPulledExtensions(
      repoDir,
      lockfilePath,
      pulledExtensionsRoot,
    );

    if (options?.extensionDiscoverer) {
      try {
        const discovered = await options.extensionDiscoverer();
        reloadedCount += discovered;
      } catch (err) {
        errors.push(
          "Failed to discover new extensions: " +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    try {
      await reloadTrustedCollectives(repoDir);
    } catch (err) {
      errors.push(
        "Failed to refresh trust list: " +
          (err instanceof Error ? err.message : String(err)),
      );
    }

    if (options?.workflowReloader) {
      try {
        workflowsReloaded = await options.workflowReloader();
      } catch (err) {
        errors.push(
          "Failed to reload workflows: " +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    const needsConfigRead = options?.triggerOverrideUpdater ||
      options?.webhookUpdater;
    let configReadFailed = false;
    const config = needsConfigRead
      ? await readServeConfigFile(repoDir).catch((err: unknown) => {
        errors.push(
          "Failed to read serve config: " +
            (err instanceof Error ? err.message : String(err)),
        );
        configReadFailed = true;
        return null;
      })
      : null;

    if (options?.triggerOverrideUpdater && !configReadFailed) {
      try {
        const overrides = new Map<string, TriggerOverride>(
          config?.triggers ? Object.entries(config.triggers) : [],
        );
        triggerOverridesChanged = await options.triggerOverrideUpdater(
          overrides,
        );
      } catch (err) {
        errors.push(
          "Failed to reload trigger overrides: " +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    if (options?.webhookUpdater && !configReadFailed) {
      try {
        webhooksReloaded = await options.webhookUpdater(
          config?.webhooks ?? [],
        );
      } catch (err) {
        errors.push(
          "Failed to reload webhook config: " +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    return {
      success: true,
      reloadedCount,
      triggerOverridesChanged,
      workflowsReloaded,
      webhooksReloaded,
      errors,
    };
  } catch (err) {
    return {
      success: false,
      reloadedCount: 0,
      errors: [
        "Hot-reload failed: " +
        (err instanceof Error ? err.message : String(err)),
      ],
    };
  } finally {
    reloading = false;
  }
}

export interface ExtensionDiscoveryDeps {
  lockfilePath: string;
  repoDir: string;
  pulledExtensionsRoot?: string;
  denoRuntime?: DenoRuntime;
}

/**
 * Returns the canonical source paths, under the given pulled extensions,
 * whose catalog row is of the adapter's kind and whose type is already
 * registered. reloadPulledExtensions has just re-registered exactly these,
 * so discovery can skip them before reading, bundling or importing
 * (swamp-club#2355). Model add-on (`extension` kind) rows are left out, so
 * those files keep the full load.
 */
export function collectRegisteredPulledSources(
  catalog: ExtensionCatalogStore,
  pulledRoot: string,
  extensionNames: readonly string[],
  adapter: KindAdapter,
): Set<string> {
  const paths = new Set<string>();
  for (const name of extensionNames) {
    const prefix = canonicalizePath(join(pulledRoot, name) + "/");
    for (const row of catalog.findBySourcePathPrefix(prefix)) {
      if (row.kind !== adapter.kind || !row.type_normalized) continue;
      if (!adapter.hasType(row.type_normalized)) continue;
      paths.add(canonicalizePath(row.source_path));
    }
  }
  return paths;
}

export function createExtensionDiscoverer(
  deps: ExtensionDiscoveryDeps,
): () => Promise<number> {
  return async () => {
    const { lockfilePath, repoDir, pulledExtensionsRoot } = deps;
    const denoRuntime = deps.denoRuntime ?? new EmbeddedDenoRuntime();
    const pulledRoot = pulledExtensionsRoot ??
      resolvePulledExtensionsRoot(repoDir);
    const extensionNames = Object.keys(
      (await LockfileRepository.create(lockfilePath)).getAllEntries(),
    );
    let discovered = 0;

    const kinds: Array<
      {
        type: Parameters<typeof enumeratePulledExtensionDirs>[2];
        adapter: KindAdapter;
      }
    > = [
      { type: "models", adapter: modelKindAdapter },
      { type: "vaults", adapter: vaultKindAdapter },
      { type: "datastores", adapter: datastoreKindAdapter },
      { type: "reports", adapter: reportKindAdapter },
      { type: "webhooks", adapter: webhookKindAdapter },
    ];

    const catalog = new ExtensionCatalogStore(
      swampPath(repoDir, "_extension_catalog.db"),
    );
    try {
      for (const { type, adapter } of kinds) {
        const dirs = await enumeratePulledExtensionDirs(
          lockfilePath,
          repoDir,
          type,
          pulledExtensionsRoot,
        );
        if (dirs.length === 0) continue;

        const loader = new ExtensionLoader(denoRuntime, adapter, repoDir);
        const [primary, ...rest] = dirs;
        const result = await loader.load(primary, {
          skipAlreadyRegistered: true,
          additionalDirs: rest,
          skipSourcePaths: collectRegisteredPulledSources(
            catalog,
            pulledRoot,
            extensionNames,
            adapter,
          ),
        });
        discovered += result.loaded.length;
      }
    } finally {
      catalog.close();
    }

    return discovered;
  };
}
