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

import { isAbsolute, join, resolve } from "@std/path";
import { getLogger } from "@logtape/logtape";
import type { RepoMarkerData } from "../infrastructure/persistence/repo_marker_repository.ts";
import {
  type DatastoreConfig,
  isCustomDatastoreConfig,
} from "../domain/datastore/datastore_config.ts";
import { getSwampDataDir } from "../infrastructure/persistence/paths.ts";
import { expandEnvVars } from "../infrastructure/persistence/env_path.ts";
import { datastoreTypeRegistry } from "../domain/datastore/datastore_type_registry.ts";
import { UserError } from "../domain/errors.ts";
import { resolveDatastoreType } from "../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../domain/extensions/auto_resolver_context.ts";

const logger = getLogger(["swamp", "datastore", "resolve"]);

export function datastoreBasePath(config: DatastoreConfig): string {
  return isCustomDatastoreConfig(config) ? config.datastorePath : config.path;
}

/**
 * Maps old built-in datastore type names to their extension replacements.
 * Applied when loading datastore configs from .swamp.yaml or env vars.
 */
export const RENAMED_DATASTORE_TYPES: Record<string, string> = {
  "s3": "@swamp/s3-datastore",
};

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
    const expanded = expandEnvVars(value);
    const absPath = isAbsolute(expanded)
      ? expanded
      : resolve(repoDir ?? Deno.cwd(), expanded);
    return { type: "filesystem", path: absPath };
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
          hydrationStrategy: config.hydrationStrategy as
            | "full"
            | "lazy"
            | undefined,
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
    hydrationStrategy: config.hydrationStrategy as
      | "full"
      | "lazy"
      | undefined,
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
          hydrationStrategy: ds.hydrationStrategy,
          namespace: ds.namespace,
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
      const expanded = expandEnvVars(ds.path);
      const absPath = isAbsolute(expanded)
        ? expanded
        : resolve(repoDir ?? Deno.cwd(), expanded);
      return {
        type: "filesystem",
        path: absPath,
        directories: ds.directories,
        exclude: ds.exclude,
        namespace: ds.namespace,
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
      hydrationStrategy: ds.hydrationStrategy,
      namespace: ds.namespace,
    };
  }

  // 4. Default: filesystem at {repoDir}/.swamp/
  const defaultPath = repoDir ? join(repoDir, ".swamp") : ".swamp";
  return { type: "filesystem", path: defaultPath };
}
