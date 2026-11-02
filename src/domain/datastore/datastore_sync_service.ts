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

import type { ControlPlaneStore } from "./control_plane_store.ts";
import { UserError } from "../errors.ts";
import { markModelWording, wordedText } from "../behavior_wording.ts";

export interface SyncContext {
  models?: ReadonlyArray<{ modelType: string; modelId: string }>;
}

export interface PushPreviewSummary {
  total: number;
  new: number;
  changed: number;
  deleted: number;
}

export interface SyncCapabilities {
  scopedSync?: boolean;
  lazyHydration?: boolean;
  /**
   * scopes the index walk and upload to {namespace}/; extensions without it
   * still receive the namespace field but should ignore it and sync everything
   * (solo-mode behavior)
   */
  namespacedSync?: boolean;
  /**
   * core splits the push so expensive file I/O runs outside the global lock,
   * narrowing it to the index merge; extensions without it use pushChanged
   * under the global lock
   */
  twoPhaseSync?: boolean;
  /**
   * a dry-run that returns file counts without uploading anything; core uses it
   * to gate sync --push behind a confirmation prompt
   */
  previewPush?: boolean;
  /**
   * direct access to small control-plane records that bypass the sync index and
   * cache pipeline, for coordination state in HA deployments
   */
  controlPlane?: boolean;
  /**
   * restricts a pull to a subset of subdirectories so the ConfigPoller
   * refreshes managed configuration without pulling the entire datastore
   */
  configRefresh?: boolean;
}

/**
 * core treats the manifest as passthrough and never inspects or validates its
 * contents; the extension defines what goes inside
 */
export type PushManifest = { readonly __brand: unique symbol };

export interface DatastoreSyncOptions {
  /**
   * extensions that honor it abort in-flight work and reject with an
   * AbortError; ones that ignore it stay correct, since core enforces a hard
   * deadline via Promise.race in the coordinator
   */
  signal?: AbortSignal;
  /**
   * omitted when core cannot attribute the change to one path; services
   * tracking per-path dirty state should then fall back to a full walk.
   * Forward-slash-normalized, so convert to native separators on Windows
   */
  relPath?: string;
  context?: SyncContext;
  /**
   * orthogonal to context: namespace scopes which subtree to sync, context
   * scopes which models within it; undefined or empty syncs everything (solo
   * mode)
   */
  namespace?: string;
  /**
   * set on the initial hydration pull when hydrationStrategy is lazy, not on
   * later scoped pulls; extensions without lazyHydration can safely ignore it
   */
  metadataOnly?: boolean;
  /**
   * extensions that do not advertise configRefresh can safely ignore it and
   * pull everything
   */
  subdirs?: readonly string[];
}

export interface DatastoreSyncService {
  /**
   * must not retain downloaded bodies (serve keeps one sync service for the
   * process); resolve to files written or removed, 0 only when the cache is
   * unchanged, since core then skips catalog invalidation
   */
  pullChanged(options?: DatastoreSyncOptions): Promise<number | void>;
  /**
   * resolve to files uploaded or deleted; 0 only when nothing was sent, as core
   * then treats a needed change (the managed lockfile) as unpublished and
   * retries; void when the count is unknown
   */
  pushChanged(options?: DatastoreSyncOptions): Promise<number | void>;
  capabilities?(): SyncCapabilities;
  /**
   * called before and after each cache write; an absent file means delete, no
   * relPath means bulk (full walk) and overrides per-path marks, and a restart
   * loses an in-memory set so the first push walks fully
   */
  markDirty(options?: DatastoreSyncOptions): Promise<void>;

  /**
   * drops marks for changes core undid after a refused push: exact keys only,
   * only marks made before the call, bulk and overflow stay, nothing remote is
   * touched, idempotent
   */
  clearDirty?(relPaths: readonly string[]): Promise<void>;

