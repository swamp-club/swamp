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

import { join, resolve } from "@std/path";
import { UserError } from "../errors.ts";
import { MIGRATION_SENTINEL } from "./managed_config_migration.ts";

/**
 * security-sensitive or platform-specific derived artifacts that must not
 * traverse the datastore
 */
export const ALWAYS_LOCAL_SUBDIRS = [
  "secrets",
  "bundles",
  "vault-bundles",
  "report-bundles",
  "webhook-bundles",
  "audit-wal",
] as const;

export const DEFAULT_DATASTORE_SUBDIRS = [
  "auto-definitions",
  "definitions-evaluated",
  "workflows-evaluated",
  "config",
  "data",
  "outputs",
  "workflow-runs",
  "secrets",
  "bundles",
  "vault-bundles",
  "report-bundles",
  "audit",
  "telemetry",
  "logs",
  "files",
] as const;

/**
 * a v3 checkout materialises a namespace at .swamp/<namespace>/, so a namespace
 * may take none of these names; kept in the domain so namespace rules need no
 * infrastructure import, and guarded by a fitness test
 */
export const SWAMP_OWNED_DIR_NAMES: readonly string[] = [
  ...new Set<string>([
    ...DEFAULT_DATASTORE_SUBDIRS,
    ...ALWAYS_LOCAL_SUBDIRS,
    "definitions",
    "workflows",
    "vault",
    "inputs",
    "inputs-evaluated",
    "resources",
    "datastore-bundles",
    "pulled-extensions",
    "cache",
    "start",
    "pre-v3-records",
    // A file: a pending managedConfig lockfile publish.
    "managed-config-lockfile-unpublished",
    "repos",
    "deno",
    "deno-cache",
    "source",
    "log",
    "workspaces",
    "litestream",
  ]),
];

// bundles are rebuildable derived artifacts, and syncing them lets a stale
// remote copy shadow a fresh local one; datastore-bundles also loads before
// DatastorePathResolver exists

/**
 * per direction, not combined; deliberately generous so the upstream Deno TLS
 * panic hang is prevented while slow pushes still fit; provisional, tune down
 * once telemetry shows real slow-path times
 */
export const DEFAULT_SYNC_TIMEOUT_MS = 300_000;

export const SYNC_TIMEOUT_ENV_VAR = "SWAMP_DATASTORE_SYNC_TIMEOUT_MS";

/**
 * per-step locking gives each model method step a fresh budget; raise via
 * SWAMP_LOCK_TIMEOUT_MS under extreme concurrency
 */
export const DEFAULT_LOCK_TIMEOUT_MS = 60_000;

export const LOCK_TIMEOUT_ENV_VAR = "SWAMP_LOCK_TIMEOUT_MS";

export const DURABLE_WRITES_ENV_VAR = "SWAMP_DATASTORE_DURABLE";

export interface FilesystemDatastoreConfig {
  readonly type: "filesystem";
  readonly path: string;
  readonly directories?: string[];
  readonly exclude?: string[];
  readonly namespace?: string;
  /**
   * records the choice; the datastore's format marker decides which engine
   * opens it, and a config that disagrees with its marker is refused
   */
  readonly format?: 2 | 3;
  /**
   * whether data writes are synced to disk before they are published; absent
   * means off: writes are atomic but unsynced
   */
  readonly durable?: boolean;
}

export interface CustomDatastoreConfig {
  readonly type: string;
  readonly config: Record<string, unknown>;
  /**
   * 3 when setup created the datastore as v3, absent for v2; the datastore's
   * format marker decides the engine and a config that disagrees with it is
   * refused
   */
  readonly format?: 3;
  /**
   * true when the config came from SWAMP_DATASTORE or --datastore: nothing
   * persisted says its format, so the format guard never opens it as v2 while
   * its marker cannot be read
   */
  readonly override?: true;
  readonly datastorePath: string;
  readonly cachePath?: string;
  readonly directories?: string[];
  readonly exclude?: string[];
  readonly syncTimeoutMs?: number;
  /**
   * lazy downloads only metadata and hydrates content on first access, giving
   * full catalog visibility immediately while deferring the expensive content
   * download
   */
  readonly hydrationStrategy?: "full" | "lazy";
  readonly namespace?: string;
  /**
   * whether data writes to the local cache are synced to disk before they are
   * published; absent means off: writes are atomic but unsynced
   */
  readonly durable?: boolean;
}

export type DatastoreConfig =
  | FilesystemDatastoreConfig
  | CustomDatastoreConfig;

