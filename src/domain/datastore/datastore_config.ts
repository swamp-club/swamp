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
export const ALWAYS_LOCAL_SUBDIRS = ["secrets"] as const;

/**
 * Default subdirectories that belong to the datastore tier.
 * These contain derived/runtime data that can be stored externally.
 */
export const DEFAULT_DATASTORE_SUBDIRS = [
  "auto-definitions",
  "definitions-evaluated",
  "workflows-evaluated",
  "data",
  "outputs",
  "workflow-runs",
  "secrets",
  "bundles",
  "vault-bundles",
  "driver-bundles",
  "report-bundles",
  "audit",
  "telemetry",
  "logs",
  "files",
] as const;

// Note: "datastore-bundles" is intentionally excluded from the datastore tier.
// The datastore loader runs during bootstrap BEFORE the DatastorePathResolver
// exists, so datastore extension bundles must always remain in local .swamp/.
// Including it here causes the setup migration to delete .swamp/datastore-bundles/
// after copying to cache, breaking subsequent extension loading.

/**
 * Default timeout (milliseconds) for a single direction of datastore sync.
 *
 * Each direction (push and pull) is bounded independently by this value —
 * it is not a combined sync budget. The default is deliberately generous
 * (5 minutes): the failure mode this bound was introduced for (see #157) is
 * an ~8.5 minute hang, so 5 minutes prevents the upstream Deno TLS panic
 * with ample margin while still covering legitimate slow-path pushes on
 * large datastores over slow networks. This default is PROVISIONAL — tune
 * down once production telemetry shows a realistic slow-path distribution.
 */
export const DEFAULT_SYNC_TIMEOUT_MS = 300_000;

/** Env var that overrides `DEFAULT_SYNC_TIMEOUT_MS` at runtime. */
export const SYNC_TIMEOUT_ENV_VAR = "SWAMP_DATASTORE_SYNC_TIMEOUT_MS";

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
  /** Namespace for giga-swamp multi-repo shared datastores */
  readonly namespace?: string;
}

/**
 * Custom datastore configuration for user-defined datastore types.
 * Resolved eagerly during config resolution via the DatastoreProvider.
 */
export interface CustomDatastoreConfig {
  readonly type: string; // anything other than "filesystem"
  readonly config: Record<string, unknown>;
  readonly datastorePath: string;
  readonly cachePath?: string;
  readonly directories?: string[];
  readonly exclude?: string[];
  /**
   * Timeout (milliseconds) for a single direction of sync (push or pull).
   * Each direction is bounded independently — this is not a combined
   * budget. Defaults to `DEFAULT_SYNC_TIMEOUT_MS` (5 minutes), overridable
   * via the `SWAMP_DATASTORE_SYNC_TIMEOUT_MS` env var. See
   * `resolveSyncTimeoutMs`.
   */
  readonly syncTimeoutMs?: number;
  /**
   * Controls how the initial pull populates the local cache.
   *
   * - `"full"` (default): download all files including content (`raw`).
   * - `"lazy"`: download only metadata (`metadata.yaml`, `latest` markers,
   *   partition indexes) and hydrate content on demand when first accessed.
   *
   * Lazy hydration gives full catalog visibility (`data list`, `data query`,
   * CEL expressions) immediately while deferring the expensive content
   * download until the data is actually needed.
   */
  readonly hydrationStrategy?: "full" | "lazy";
  /** Namespace for giga-swamp multi-repo shared datastores */
  readonly namespace?: string;
}

/**
 * Discriminated union of all datastore configurations.
 */
export type DatastoreConfig =
  | FilesystemDatastoreConfig
  | CustomDatastoreConfig;

/**
 * Type guard for CustomDatastoreConfig.
 */
export function isCustomDatastoreConfig(
  config: DatastoreConfig,
): config is CustomDatastoreConfig {
  return config.type !== "filesystem";
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
  hydrationStrategy?: "full" | "lazy";
  namespace?: string;
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

/**
 * Resolve the effective sync timeout for a datastore config.
 *
 * Resolution order:
 *   1. `overrideMs` (per-invocation override, e.g. from a CLI flag)
 *   2. `config.syncTimeoutMs` (explicit per-datastore config)
 *   3. `SWAMP_DATASTORE_SYNC_TIMEOUT_MS` env var (must parse as positive int)
 *   4. `DEFAULT_SYNC_TIMEOUT_MS` (5 minutes)
 *
 * `overrideMs` is intended for the `swamp datastore sync --timeout` flag,
 * which is validated at the CLI boundary (positive integer, capped). Any
 * value reaching here must already be `> 0` — an out-of-band `<= 0`
 * override is ignored and resolution falls through to the next source.
 *
 * Invalid env values (non-numeric, zero, negative) are ignored with a silent
 * fallback to the default — the coordinator does not crash on a bad env.
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