  /**
   * true if downloaded, false if absent remotely; must write atomically (temp
   * path, then rename) to avoid partial reads; core raises
   * HydrateContractViolationError if the file is missing after true
   */
  hydrateFile?(
    relPath: string,
    options?: DatastoreSyncOptions,
  ): Promise<boolean>;

  /**
   * reads the remote's bytes without touching the cache; null only when the
   * file is missing, any other failure rejects; rejects absolute or .. paths;
   * must not retain bytes, meant for small files
   */
  fetchContent?(
    relPath: string,
    options?: DatastoreSyncOptions,
  ): Promise<Uint8Array | null>;

  /** called after pushChanged so the export reflects the latest state */
  exportCatalog?(namespace: string): Promise<void>;

  /** missing exports (a namespace with no data yet) are silently skipped */
  pullForeignCatalogs?(
    namespaces: readonly string[],
  ): Promise<CatalogExportEntry[]>;

  /**
   * fetched content is ephemeral: not persisted locally, cached only for the
   * current command
   */
  fetchForeignContent?(
    namespace: string,
    relPath: string,
  ): Promise<Uint8Array | null>;

  /**
   * compute the diff between local cache and remote index and return counts;
   * upload and mutate nothing; honor the namespace option. Extensions
   * advertising previewPush must implement it
   */
  previewPush?(options?: DatastoreSyncOptions): Promise<PushPreviewSummary>;

  /**
   * runs outside the global lock; uploads files but must not update the remote
   * index or clear the dirty flag, so a failed commitPush leaves the next push
   * to retry
   */
  preparePush?(options?: DatastoreSyncOptions): Promise<PushManifest>;

  /**
   * runs under the global lock: reads the current remote index, not a cached
   * copy, merges manifest entries without replacing the index, and clears dirty
   * only after the index write succeeds
   */
  commitPush?(
    manifest: PushManifest,
    options?: DatastoreSyncOptions,
  ): Promise<number | void>;

  controlPlaneStore?(): ControlPlaneStore;

  repairNamespaceContamination?(
    options?: RepairNamespaceContaminationOptions,
  ): Promise<NamespaceContaminationSummary>;

  /**
   * create-only uploads, never an unconditional write; deletes nothing, never
   * marks dirty or advances the sync fingerprint; peer-deleted files are
   * recorded and never uploaded; shard index only
   */
  repairUnpushedFiles?(
    options?: RepairUnpushedFilesOptions,
  ): Promise<UnpushedFilesSummary>;

  /** idempotent; must be called under the global distributed lock */
  migrateMonolithToShards?(
    options?: DatastoreSyncOptions,
  ): Promise<MigrateIndexResult>;
}

export interface NamespaceContaminationSummary {
  foreignNamespaces: ReadonlyArray<{
    namespace: string;
    objectCount: number;
  }>;
  totalForeignObjects: number;
  deleted: number;
}

export interface RepairNamespaceContaminationOptions {
  signal?: AbortSignal;
  namespace?: string;
  dryRun?: boolean;
}

/**
 * The first releases of {@link UNPUSHED_REPAIR_EXTENSIONS} that implement
 * {@link DatastoreSyncService.repairUnpushedFiles}. Core checks for the method,
 * never this version; it only tells the user what to update to.
 */
export const UNPUSHED_REPAIR_MIN_EXTENSION_VERSION = "2026.10.30.1";

export const UNPUSHED_REPAIR_EXTENSIONS: readonly string[] = [
  "@swamp/s3-datastore",
  "@swamp/gcs-datastore",
];

export interface RepairUnpushedFilesOptions {
  signal?: AbortSignal;
  namespace?: string;
  dryRun?: boolean;
  exact?: boolean;
}