export function isCustomDatastoreConfig(
  config: DatastoreConfig,
): config is CustomDatastoreConfig {
  return config.type !== "filesystem";
}

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
  hydrationStrategy?: "full" | "lazy";
  namespace?: string;
  durable?: boolean;
  /**
   * 2 or 3 on a filesystem datastore, 3 only on an extension datastore (absent
   * means 2)
   */
  format?: number;
  /**
   * the datastore becomes the source of truth: instances hydrate from it on
   * startup and a ConfigPoller refreshes it; pulled extension sources stay in
   * the repo's .swamp/config/pulled-extensions
   */
  managedConfig?: boolean;
}

/** absent when the block does not set it; anything but a boolean is refused */
export function durableField(
  ds: { durable?: unknown },
): { durable?: boolean } {
  if (ds.durable === undefined) return {};
  if (typeof ds.durable !== "boolean") {
    throw new UserError(
      `Invalid 'durable' in the datastore block of .swamp.yaml: expected ` +
        `true or false, got ${JSON.stringify(ds.durable)}.`,
    );
  }
  return { durable: ds.durable };
}

/**
 * format 3 on an extension datastore needs a provider that can host v3, checked
 * where the provider is known; format 2 on an extension datastore is the
 * default and reads as no key
 */
export function readDatastoreFormatKey(
  type: string,
  value: unknown,
): 2 | 3 | undefined {
  if (value === undefined || value === null) return undefined;
  if (value !== 2 && value !== 3) {
    throw new UserError(
      `The datastore format must be 2 or 3, got ${JSON.stringify(value)}.`,
    );
  }
  if (type === "filesystem" || value === 3) return value;
  return undefined;
}

export function getDatastoreDirectories(
  config: DatastoreConfig,
): readonly string[] {
  const dirs = config.directories ?? [...DEFAULT_DATASTORE_SUBDIRS];
  const localSet = new Set<string>(ALWAYS_LOCAL_SUBDIRS);
  return dirs.filter((d) => !localSet.has(d));
}

export const CATALOG_FILE_NAMES: readonly string[] = [
  "_catalog.db",
  "_catalog.db-journal",
  "_catalog.db-wal",
  "_catalog.db-shm",
];

export function isCatalogFileName(name: string): boolean {
  return CATALOG_FILE_NAMES.includes(name);
}

/**
 * the catalog is a local index kept in the repo's own .swamp/data whatever the
 * datastore, so setup never copies it; a copy on a datastore path is a stale
 * leftover
 */
export const CATALOG_FILES: readonly string[] = CATALOG_FILE_NAMES.map(
  (name) => join("data", name),
);

/**
 * nothing writes these through the datastore, so they stay repo-local on v3 and
 * no commit may materialise into them, where a key could overwrite a checkout's
 * own audit trail
 */
export const REPO_LOCAL_STREAM_SUBDIRS = [
  "audit",
  "telemetry",
  "logs",
  "files",
] as const;

/**
 * records store the log path relative to the repository, so the log stays local
 * when its record moves
 */
export const RUN_LOG_SUBDIRS: readonly string[] = [
  "outputs",
  "workflow-runs",
];

export function isRepoLocalStreamSubdir(subdir: string): boolean {
  return (REPO_LOCAL_STREAM_SUBDIRS as readonly string[]).includes(subdir);
}

export function isRunLogFile(subdir: string, fileName: string): boolean {
  return RUN_LOG_SUBDIRS.includes(subdir) && fileName.endsWith(".log");
}

export function mayHoldRunLogs(subdir: string): boolean {
  return RUN_LOG_SUBDIRS.includes(subdir);
}

/**
 * undefined for an extension datastore and for a root that resolves lexically
 * to repoSwampDir; setup compares real paths before it acts on the result
 */
export function externalFilesystemDatastoreRoot(
  config: DatastoreConfig,
  repoSwampDir: string,
): string | undefined {
  if (isCustomDatastoreConfig(config)) return undefined;
  const root = config.namespace
    ? join(config.path, config.namespace)
    : config.path;
  return resolve(root) === resolve(repoSwampDir) ? undefined : root;
}

export function isAlwaysLocal(subdir: string): boolean {
  return (ALWAYS_LOCAL_SUBDIRS as readonly string[]).includes(subdir);
}

/**
 * these keys belong to the user and survive a re-run or backend switch; a new
 * key added to DatastoreConfigData is dropped by setup unless listed here
 */
export const SETUP_PRESERVED_DATASTORE_KEYS = [
  "managedConfig",
  "exclude",
  "durable",
] as const satisfies readonly (keyof DatastoreConfigData)[];

/**
 * every other key of the existing block, such as an old backend's path or
 * config, is dropped
 */
