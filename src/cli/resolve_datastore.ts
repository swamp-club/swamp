// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
 * Resolves the datastore configuration from multiple sources.
 *
 * Priority: SWAMP_DATASTORE env var > CLI --datastore arg > .swamp.yaml config > default
 *
 * Env var format:
 *   - `SWAMP_DATASTORE=filesystem:/path/to/dir`
 *   - `SWAMP_DATASTORE=@scope/type:{"key":"value"}`
 *
 * Legacy `s3:bucket/prefix` format is auto-remapped to the `@swamp/s3-datastore` extension.
 *
 * Default: filesystem datastore at `{repoDir}/.swamp/` (full backward compatibility)
 */

import { join, resolve } from "@std/path";
import { getLogger } from "@logtape/logtape";
import type { RepoMarkerData } from "../infrastructure/persistence/repo_marker_repository.ts";
import type { DatastoreConfig } from "../domain/datastore/datastore_config.ts";
import { getSwampDataDir } from "../infrastructure/persistence/paths.ts";
import { expandEnvVars } from "../infrastructure/persistence/env_path.ts";
import { datastoreTypeRegistry } from "../domain/datastore/datastore_type_registry.ts";
import { UserError } from "../domain/errors.ts";
import { resolveDatastoreType } from "../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../domain/extensions/auto_resolver_context.ts";
import { maybeAutoUpdateDatastoreExtension } from "../libswamp/extensions/datastore_auto_update.ts";
import { FileExtensionUpdateCheckRepository } from "../infrastructure/persistence/extension_update_check_repository.ts";
import { readUpstreamExtensions } from "../infrastructure/persistence/upstream_extensions.ts";
import { ExtensionApiClient } from "../infrastructure/http/extension_api_client.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../domain/auth/auth_credentials.ts";
import {
  detectLocalEditsForExtension,
  enumeratePulledExtensionDirs,
  installExtension,
} from "../libswamp/mod.ts";
import { UserDatastoreLoader } from "../domain/datastore/user_datastore_loader.ts";
import { EmbeddedDenoRuntime } from "../infrastructure/runtime/embedded_deno_runtime.ts";
import { swampPath } from "../infrastructure/persistence/paths.ts";
import { SWAMP_SUBDIRS } from "../infrastructure/persistence/paths.ts";
import { resolveModelsDir } from "./resolve_models_dir.ts";

const logger = getLogger(["swamp", "datastore", "resolve"]);

/**
 * Maps old built-in datastore type names to their extension replacements.
 * Applied when loading datastore configs from .swamp.yaml or env vars.
 */
export const RENAMED_DATASTORE_TYPES: Record<string, string> = {
  "s3": "@swamp/s3-datastore",
};

/**
 * Checks if a @swamp/ datastore extension has an update available and
 * auto-pulls if so. Called from all @swamp/ resolution paths, placed
 * after resolveDatastoreType() but before createProvider().
 *
 * Never throws — failures are logged and silently ignored.
 */
