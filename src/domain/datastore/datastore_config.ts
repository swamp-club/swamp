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
 * Datastore configuration types for configurable runtime data storage.
 *
 * The datastore determines where runtime data (versioned model data,
 * workflow runs, outputs, audit logs, etc.) is stored. Model definitions,
 * workflow definitions, and vault configs always stay in the local
 * `.swamp/` directory.
 */

/**
 * Subdirectories that always remain in local `.swamp/` regardless of
 * datastore configuration.
 *
 * Note: definitions, workflows, and vault configs now live in top-level
 * directories (models/, workflows/, vaults/) and are no longer .swamp/ subdirs.
 */
export const ALWAYS_LOCAL_SUBDIRS = [] as const;

/**
 * Default subdirectories that belong to the datastore tier.
 * These contain derived/runtime data that can be stored externally.
 */
export const DEFAULT_DATASTORE_SUBDIRS = [
  "definitions-evaluated",
  "workflows-evaluated",
  "data",
  "outputs",
  "workflow-runs",
  "secrets",
  "bundles",
  "vault-bundles",
  "audit",
  "telemetry",
  "logs",
  "files",
] as const;

/**
 * Filesystem-based datastore configuration.
 * Data is stored at a specified filesystem path.
 */
export interface FilesystemDatastoreConfig {
  readonly type: "filesystem";
  /** Absolute path to the datastore directory */
  readonly path: string;
  /** Which subdirectories belong to the datastore (defaults to DEFAULT_DATASTORE_SUBDIRS) */
  readonly directories?: string[];
  /** Gitignore-style patterns to exclude files from the datastore */
  readonly exclude?: string[];
}

/**
 * Value object: S3 connection parameters.
 *
 * Centralizes the fields needed to connect to an S3-compatible object store
 * so that adding a new connection parameter requires updating only this type.
 */
export interface S3ConnectionConfig {
  /** S3 bucket name */
  readonly bucket: string;
  /** Key prefix within the bucket */
  readonly prefix?: string;
  /** AWS region */
  readonly region?: string;
  /** Custom S3-compatible endpoint URL (e.g., https://nyc3.digitaloceanspaces.com) */
  readonly endpoint?: string;
  /** Use path-style addressing (bucket in path, not subdomain). Default: false. */
  readonly forcePathStyle?: boolean;
}

/**
 * S3-based datastore configuration.
 * Data is cached locally and synced to S3.
 */
export interface S3DatastoreConfig extends S3ConnectionConfig {
  readonly type: "s3";
  /** Local cache directory path (defaults to ~/.swamp/repos/{repoId}/) */
  readonly cachePath: string;
  /** Which subdirectories belong to the datastore (defaults to DEFAULT_DATASTORE_SUBDIRS) */
  readonly directories?: string[];
  /** Gitignore-style patterns to exclude files from the datastore */
  readonly exclude?: string[];
}

/**
 * Custom datastore configuration for user-defined datastore types.
 * Resolved eagerly during config resolution via the DatastoreProvider.
 */
export interface CustomDatastoreConfig {
  readonly type: string; // anything other than "filesystem" | "s3"
  readonly config: Record<string, unknown>;
  readonly datastorePath: string;
  readonly cachePath?: string;
  readonly directories?: string[];
  readonly exclude?: string[];
}

/**
 * Discriminated union of all datastore configurations.
 */
export type DatastoreConfig =
  | FilesystemDatastoreConfig
  | S3DatastoreConfig
  | CustomDatastoreConfig;

/**
 * Type guard for CustomDatastoreConfig.
 */
export function isCustomDatastoreConfig(
  config: DatastoreConfig,
): config is CustomDatastoreConfig {
  return config.type !== "filesystem" && config.type !== "s3";
}

/**
 * Serializable datastore configuration for .swamp.yaml storage.
 */
export interface DatastoreConfigData {
  type: string;
  path?: string;
  bucket?: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  config?: Record<string, unknown>;
  directories?: string[];
  exclude?: string[];
}

/**
 * Returns the effective list of datastore subdirectories from config,
 * falling back to the defaults. Filters out any always-local subdirs.
 */
export function getDatastoreDirectories(
  config: DatastoreConfig,
): readonly string[] {
  const dirs = config.directories ?? [...DEFAULT_DATASTORE_SUBDIRS];
  const localSet = new Set<string>(ALWAYS_LOCAL_SUBDIRS);
  return dirs.filter((d) => !localSet.has(d));
}

/**
 * Checks whether a subdirectory name is always local (never goes to datastore).
 */
export function isAlwaysLocal(subdir: string): boolean {
  return (ALWAYS_LOCAL_SUBDIRS as readonly string[]).includes(subdir);
}