export function mergeSetupDatastoreBlock(
  existing: DatastoreConfigData | undefined,
  next: DatastoreConfigData,
): DatastoreConfigData {
  const merged: DatastoreConfigData = { ...next };
  if (!existing) return merged;
  for (const key of SETUP_PRESERVED_DATASTORE_KEYS) {
    if (merged[key] === undefined && existing[key] !== undefined) {
      (merged as unknown as Record<string, unknown>)[key] = existing[key];
    }
  }
  return merged;
}

/**
 * pulled extension sources stay in the repo's .swamp/config whatever the config
 * tier, so they never move with a datastore
 */
export const PULLED_EXTENSIONS_SUBDIR = "pulled-extensions";

/**
 * instance_local: managedConfig is on but the tier lives elsewhere, so
 * .swamp/config holds only this instance's pulled extension sources and
 * transitional lockfile, and never moves with a datastore
 */
export type InRepoConfigRole = "unmanaged" | "tier" | "instance_local";

/**
 * an undefined tier path means the datastore could not be resolved (only an
 * extension datastore can fail, and its tier is never in the repo), so it
 * classifies as instance_local
 */
export function classifyInRepoConfig(
  managedConfig: boolean,
  configTierPath: string | undefined,
  inRepoConfigPath: string,
): InRepoConfigRole {
  if (!managedConfig) return "unmanaged";
  if (
    configTierPath !== undefined &&
    resolve(configTierPath) === resolve(inRepoConfigPath)
  ) {
    return "tier";
  }
  return "instance_local";
}

export function inRepoConfigMigrationSkips(
  role: InRepoConfigRole,
): readonly string[] {
  switch (role) {
    case "unmanaged":
      return [];
    case "tier":
      return [join("config", PULLED_EXTENSIONS_SUBDIR)];
    case "instance_local":
      return ["config"];
  }
}

export interface ConfigTierConflict {
  path: string;
  differs: boolean;
}

export interface ConfigTierMerge {
  copySkips: string[];
  cleanupKeeps: string[];
  keptPaths: string[];
}

/**
 * the destination copy wins on every shared path; a differing local copy stays
 * for the user to reconcile; the migration sentinel always differs, so it is
 * never kept or reported
 */
export function planConfigTierMerge(
  conflicts: readonly ConfigTierConflict[],
): ConfigTierMerge {
  const merge: ConfigTierMerge = {
    copySkips: [],
    cleanupKeeps: [],
    keptPaths: [],
  };
  for (const conflict of conflicts) {
    const sourcePath = join("config", conflict.path);
    merge.copySkips.push(sourcePath);
    if (conflict.differs && conflict.path !== MIGRATION_SENTINEL) {
      merge.cleanupKeeps.push(sourcePath);
      merge.keptPaths.push(conflict.path);
    }
  }
  return merge;
}

/**
 * an overrideMs <= 0 is ignored; invalid env values are ignored with a silent
 * fallback to the default, so the coordinator does not crash on a bad env
 */
export function resolveSyncTimeoutMs(
  config: DatastoreConfig,
  overrideMs?: number,
): number {
  if (overrideMs != null && overrideMs > 0) return overrideMs;
  if (isCustomDatastoreConfig(config) && config.syncTimeoutMs != null) {
    if (config.syncTimeoutMs > 0) return config.syncTimeoutMs;
  }
  const envValue = Deno.env.get(SYNC_TIMEOUT_ENV_VAR);
  if (envValue) {
    const parsed = Number.parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_SYNC_TIMEOUT_MS;
}

/**
 * invalid env values (non-numeric, zero, negative) are ignored with a silent
 * fallback to the default
 */
export function resolveLockTimeoutMs(overrideMs?: number): number {
  if (overrideMs != null && overrideMs > 0) return overrideMs;
  const envValue = Deno.env.get(LOCK_TIMEOUT_ENV_VAR);
  if (envValue) {
    const parsed = Number.parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_LOCK_TIMEOUT_MS;
}

const DURABLE_ENV_TRUE = new Set(["1", "true", "yes", "on"]);
const DURABLE_ENV_FALSE = new Set(["0", "false", "no", "off"]);

/**
 * only a v2 local datastore, or the local cache of a v2 extension datastore,
 * syncs; durable is opt-in since each write then costs several fsyncs; an
 * unrecognised env value is ignored so writes stay unsynced
 */
export function resolveDurableWrites(config?: DatastoreConfig): boolean {
  if (config?.durable !== undefined) return config.durable;
  const envValue = Deno.env.get(DURABLE_WRITES_ENV_VAR)?.trim().toLowerCase();
  if (envValue !== undefined) {
    if (DURABLE_ENV_FALSE.has(envValue)) return false;
    if (DURABLE_ENV_TRUE.has(envValue)) return true;
  }
  return false;
}