async function maybeAutoUpdateSwampDatastore(
  type: string,
  repoDir: string,
  marker: RepoMarkerData | null,
): Promise<void> {
  if (!type.startsWith("@swamp/")) return;

  try {
    const resolvedRepoDir = resolve(repoDir);
    const swampDir = join(resolvedRepoDir, ".swamp");
    const modelsDir = resolveModelsDir(marker);
    const lockfilePath = join(
      resolvedRepoDir,
      modelsDir,
      "upstream_extensions.json",
    );
    logger.debug("Auto-update check for {type}, lockfile: {path}", {
      type,
      path: lockfilePath,
    });
    const serverUrl = Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;
    const extensionClient = new ExtensionApiClient(serverUrl);
    const cacheRepository = new FileExtensionUpdateCheckRepository(swampDir);

    const result = await maybeAutoUpdateDatastoreExtension(type, {
      getInstalledVersion: async (name) => {
        const upstream = await readUpstreamExtensions(lockfilePath);
        return upstream[name]?.version ?? null;
      },
      getLatestVersion: async (name) => {
        try {
          const info = await extensionClient.getExtension(name);
          return info?.latestVersion ?? null;
        } catch {
          return null;
        }
      },
      detectLocalEdits: (name) =>
        detectLocalEditsForExtension(repoDir, name, lockfilePath),
      pullExtension: async (name, version) => {
        const resolvedRepoDir = resolve(repoDir);

        // Pull the extension with the specific version. installExtension
        // derives per-extension destinations (models/workflows/vaults/
        // drivers/datastores/reports) from `name`; only skillsDir is
        // caller-owned because skills land in a tool-specific dir.
        await installExtension(
          { name, version },
          {
            getExtension: (n) => extensionClient.getExtension(n),
            downloadArchive: (n, v) => extensionClient.downloadArchive(n, v),
            getChecksum: (n, v) => extensionClient.getChecksum(n, v),
            logger,
            lockfilePath,
            skillsDir: swampPath(
              resolvedRepoDir,
              SWAMP_SUBDIRS.pulledSkills,
            ),
            repoDir: resolvedRepoDir,
            force: true,
            alreadyPulled: new Set(),
            depth: 0,
          },
        );

        // Hot-reload the datastore type from the updated extension.
        // Under the per-extension layout the loader walks each installed
        // extension's datastores subdir via enumeratePulledExtensionDirs
        // rather than a single shared dir.
        const pulledDirs = await enumeratePulledExtensionDirs(
          lockfilePath,
          resolvedRepoDir,
          "datastores",
        );
        if (pulledDirs.length > 0) {
          const denoRuntime = new EmbeddedDenoRuntime();
          const loader = new UserDatastoreLoader(denoRuntime, resolvedRepoDir);
          const [primary, ...rest] = pulledDirs;
          await loader.loadDatastores(primary, {
            skipAlreadyRegistered: false,
            additionalDirs: rest,
          });
        }
      },
      cacheRepository,
    });

    if (result?.updated) {
      logger.info(
        "Updated {name} {from} → {to}",
        { name: type, from: result.previousVersion, to: result.newVersion },
      );
    } else if (result?.skipped === "local_edits") {
      // Caller-layer surface for the auto-update refusal. The service
      // returns a structured result (not an exception) specifically so
      // this path bypasses the outer catch and reaches the user via
      // logtape WARN. Mirrors the #121 auto-resolver refusal message.
      logger.warn(buildLocalEditsWarning(type, result));
    }
  } catch {
    // Never block command execution for auto-update failures
  }
}

/**
 * Renders the user-visible warning for an auto-update that was refused
 * because local edits were detected. Exported so the message shape can be
 * unit-tested without having to mock the full datastore-resolution stack.
 */
export function buildLocalEditsWarning(
  type: string,
  result: { previousVersion?: string; newVersion?: string },
): string {
  return (
    `Not auto-updating ${type} ${result.previousVersion} → ${result.newVersion}: ` +
    `local edits detected under .swamp/pulled-extensions/${type}/. ` +
    `Run \`swamp extension pull ${type} --force\` to discard your edits and install the latest version.`
  );
}

/**
 * Parses the SWAMP_DATASTORE env var format into a DatastoreConfig.
 *
 * @param envValue - The env var value (e.g., "filesystem:/path" or "s3:bucket/prefix")
 * @param repoId - The repo ID for S3 cache path
 * @param repoDir - The repository root directory (for custom datastore path resolution)
 * @returns Parsed DatastoreConfig
 */
