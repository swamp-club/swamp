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
 *   - `SWAMP_DATASTORE=s3:bucket-name/prefix`
 *
 * Default: filesystem datastore at `{repoDir}/.swamp/` (full backward compatibility)
 */

import { join } from "@std/path";
import type { RepoMarkerData } from "../infrastructure/persistence/repo_marker_repository.ts";
import type { DatastoreConfig } from "../domain/datastore/datastore_config.ts";
import { getSwampDataDir } from "../infrastructure/persistence/paths.ts";
import { datastoreTypeRegistry } from "../domain/datastore/datastore_type_registry.ts";
import { UserError } from "../domain/errors.ts";

/** S3 bucket naming rules: 3-63 chars, lowercase alphanumeric, hyphens, dots. */
const S3_BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]$/;

function validateBucketName(bucket: string): void {
  if (!S3_BUCKET_NAME_RE.test(bucket)) {
    throw new Error(
      `Invalid S3 bucket name: "${bucket}". ` +
        `Bucket names must be 3-63 characters, lowercase, and contain only letters, numbers, hyphens, and dots.`,
    );
  }
}

/**
 * Parses the SWAMP_DATASTORE env var format into a DatastoreConfig.
 *
 * @param envValue - The env var value (e.g., "filesystem:/path" or "s3:bucket/prefix")
 * @param repoId - The repo ID for S3 cache path
 * @param repoDir - The repository root directory (for custom datastore path resolution)
 * @returns Parsed DatastoreConfig
 */
export function parseDatastoreEnvVar(
  envValue: string,
  repoId?: string,
  repoDir?: string,
): DatastoreConfig {
  const colonIdx = envValue.indexOf(":");
  if (colonIdx === -1) {
    throw new Error(
      `Invalid SWAMP_DATASTORE format: "${envValue}". ` +
        `Expected "filesystem:/path/to/dir" or "s3:bucket-name/prefix".`,
    );
  }

  const type = envValue.slice(0, colonIdx);
  const value = envValue.slice(colonIdx + 1);

  if (type === "filesystem") {
    return { type: "filesystem", path: value };
  }

  if (type === "s3") {
    const slashIdx = value.indexOf("/");
    const bucket = slashIdx === -1 ? value : value.slice(0, slashIdx);
    validateBucketName(bucket);
    const prefix = slashIdx === -1 ? undefined : value.slice(slashIdx + 1);
    const cachePath = join(
      getSwampDataDir(),
      "repos",
      repoId ?? "unknown",
    );
    return { type: "s3", bucket, prefix, cachePath };
  }

  // Custom datastore type: value is JSON config
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
        `Use the built-in format (e.g., "filesystem:/path" or "s3:bucket/prefix").`,
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
  const cachePath = provider.resolveCachePath?.(resolvedRepoDir);

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
export function resolveDatastoreConfig(
  marker: RepoMarkerData | null,
  cliArg?: string,
  repoDir?: string,
): DatastoreConfig {
  const repoId = marker?.repoId;

  // 1. Environment variable takes highest priority
  const envDatastore = Deno.env.get("SWAMP_DATASTORE");
  if (envDatastore) {
    return parseDatastoreEnvVar(envDatastore, repoId, repoDir);
  }

  // 2. CLI argument
  if (cliArg) {
    return parseDatastoreEnvVar(cliArg, repoId, repoDir);
  }

  // 3. .swamp.yaml datastore config
  if (marker?.datastore) {
    const ds = marker.datastore;
    if (ds.type === "s3") {
      if (!ds.bucket) {
        throw new Error(
          "S3 datastore config in .swamp.yaml requires a 'bucket' field.",
        );
      }
      validateBucketName(ds.bucket);
      const cachePath = join(
        getSwampDataDir(),
        "repos",
        repoId ?? "unknown",
      );
      return {
        type: "s3",
        bucket: ds.bucket,
        prefix: ds.prefix,
        region: ds.region,
        cachePath,
        directories: ds.directories,
        exclude: ds.exclude,
      };
    }

    if (ds.type === "filesystem") {
      if (!ds.path) {
        throw new Error(
          "Filesystem datastore config in .swamp.yaml requires a 'path' field.",
        );
      }
      return {
        type: "filesystem",
        path: ds.path,
        directories: ds.directories,
        exclude: ds.exclude,
      };
    }

    // Custom datastore type from YAML config
    const typeInfo = datastoreTypeRegistry.get(ds.type);
    if (!typeInfo) {
      const available = datastoreTypeRegistry.getAll().map((t) => t.type).join(
        ", ",
      );
      throw new UserError(
        `Unknown datastore type "${ds.type}" in .swamp.yaml. Available types: ${available}`,
      );
    }
    if (!typeInfo.createProvider) {
      throw new UserError(
        `Datastore type "${ds.type}" is registered but has no provider.`,
      );
    }

    const customConfig = ds.config ?? {};

    if (typeInfo.configSchema) {
      const result = typeInfo.configSchema.safeParse(customConfig);
      if (!result.success) {
        throw new UserError(
          `Invalid config for datastore type "${ds.type}": ${result.error.message}`,
        );
      }
    }

    const provider = typeInfo.createProvider(customConfig);
    const datastorePath = provider.resolveDatastorePath(repoDir ?? ".");
    const cachePath = provider.resolveCachePath?.(repoDir ?? ".");

    return {
      type: ds.type,
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