export interface UnpushedFilesSummary {
  unpushed: number;
  samplePaths: readonly string[];
  alreadyPresent: number;
  sampleAlreadyPresent: readonly string[];
  locallyModified: number;
  sampleModified: readonly string[];
  unknown: number;
  sampleUnknown: readonly string[];
  /**
   * Local files whose key a peer deleted after this cache synced it, which
   * the cache kept and recorded as peer-deleted. Never uploaded.
   */
  peerDeleted: number;
  samplePeerDeleted: readonly string[];
  remoteMovedOn: number;
  uploaded: number;
  pendingChanges: boolean;
}

export interface MigrateIndexResult {
  version: number;
  partitions: string[];
  commitSeq: number;
}

export interface CatalogExportEntry {
  namespace: string;
  rows: readonly CatalogExportRow[];
}

export interface CatalogExportRow {
  namespace: string;
  type_normalized: string;
  model_id: string;
  data_name: string;
  id: string;
  version: number;
  is_latest: number;
  /** absent in older exports, whose is_latest has this meaning instead */
  is_step_latest?: number;
  model_name: string;
  spec_name: string;
  data_type: string;
  content_type: string;
  lifetime: string;
  /** absent in older exports; read as unknown */
  garbage_collection?: string;
  /** absent in older exports; read as unknown */
  lifecycle?: string;
  owner_type: string;
  streaming: number;
  size: number;
  created_at: string;
  tags: string;
  owner_ref: string;
  workflow_run_id: string;
  workflow_name: string;
  job_name: string;
  step_name: string;
  source: string;
}

export type SyncDirection = "push" | "pull";

export type MarkDirtyHook = (relPath?: string) => Promise<void>;

export type HydrateFileHook = (
  absPath: string,
  options?: { signal?: AbortSignal },
) => Promise<boolean>;

/**
 * consulted only after a read found no file; the repository throws the returned
 * error so the read fails loudly instead of reading as absent
 */
export type UnreadableContentLookup =
  & ((absPath: string) => Promise<UserError | undefined>)
  & {
    readonly under?: (
      absDir: string,
    ) => Promise<readonly UnreadableContentEntry[]>;
  };

export interface UnreadableContentEntry {
  readonly path: string;
  readonly error: UserError;
  readonly advice: string;
}

export class SyncTimeoutError extends UserError {
  readonly label: string;
  readonly direction: SyncDirection;
  readonly timeoutMs: number;
  override readonly cause?: unknown;