export async function parseDatastoreEnvVar(
  envValue: string,
  repoId?: string,
  repoDir?: string,
): Promise<DatastoreConfig> {
  const colonIdx = envValue.indexOf(":");
  if (colonIdx === -1) {
    throw new Error(
      `Invalid SWAMP_DATASTORE format: "${envValue}". ` +
        `Expected "filesystem:/path/to/dir" or "@scope/type:{...}".`,
    );
  }

  let type = envValue.slice(0, colonIdx);
  const value = envValue.slice(colonIdx + 1);

  if (type === "filesystem") {
    return { type: "filesystem", path: expandEnvVars(value) };
  }

  // Remap renamed types (e.g., "s3" → "@swamp/s3-datastore")
  const renamedTo = RENAMED_DATASTORE_TYPES[type];
  if (renamedTo) {
    logger.warn(
      `Datastore type '${type}' has been renamed to '${renamedTo}'. ` +
        `Update your SWAMP_DATASTORE env var to use the new name.`,
    );

    // Parse "s3:bucket/prefix" shorthand into config JSON
    if (type === "s3") {
      const slashIdx = value.indexOf("/");
      const bucket = slashIdx === -1 ? value : value.slice(0, slashIdx);
      const prefix = slashIdx === -1 ? undefined : value.slice(slashIdx + 1);

      // Ensure lazy-loaded extensions are loaded before auto-resolve
      await datastoreTypeRegistry.ensureLoaded();
      await resolveDatastoreType(renamedTo, getAutoResolver());
      await maybeAutoUpdateSwampDatastore(renamedTo, repoDir ?? ".", null);

      await datastoreTypeRegistry.ensureTypeLoaded(renamedTo);
      const typeInfo = datastoreTypeRegistry.get(renamedTo);
      if (typeInfo?.createProvider) {
        const config: Record<string, unknown> = { bucket };
        if (prefix) config.prefix = prefix;

        if (typeInfo.configSchema) {
          const result = typeInfo.configSchema.safeParse(config);
          if (!result.success) {
            throw new UserError(
              `Invalid config for datastore type "${renamedTo}": ${result.error.message}`,
            );
          }
        }

        const provider = typeInfo.createProvider(config);
        const resolvedRepoDir = repoDir ?? ".";
        const datastorePath = provider.resolveDatastorePath(resolvedRepoDir);
        const cachePath = provider.resolveCachePath?.(resolvedRepoDir) ??
          join(getSwampDataDir(), "repos", repoId ?? "unknown");
        return {
          type: renamedTo,
          config,
          datastorePath,
          cachePath,
        };
      }

      throw new UserError(
        `S3 datastore requires the @swamp/s3-datastore extension. ` +
          `Install it with: swamp extension pull @swamp/s3-datastore`,
      );
    }

    type = renamedTo;
  }

  // Ensure lazy-loaded extensions are loaded before auto-resolve
  await datastoreTypeRegistry.ensureLoaded();

  // Auto-resolve extension types (only fires if type is genuinely missing)
  if (type.startsWith("@")) {
    await resolveDatastoreType(type, getAutoResolver());
    await maybeAutoUpdateSwampDatastore(type, repoDir ?? ".", null);
  }

  // Custom datastore type: value is JSON config
  await datastoreTypeRegistry.ensureTypeLoaded(type);
  const typeInfo = datastoreTypeRegistry.get(type);
  if (!typeInfo) {
    const available = datastoreTypeRegistry.getAll().map((t) => t.type).join(
      ", ",
    );
    throw new UserError(
      `Unknown datastore type: "${type}". Available types: ${available}`,
    );
  }
  if (!typeInfo.createProvider) {
    throw new UserError(
      `Datastore type "${type}" is a built-in type without a provider. ` +
        `Use the built-in format (e.g., "filesystem:/path").`,
    );
  }

  let config: Record<string, unknown> = {};
  if (value) {
    try {
      config = JSON.parse(value) as Record<string, unknown>;
    } catch {
      throw new UserError(
        `Invalid JSON config for datastore type "${type}": ${value}`,
      );
    }
  }

  if (typeInfo.configSchema) {
    const result = typeInfo.configSchema.safeParse(config);
    if (!result.success) {
      throw new UserError(
        `Invalid config for datastore type "${type}": ${result.error.message}`,
      );
    }
  }

  const provider = typeInfo.createProvider(config);
  const resolvedRepoDir = repoDir ?? ".";
  const datastorePath = provider.resolveDatastorePath(resolvedRepoDir);
  const cachePath = provider.resolveCachePath?.(resolvedRepoDir) ??
    join(getSwampDataDir(), "repos", repoId ?? "unknown");

  return {
    type,
    config,
    datastorePath,
    cachePath,
  };
}

/**
 * Resolves the datastore configuration.
 *
 * Priority:
 * 1. SWAMP_DATASTORE environment variable
 * 2. CLI --datastore argument
 * 3. .swamp.yaml datastore config
 * 4. Default: filesystem at {repoDir}/.swamp/
 *
 * @param marker - The repo marker data (may be null)
 * @param cliArg - Optional CLI --datastore argument
 * @param repoDir - The repository root directory
 * @returns Resolved DatastoreConfig
 */
