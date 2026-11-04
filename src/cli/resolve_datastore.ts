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
 * priority: SWAMP_DATASTORE env > CLI --datastore > .swamp.yaml > default
 * (filesystem at {repoDir}/.swamp/). Legacy s3:bucket/prefix is remapped to the
 * @swamp/s3-datastore extension
 */

import { isAbsolute, join, resolve } from "@std/path";
import { dirHasFiles } from "../infrastructure/persistence/directory_merge.ts";
import { getLogger } from "@logtape/logtape";
import type { RepoMarkerData } from "../infrastructure/persistence/repo_marker_repository.ts";
import {
  type DatastoreConfig,
  DEFAULT_DATASTORE_SUBDIRS,
  durableField,
  isCustomDatastoreConfig,
  readDatastoreFormatKey,
} from "../domain/datastore/datastore_config.ts";
import { getSwampDataDir } from "../infrastructure/persistence/paths.ts";
import { DefaultDatastorePathResolver } from "../infrastructure/persistence/default_datastore_path_resolver.ts";
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
import { resolveFilesystemDatastoreConfig } from "../libswamp/datastores/resolve_filesystem.ts";

const logger = getLogger(["swamp", "datastore", "resolve"]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * YAML parses managedConfig: "${{ env.VAR }}" as a string. Resolved env-only,
 * since this value is the vault gate. Strict: only "true" and "1" map to true
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

export interface ResolveDatastoreOptions {
  /**
   * when false, never auto-resolve a missing datastore extension; only
   * installed ones are used. Defaults to true
   */
  autoResolve?: boolean;
  /**
   * serve writes the datastore, so an extension datastore's type is never
   * resolved or installed and no provider is built; given the namespace this
   * returns the checkout's local root standing for the provider's paths
   */
  serveUpstreamRoot?: (namespace: string | undefined) => string;
}

function autoResolverFor(options?: ResolveDatastoreOptions) {
  return options?.autoResolve === false ? null : getAutoResolver();
}

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

  const renamedTo = RENAMED_DATASTORE_TYPES[type];
  if (renamedTo) {
    logger.warn(
      `Datastore type '${type}' has been renamed to '${renamedTo}'. ` +
        `Update your SWAMP_DATASTORE env var to use the new name.`,
    );

    if (type === "s3") {
      const slashIdx = value.indexOf("/");
      const bucket = slashIdx === -1 ? value : value.slice(0, slashIdx);
      const prefix = slashIdx === -1 ? undefined : value.slice(slashIdx + 1);

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
          override: true,
        };
      }

      throw new UserError(
        `S3 datastore requires the @swamp/s3-datastore extension. ` +
          `Install it with: swamp extension pull @swamp/s3-datastore`,
      );
    }

    type = renamedTo;
  }

  await datastoreTypeRegistry.ensureLoaded();

  if (type.startsWith("@")) {
    await resolveDatastoreType(type, autoResolverFor(options));
  }

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
    // not persisted in the repo, so no `format` key says what it is
    override: true,
  };
}

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

  const envDatastore = Deno.env.get("SWAMP_DATASTORE");
  if (envDatastore) {
    return await parseDatastoreEnvVar(envDatastore, repoId, repoDir, options);
  }

  if (cliArg) {
    return await parseDatastoreEnvVar(cliArg, repoId, repoDir, options);
  }

  if (marker?.datastore) {
    const ds = marker.datastore;
    const dsType = ds.type;
    const format = readDatastoreFormatKey(dsType, ds.format);

    if (options?.serveUpstreamRoot !== undefined && dsType !== "filesystem") {
      const type = RENAMED_DATASTORE_TYPES[dsType] ?? dsType;
      const dsFields = await resolveDatastoreFields(ds, {
        repoDir: repoDir ?? Deno.cwd(),
        managedConfig: await resolveManagedConfig(
          ds.managedConfig,
          repoDir ?? Deno.cwd(),
        ),
      });
      const namespace = dsFields.namespace ?? ds.namespace;
      return {
        type,
        config: ds.config ?? {},
        datastorePath: options.serveUpstreamRoot(namespace),
        cachePath: join(getSwampDataDir(), "repos", repoId ?? "unknown"),
        directories: dsFields.directories ?? ds.directories,
        exclude: dsFields.exclude ?? ds.exclude,
        hydrationStrategy: dsFields.hydrationStrategy ?? ds.hydrationStrategy,
        namespace,
        ...(format === 3 ? { format: 3 as const } : {}),
      };
    }

    const renamedTo = RENAMED_DATASTORE_TYPES[dsType];
    if (renamedTo) {
      logger.warn(
        `Datastore type '${dsType}' has been renamed to '${renamedTo}'. ` +
          `Update your .swamp.yaml to use the new name.`,
      );

      await datastoreTypeRegistry.ensureLoaded();
      await resolveDatastoreType(renamedTo, autoResolverFor(options));

      await datastoreTypeRegistry.ensureTypeLoaded(renamedTo);
      const typeInfo = datastoreTypeRegistry.get(renamedTo);
      if (typeInfo?.createProvider) {
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
          ...durableField(ds),
          ...(format === 3 ? { format: 3 as const } : {}),
        };
      }

      throw new UserError(
        `S3 datastore requires the @swamp/s3-datastore extension. ` +
          `Install it with: swamp extension pull @swamp/s3-datastore`,
      );
    }

    if (dsType === "filesystem") {
      return await resolveFilesystemDatastoreConfig(ds, repoDir ?? Deno.cwd());
    }

    // without this the registry looks empty under lazy loading, so the
    // auto-resolver fires needlessly and writes progress JSON to stdout,
    // corrupting --json output
    await datastoreTypeRegistry.ensureLoaded();

    if (dsType.startsWith("@")) {
      await resolveDatastoreType(dsType, autoResolverFor(options));
    }

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
      ...durableField(ds),
      ...(format === 3 ? { format: 3 as const } : {}),
    };
  }

  const defaultPath = repoDir ? join(repoDir, ".swamp") : ".swamp";
  return { type: "filesystem", path: defaultPath };
}

/**
 * resolution is installed-only, so asking never installs an extension;
 * datastore setup uses it to tell whether the repo's `.swamp/config` is the
 * config tier
 */
export async function resolveConfigTierPath(
  repoDir: string,
  marker: RepoMarkerData,
): Promise<string | undefined> {
  try {
    const config = await resolveDatastoreConfig(marker, undefined, repoDir, {
      autoResolve: false,
    });
    return new DefaultDatastorePathResolver(repoDir, config).resolvePath(
      "config",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug`Could not resolve the current config tier: ${message}`;
    return undefined;
  }
}

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
