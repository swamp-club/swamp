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
import { dirHasFiles } from "../infrastructure/persistence/directory_merge.ts";
import { getLogger } from "@logtape/logtape";
import type { RepoMarkerData } from "../infrastructure/persistence/repo_marker_repository.ts";
import {
  type DatastoreConfig,
  DEFAULT_DATASTORE_SUBDIRS,
  isCustomDatastoreConfig,
} from "../domain/datastore/datastore_config.ts";
import { getSwampDataDir } from "../infrastructure/persistence/paths.ts";
import { expandEnvVars } from "../infrastructure/persistence/env_path.ts";
import { datastoreTypeRegistry } from "../domain/datastore/datastore_type_registry.ts";
import { UserError } from "../domain/errors.ts";
import { resolveDatastoreType } from "../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../domain/extensions/auto_resolver_context.ts";
import { RENAMED_DATASTORE_TYPES } from "../domain/datastore/renamed_datastore_types.ts";
import {
  type DatastoreExpressionContext,
  resolveDatastoreExpressions,
} from "./datastore_expression_resolver.ts";

const logger = getLogger(["swamp", "datastore", "resolve"]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Resolves `managedConfig` when it arrives as a string expression from YAML.
 * YAML parses `managedConfig: "${{ env.VAR }}"` as a string, not a boolean.
 * Resolves env-only (no vault gate needed since this value IS the vault gate).
 * Strict boolean parsing: only "true" and "1" map to true.
 */
async function resolveManagedConfig(
  raw: boolean | string | undefined,
  repoDir: string,
): Promise<boolean | undefined> {
  if (raw === undefined || typeof raw === "boolean") return raw;
  const resolved = await resolveDatastoreExpressions(
    { v: raw },
    { repoDir },
  );
  const str = String(resolved.v).toLowerCase();
  return str === "true" || str === "1";
}

interface ResolvedDatastoreFields {
  namespace?: string;
  directories?: string[];
  exclude?: string[];
  hydrationStrategy?: "full" | "lazy";
}

/**
 * Resolves expressions in datastore-level fields that sit outside `config`.
 */
async function resolveDatastoreFields(
  ds: {
    namespace?: string;
    directories?: string[];
    exclude?: string[];
    hydrationStrategy?: "full" | "lazy";
  },
  ctx: DatastoreExpressionContext,
): Promise<ResolvedDatastoreFields> {
  const toResolve: Record<string, unknown> = {};
  if (ds.namespace != null) toResolve.namespace = ds.namespace;
  if (ds.directories != null) toResolve.directories = ds.directories;
  if (ds.exclude != null) toResolve.exclude = ds.exclude;
  if (ds.hydrationStrategy != null) {
    toResolve.hydrationStrategy = ds.hydrationStrategy;
  }

  if (Object.keys(toResolve).length === 0) return {};

  const resolved = await resolveDatastoreExpressions(toResolve, ctx);
  return resolved as ResolvedDatastoreFields;
}

export function datastoreBasePath(config: DatastoreConfig): string {
  return isCustomDatastoreConfig(config) ? config.datastorePath : config.path;
}

export { RENAMED_DATASTORE_TYPES };

/** Options for resolving a datastore config. */
export interface ResolveDatastoreOptions {
  /**
   * When false, never auto-resolve a missing datastore extension: only
   * already-installed extensions are used. Defaults to true.
   */
  autoResolve?: boolean;
}

function autoResolverFor(options?: ResolveDatastoreOptions) {
  return options?.autoResolve === false ? null : getAutoResolver();
}

/**
 * Parses the SWAMP_DATASTORE env var format into a DatastoreConfig.
 *
 * @param envValue - The env var value (e.g., "filesystem:/path" or "s3:bucket/prefix")
 * @param repoId - The repo ID for S3 cache path
 * @param repoDir - The repository root directory (for custom datastore path resolution)
 * @param options - Resolution options (e.g. installed-only)
 * @returns Parsed DatastoreConfig
 */
export async function parseDatastoreEnvVar(
  envValue: string,
  repoId?: string,
  repoDir?: string,
  options?: ResolveDatastoreOptions,
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
      await resolveDatastoreType(renamedTo, autoResolverFor(options));

      await datastoreTypeRegistry.ensureTypeLoaded(renamedTo);
      const typeInfo = datastoreTypeRegistry.get(renamedTo);
      if (typeInfo?.createProvider) {
        let config: Record<string, unknown> = { bucket };
        if (prefix) config.prefix = prefix;

        const envCtx = { repoDir: repoDir ?? Deno.cwd() };
        config = await resolveDatastoreExpressions(config, envCtx);

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
    await resolveDatastoreType(type, autoResolverFor(options));
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

  const envCtx = { repoDir: repoDir ?? Deno.cwd() };
  config = await resolveDatastoreExpressions(config, envCtx);

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
 * @param options - Resolution options (e.g. installed-only)
 * @returns Resolved DatastoreConfig
 */
export async function resolveDatastoreConfig(
  marker: RepoMarkerData | null,
  cliArg?: string,
  repoDir?: string,
  options?: ResolveDatastoreOptions,
): Promise<DatastoreConfig> {
  let repoId = marker?.repoId;

  if (repoId) {
    const resolved = await resolveDatastoreExpressions(
      { v: repoId },
      { repoDir: repoDir ?? Deno.cwd() },
    );
    const resolvedRepoId = String(resolved.v);
    if (resolvedRepoId !== repoId && !UUID_PATTERN.test(resolvedRepoId)) {
      throw new UserError(
        `repoId must be a valid UUID, got "${resolvedRepoId}"`,
      );
    }
    repoId = resolvedRepoId;
  }

  // 1. Environment variable takes highest priority
  const envDatastore = Deno.env.get("SWAMP_DATASTORE");
  if (envDatastore) {
    return await parseDatastoreEnvVar(envDatastore, repoId, repoDir, options);
  }

  // 2. CLI argument
  if (cliArg) {
    return await parseDatastoreEnvVar(cliArg, repoId, repoDir, options);
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
      await resolveDatastoreType(renamedTo, autoResolverFor(options));

      await datastoreTypeRegistry.ensureTypeLoaded(renamedTo);
      const typeInfo = datastoreTypeRegistry.get(renamedTo);
      if (typeInfo?.createProvider) {
        // Build config from the S3-specific YAML fields
        let config: Record<string, unknown> = {};
        if (ds.bucket) config.bucket = ds.bucket;
        if (ds.prefix) config.prefix = ds.prefix;
        if (ds.region) config.region = ds.region;
        if (ds.endpoint) config.endpoint = ds.endpoint;
        if (ds.forcePathStyle != null) {
          config.forcePathStyle = ds.forcePathStyle;
        }

        const resolvedManagedConfig = await resolveManagedConfig(
          ds.managedConfig,
          repoDir ?? Deno.cwd(),
        );
        const exprCtx: DatastoreExpressionContext = {
          repoDir: repoDir ?? Deno.cwd(),
          managedConfig: resolvedManagedConfig,
        };
        config = await resolveDatastoreExpressions(config, exprCtx);
        const dsFields = await resolveDatastoreFields(ds, exprCtx);

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
          directories: dsFields.directories ?? ds.directories,
          exclude: dsFields.exclude ?? ds.exclude,
          hydrationStrategy: dsFields.hydrationStrategy ?? ds.hydrationStrategy,
          namespace: dsFields.namespace ?? ds.namespace,
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
      const fsExprCtx: DatastoreExpressionContext = {
        repoDir: repoDir ?? Deno.cwd(),
      };
      const fsFields = await resolveDatastoreFields(ds, fsExprCtx);
      return {
        type: "filesystem",
        path: absPath,
        directories: fsFields.directories ?? ds.directories,
        exclude: fsFields.exclude ?? ds.exclude,
        namespace: fsFields.namespace ?? ds.namespace,
      };
    }

    // Ensure lazy-loaded extension datastores are loaded before checking
    // the registry. Without this, the registry appears empty after PR #1050's
    // lazy loading change, causing the auto-resolver to fire unnecessarily
    // and write progress JSON to stdout — corrupting --json output.
    await datastoreTypeRegistry.ensureLoaded();

    // Auto-resolve extension types (only fires if type is genuinely missing)
    if (dsType.startsWith("@")) {
      await resolveDatastoreType(dsType, autoResolverFor(options));
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

    let customConfig = ds.config ?? {};

    const resolvedManagedConfig = await resolveManagedConfig(
      ds.managedConfig,
      repoDir ?? Deno.cwd(),
    );
    const exprCtx: DatastoreExpressionContext = {
      repoDir: repoDir ?? Deno.cwd(),
      managedConfig: resolvedManagedConfig,
    };
    customConfig = await resolveDatastoreExpressions(customConfig, exprCtx);
    const dsFields = await resolveDatastoreFields(ds, exprCtx);

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
      directories: dsFields.directories ?? ds.directories,
      exclude: dsFields.exclude ?? ds.exclude,
      hydrationStrategy: dsFields.hydrationStrategy ?? ds.hydrationStrategy,
      namespace: dsFields.namespace ?? ds.namespace,
    };
  }

  // 4. Default: filesystem at {repoDir}/.swamp/
  const defaultPath = repoDir ? join(repoDir, ".swamp") : ".swamp";
  return { type: "filesystem", path: defaultPath };
}

/**
 * Checks whether a datastore with a namespace has un-migrated root-level data.
 * Returns the list of root-level directories found, or empty if no issue.
 */
export async function checkUnmigratedNamespaceData(
  config: DatastoreConfig,
): Promise<string[]> {
  if (!config.namespace) return [];
  const basePath = isCustomDatastoreConfig(config) && config.cachePath
    ? config.cachePath
    : isCustomDatastoreConfig(config)
    ? config.datastorePath
    : config.path;
  const found: string[] = [];
  for (const subdir of DEFAULT_DATASTORE_SUBDIRS) {
    try {
      const stat = await Deno.stat(join(basePath, subdir));
      if (stat.isDirectory && await dirHasFiles(join(basePath, subdir))) {
        found.push(subdir);
      }
    } catch {
      // Not found — expected when migrated
    }
  }
  return found;
}