export async function resolveDatastoreConfig(
  marker: RepoMarkerData | null,
  cliArg?: string,
  repoDir?: string,
): Promise<DatastoreConfig> {
  const repoId = marker?.repoId;

  // 1. Environment variable takes highest priority
  const envDatastore = Deno.env.get("SWAMP_DATASTORE");
  if (envDatastore) {
    return await parseDatastoreEnvVar(envDatastore, repoId, repoDir);
  }

  // 2. CLI argument
  if (cliArg) {
    return await parseDatastoreEnvVar(cliArg, repoId, repoDir);
  }

  // 3. .swamp.yaml datastore config
  if (marker?.datastore) {
    const ds = marker.datastore;
    const dsType = ds.type;

    // Remap renamed types (e.g., "s3" → "@swamp/s3-datastore")
    const renamedTo = RENAMED_DATASTORE_TYPES[dsType];
    if (renamedTo) {
      logger.warn(
        `Datastore type '${dsType}' has been renamed to '${renamedTo}'. ` +
          `Update your .swamp.yaml to use the new name.`,
      );

      // Ensure lazy-loaded extensions are loaded before auto-resolve
      await datastoreTypeRegistry.ensureLoaded();
      await resolveDatastoreType(renamedTo, getAutoResolver());
      await maybeAutoUpdateSwampDatastore(
        renamedTo,
        repoDir ?? ".",
        marker ?? null,
      );

      await datastoreTypeRegistry.ensureTypeLoaded(renamedTo);
      const typeInfo = datastoreTypeRegistry.get(renamedTo);
      if (typeInfo?.createProvider) {
        // Build config from the S3-specific YAML fields
        const config: Record<string, unknown> = {};
        if (ds.bucket) config.bucket = ds.bucket;
        if (ds.prefix) config.prefix = ds.prefix;
        if (ds.region) config.region = ds.region;
        if (ds.endpoint) config.endpoint = ds.endpoint;
        if (ds.forcePathStyle != null) {
          config.forcePathStyle = ds.forcePathStyle;
        }

        if (typeInfo.configSchema) {
          const result = typeInfo.configSchema.safeParse(config);
          if (!result.success) {
            throw new UserError(
              `Invalid config for datastore type "${renamedTo}": ${result.error.message}`,
            );
          }
        }

        const provider = typeInfo.createProvider(config);
        const datastorePath = provider.resolveDatastorePath(repoDir ?? ".");
        const cachePath = provider.resolveCachePath?.(repoDir ?? ".") ??
          join(getSwampDataDir(), "repos", repoId ?? "unknown");

        return {
          type: renamedTo,
          config,
          datastorePath,
          cachePath,
          directories: ds.directories,
          exclude: ds.exclude,
        };
      }

      // Extension not available — error out
      throw new UserError(
        `S3 datastore requires the @swamp/s3-datastore extension. ` +
          `Install it with: swamp extension pull @swamp/s3-datastore`,
      );
    }

    if (dsType === "filesystem") {
      if (!ds.path) {
        throw new Error(
          "Filesystem datastore config in .swamp.yaml requires a 'path' field.",
        );
      }
      return {
        type: "filesystem",
        path: expandEnvVars(ds.path),
        directories: ds.directories,
        exclude: ds.exclude,
      };
    }

    // Ensure lazy-loaded extension datastores are loaded before checking
    // the registry. Without this, the registry appears empty after PR #1050's
    // lazy loading change, causing the auto-resolver to fire unnecessarily
    // and write progress JSON to stdout — corrupting --json output.
    await datastoreTypeRegistry.ensureLoaded();

    // Auto-resolve extension types (only fires if type is genuinely missing)
    if (dsType.startsWith("@")) {
      await resolveDatastoreType(dsType, getAutoResolver());
      await maybeAutoUpdateSwampDatastore(dsType, repoDir ?? ".", marker);
    }

    // Custom datastore type from YAML config
    await datastoreTypeRegistry.ensureTypeLoaded(dsType);
    const typeInfo = datastoreTypeRegistry.get(dsType);
    if (!typeInfo) {
      const available = datastoreTypeRegistry.getAll().map((t) => t.type).join(
        ", ",
      );
      throw new UserError(
        `Unknown datastore type "${dsType}" in .swamp.yaml. Available types: ${available}`,
      );
    }
    if (!typeInfo.createProvider) {
      throw new UserError(
        `Datastore type "${dsType}" is registered but has no provider.`,
      );
    }

    const customConfig = ds.config ?? {};

    if (typeInfo.configSchema) {
      const result = typeInfo.configSchema.safeParse(customConfig);
      if (!result.success) {
        throw new UserError(
          `Invalid config for datastore type "${dsType}": ${result.error.message}`,
        );
      }
    }

    const provider = typeInfo.createProvider(customConfig);
    const datastorePath = provider.resolveDatastorePath(repoDir ?? ".");
    const cachePath = provider.resolveCachePath?.(repoDir ?? ".") ??
      join(getSwampDataDir(), "repos", repoId ?? "unknown");

    return {
      type: dsType,
      config: customConfig,
      datastorePath,
      cachePath,
      directories: ds.directories,
      exclude: ds.exclude,
    };
  }

  // 4. Default: filesystem at {repoDir}/.swamp/
  const defaultPath = repoDir ? join(repoDir, ".swamp") : ".swamp";
  return { type: "filesystem", path: defaultPath };
}