  constructor(
    label: string,
    direction: SyncDirection,
    timeoutMs: number,
    options?: { cause?: unknown },
  ) {
    const msg = `Datastore ${direction} to "${label}" timed out after ` +
      `${timeoutMs}ms. Try one of:\n` +
      `  • Set SWAMP_DATASTORE_SYNC_TIMEOUT_MS for the duration of your ` +
      `shell session — applies to every command that triggers sync, ` +
      `including the implicit pull/push around write commands.\n` +
      `  • Rerun with --timeout <seconds> (e.g. --timeout 1800 for large ` +
      `one-off syncs). Available on 'swamp datastore sync' and ` +
      `'swamp datastore setup extension'.\n` +
      `  • If you are on @swamp/s3-datastore or @swamp/gcs-datastore at ` +
      `scale, update to the latest extension — the fingerprint fast path ` +
      `short-circuits zero-diff syncs.\n` +
      `  • If a prior process crashed without releasing the lock, run ` +
      `'swamp datastore lock release --force' (add --behavior <type>/<id> ` +
      `for a specific behavior lock).`;
    super(msg);
    this.name = "SyncTimeoutError";
    this.label = label;
    this.direction = direction;
    this.timeoutMs = timeoutMs;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export class HydrateContractViolationError extends UserError {
  readonly datastoreType: string;
  readonly relPath: string;
  readonly absPath: string;

  constructor(datastoreType: string, relPath: string, absPath: string) {
    super(
      `Datastore ${datastoreType} reported hydrateFile success for ` +
        `${relPath} but no file exists at ${absPath}. This is a bug in the ` +
        `datastore extension: hydrateFile must write the file at the ` +
        `cache-relative path it was given.`,
      "datastore_hydrate_contract_violation",
    );
    this.name = "HydrateContractViolationError";
    this.datastoreType = datastoreType;
    this.relPath = relPath;
    this.absPath = absPath;
  }
}

export interface WrittenVersion {
  readonly modelType: string;
  readonly modelId: string;
  readonly dataName: string;
  readonly version: number;
  /**
   * unique to that write; lets a publish lock tell its own version from another
   * clone's version of the same number
   */
  readonly dataId?: string;
}

export class UnpublishedDataVersionError extends UserError {
  readonly versions: readonly WrittenVersion[];

  constructor(versions: readonly WrittenVersion[], attempts: number) {
    const names = versions.map((v) =>
      `${v.modelType}/${v.modelId} ${v.dataName} version ${v.version}`
    ).join(", ");
    super(
      `The datastore does not hold ${names} after ${attempts} push ` +
        `attempts: another swamp process using this repository (a ` +
        `workflow run or swamp serve) may have synced over the last push, ` +
        `or the datastore did not keep the uploaded files. The data is on ` +
        `this host only; run the step or method again once that process ` +
        `has finished, to write and publish it.`,
      "datastore_unpublished_data_version",
    );
    this.name = "UnpublishedDataVersionError";
    this.versions = versions;
  }
}

export interface LostModelLock {
  readonly modelType: string;
  readonly modelId: string;
  readonly heldBy?: { readonly holder: string; readonly pid: number };
}

/**
 * thrown instead of a push when a model lock was lost: another run may have
 * written the same version, so nothing is pushed and the run's versions are
 * discarded from this cache
 */
export class ModelLockLostError extends UserError {
  readonly lost: readonly LostModelLock[];

  constructor(lost: readonly LostModelLock[]) {
    const names = lost.map((l) =>
      `${l.modelType}/${l.modelId} (${
        l.heldBy
          ? `now held by ${l.heldBy.holder}, pid ${l.heldBy.pid}`
          : "now released"
      })`
    ).join(", ");
    const worded = wordedText((w) =>
      `This run lost its lock on ${names} before pushing: the lock was ` +
      `force-released or taken over by another process, which may have ` +
      `written the same data version.\nNothing was pushed: this run's data ` +
      `was discarded from this host, and the ${w.noun}'s data is refreshed ` +
      `from the datastore when it can be reached. Run the method or ` +
      `workflow again.`
    );
    super(worded.text, "model_lock_lost");
    markModelWording(this, worded.modelText);
    this.name = "ModelLockLostError";
    this.lost = lost;
  }
}

export class DataVersionConflictError extends UserError {
  readonly versions: readonly WrittenVersion[];
  readonly publishFailure: unknown;

  constructor(
    versions: readonly WrittenVersion[],
    options: { publishFailure?: unknown } = {},
  ) {
    const names = versions.map((v) =>
      `${v.modelType}/${v.modelId} ${v.dataName} version ${v.version}`
    ).join(", ");
    const failure = options.publishFailure === undefined
      ? ""
      : ` Publishing the run's other data failed too: ${
        options.publishFailure instanceof Error
          ? options.publishFailure.message
          : String(options.publishFailure)
      }`;
    super(
      `Another swamp process, most likely another clone of this ` +
        `repository, wrote ${names} while this run was running, so this ` +
        `run's data with the same version was not published: this host ` +
        `now holds the datastore's copy. Run the method again to write and ` +
        `publish it.${failure}`,
      "datastore_data_version_conflict",
    );
    this.name = "DataVersionConflictError";
    this.versions = versions;
    this.publishFailure = options.publishFailure;
  }
}

export function isUnpublishedDataError(
  error: unknown,
): error is
  | UnpublishedDataVersionError
  | ModelLockLostError
  | DataVersionConflictError {
  return error instanceof UnpublishedDataVersionError ||
    error instanceof ModelLockLostError ||
    error instanceof DataVersionConflictError;
}
