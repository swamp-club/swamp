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
import { ExtensionCatalogStore } from "../infrastructure/persistence/extension_catalog_store.ts";
import {
  incrementReloadGeneration,
  LockfileRepository,
} from "../libswamp/mod.ts";
import { removeAttachedExtensionsForType } from "../domain/extensions/model_kind_adapter.ts";
import { extensionKindToKindDir } from "../domain/extensions/source_failure_recorder.ts";
import { computeSourceFingerprint } from "../domain/extensions/bundle_freshness.ts";
import { bundleExtension } from "../domain/models/bundle.ts";
import { EmbeddedDenoRuntime } from "../infrastructure/runtime/embedded_deno_runtime.ts";
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
import { readServeConfigFile } from "./serve_config.ts";
import type { TriggerOverride } from "../libswamp/mod.ts";

const logger = getSwampLogger(["serve", "reload"]);

let reloading = false;

export function isReloading(): boolean {
  return reloading;
}

export async function reloadPulledExtensions(
  repoDir: string,
  lockfilePath: string,
  pulledExtensionsRoot?: string,
): Promise<number> {
  incrementReloadGeneration();

  const catalogDbPath = swampPath(repoDir, "_extension_catalog.db");

  const catalog = new ExtensionCatalogStore(catalogDbPath);
  try {
    const lockfile = await LockfileRepository.create(lockfilePath);
    const entries = lockfile.getAllEntries();

    const pulledRoot = pulledExtensionsRoot ??
      resolvePulledExtensionsRoot(repoDir);
    const rebundled = new Set<string>();
    let denoRuntime: EmbeddedDenoRuntime | undefined;
    let denoPath: string | undefined;
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
): Promise<string> {
  let marker: RepoMarkerData | null = null;
  try {
    const markerRepo = new RepoMarkerRepository();
    marker = await markerRepo.read(RepoPath.create(repoDir));
  } catch {
    // Not in a swamp repo or marker unreadable — resolveManagedConfigPaths uses default paths
  }
  if (marker?.datastore?.managedConfig) {
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

  try {
    reloadedCount = await reloadPulledExtensions(
      repoDir,
      lockfilePath,
      pulledExtensionsRoot,
    );

    try {
      await reloadTrustedCollectives(repoDir);
    } catch (err) {
      errors.push(
        "Failed to refresh trust list: " +
          (err instanceof Error ? err.message : String(err)),
      );
    }

    if (options?.triggerOverrideUpdater) {
      try {
        const config = await readServeConfigFile(repoDir);
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

    return { success: true, reloadedCount, triggerOverridesChanged, errors };
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
