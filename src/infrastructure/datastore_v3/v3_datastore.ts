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

import { DatabaseSync } from "node:sqlite";
import { ensureDirSync } from "@std/fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "@std/path";
import {
  CheckoutCopyAtRiskError,
  ReadModelApplyError,
  ReadModelApplyRefusedError,
  ReadModelCatchUpUnreachableError,
} from "../../domain/datastore_v3/read_model.ts";
import { isNetworkFailure } from "./network_failure.ts";
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
import {
  V3_SERVE_UNREACHABLE_CODE,
  V3_STORAGE_UNREACHABLE_CODE,
} from "../../domain/datastore_v3/writer_lease.ts";
import {
  restoreNamespace,
  SOLO_NAMESPACE,
} from "../../domain/data/namespace.ts";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type { UnitOfWork } from "../../domain/datastore/unit_of_work.ts";
import {
  DEFAULT_DATASTORE_SUBDIRS,
  getDatastoreDirectories,
  isAlwaysLocal,
} from "../../domain/datastore/datastore_config.ts";
import {
  DATASTORE_FORMAT_MARKER_FILE,
  DATASTORE_FORMAT_MARKER_MAX_BYTES,
  isBlankDatastoreFormatMarker,
  parseDatastoreFormatMarker,
  V3_DATASTORE_FORMAT,
} from "../../domain/datastore/datastore_format.ts";
import {
  compilePatterns,
  isExcludedCompiled,
} from "../../domain/datastore/datastore_pattern_matcher.ts";
import {
  type ChunkCollectionReport,
  ChunkCollector,
} from "../../domain/datastore_v3/chunk_collector.ts";
import { ChunkStore } from "../../domain/datastore_v3/chunk_store.ts";
import type { ConfigEditBases } from "../../domain/datastore_v3/config_edit_bases.ts";
import { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";
import { RecordKey } from "../../domain/datastore_v3/record_key.ts";
import {
  type CommitOutbox,
  COMPACTED_TXN_RETENTION_MS,
} from "../../domain/datastore_v3/commit_outbox.ts";
import type {
  CommitStore,
  CompactionReport,
} from "../../domain/datastore_v3/commit_store.ts";
import {
  compactionBound,
  compactionTarget,
  DEFAULT_COMPACTION_POLICY,
  retentionOf,
} from "../../domain/datastore_v3/compaction_policy.ts";
import type { CommitWriter } from "../../domain/datastore_v3/commit.ts";
import type { WorkflowRunRepository } from "../../domain/workflows/repositories.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import { V3CopySetupRacedError } from "../../domain/datastore_v3/copy_setup_raced_error.ts";
import { CatalogStore } from "../persistence/catalog_store.ts";
import { writeDatastoreFormatMarker } from "../persistence/datastore_format_marker_writer.ts";
import { FileSystemStorage } from "../persistence/fs_datastore_storage.ts";
import {
  serveAccessCheck,
  ServeCatchUp,
  serveLogCheck,
} from "./serve_catch_up.ts";
import { v3WriterFence } from "./v3_writer_lock.ts";
import {
  createServeCommitSink,
  type ServeUpstreamCommitStore,
} from "./serve_commit_sink.ts";
import type {
  CatchUpRequest,
  DeliveredCatchUp,
} from "./serve_datastore_client.ts";
import {
  CachedServeStorage,
  ServeChunkStorage,
} from "./serve_datastore_storage.ts";
import {
  ServeCommitRefusedError,
  ServeNeverReadError,
  ServeUnreachableError,
} from "./serve_upstream_errors.ts";
import {
  SERVE_UPSTREAM_STATE_FILE,
  ServeUpstreamState,
} from "./serve_upstream_state.ts";
import {
  noteServeInitiator,
  serveInitiatorAt,
  serveUpstreamAt,
} from "./serve_upstream_registry.ts";
import type { OfflineFlushPort } from "./offline_flush.ts";
import { createQuarantineDeposit } from "./quarantine_deposit.ts";
import { ModelChanges } from "../../domain/datastore_v3/repository_changes.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { DataMetadataSchema } from "../../domain/data/data_metadata.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import type { Commit } from "../../domain/datastore_v3/commit.ts";
import { CommitsCompactedError } from "../../domain/datastore_v3/commit_store.ts";
import {
  emitServeOfflineNotice,
  enterServeOffline,
  noteQueuedOffline,
  offlineContextAt,
  offlineRegisteredAt,
  serveClockOf,
  serveOfflineAt,
} from "./serve_offline.ts";
import {
  checkOfflineCommit,
  OfflineConfigEditError,
  OfflineLeaseRequiredError,
} from "../../domain/datastore_v3/offline_write_policy.ts";
import {
  dropUnconfirmedServeLease,
  heldServeLeaseOf,
  raiseServeLeaseFloor,
} from "./serve_lease_registry.ts";
import { raiseExplicitLeaseFloor } from "./explicit_model_leases.ts";
import { syncDirectory } from "../persistence/sync_directory.ts";
import { swampPath } from "../persistence/paths.ts";
import { dropRunIndexEntries } from "../persistence/workflow_run_index.ts";
import type {
  CommitLogEngine,
  CommitLogRootRunOptions,
  CommitLogRootView,
  OpenUnitCheckpoint,
} from "../persistence/repo_unit_of_work.ts";
import { currentUnitOfWork } from "../persistence/unit_of_work_scope.ts";
import {
  appendForwardedCommit,
  appendNowFrom,
  checkpointFrom,
  commitLogParentFor,
  commitLogRootFor,
  createCommitLogUnitOfWork,
  type ForwardedCommit,
  type UnitTracker,
} from "./commit_log_unit_of_work.ts";
import {
  AppendUnrecordedError,
  type CommitLogUnitOfWork,
  MayLandLaterError,
  PartitionsRefusedError,
  type TypedChange,
} from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { recoverySince } from "./interrupted_writer_recovery.ts";
import { runInCommitLogRoot, wasThrownAfterCommit } from "./commit_log_root.ts";
import {
  createOutboxCommitSink,
  type OutboxCommitSink,
} from "./outbox_commit_sink.ts";
import { SqliteCommitOutbox } from "./sqlite_commit_outbox.ts";
import {
  recoverCommitOutbox,
  registerOwnCommitWriter,
} from "./commit_outbox_recovery.ts";
import { localProcess } from "./process_identity.ts";
import { getSwampLogger } from "../logging/logger.ts";
import { commandStopSignal } from "../process/shutdown_handlers.ts";
import { recordLastChange } from "./record_last_change.ts";
import { readModelStateDir, v3CatalogPath } from "./record_path_guard.ts";
import { reconcileRefusedRuns } from "./refused_run_records.ts";
import {
  COMMIT_STORE_SCHEMA_VERSION,
  SqliteCommitStore,
} from "./sqlite_commit_store.ts";
import {
  NOT_RELEASED,
  READ_MODEL_STATE_FILE,
  type RecoveryEntry,
  SqliteReadModel,
} from "./sqlite_read_model.ts";
import { ReadModelState } from "./read_model_state.ts";
import { V3Catalog } from "./v3_catalog.ts";
import {
  litestreamStateDirName,
  replicationDirName,
} from "./litestream/replication_files.ts";
import type { DatastoreStorage } from "../../domain/datastore/datastore_storage.ts";
import {
  V3_LOCAL_COPIES_DIR,
  v3BucketBindingAt,
  v3ReplicaFor,
  v3ReplicatesAt,
} from "./v3_datastore_binding.ts";

export { V3_LOCAL_COPIES_DIR };

/**
 * a read-only command holds no writer lock, so a change it stages must not be
 * committed
 */
export class ReadOnlyV3WriteError extends Error {
  constructor(readonly key: string) {
    super(
      `A read-only command tried to change ${key} on a v3 datastore; it holds ` +
        "no writer lock, so the change was refused",
    );
    this.name = "ReadOnlyV3WriteError";
  }
}

/**
 * ask the outbox first: a writer appends to commits.db then settles its outbox
 * entry, so the reverse order could miss a commit that named the chunk
 * throughout
 */
export async function referencedChunksOf(
  commitStore: Pick<CommitStore, "referencedChunks">,
  outbox: Pick<CommitOutbox, "referencedChunks">,
  namespace: string,
  hashes: readonly string[],
): Promise<Set<string>> {
  const names = await outbox.referencedChunks(namespace, hashes);
  const rest = hashes.filter((hash) => !names.has(hash));
  for (
    const hash of await commitStore.referencedChunks(
      namespace,
      rest,
      NOT_RELEASED,
    )
  ) {
    names.add(hash);
  }
  return names;
}

export const COMMITS_DB_FILE = "commits.db";

export const COMMIT_OUTBOX_FILE = "commits-outbox.db";

export function v3OutboxPath(commitsDbPath: string): string {
  return join(dirname(commitsDbPath), COMMIT_OUTBOX_FILE);
}

const logger = getSwampLogger(["datastore", "v3"]);

/**
 * a compacted version's file larger than this is not restated for an offline
 * rebase, and its time not read
 */
const COMPACTED_VERSION_MAX_BYTES = 64 * 1024 * 1024;

/**
 * without replication, the datastore's own commits.db shared by every checkout;
 * with a replica or on a bucket, the checkout's own copy under .swamp/ keyed by
 * the datastore's canonical path
 */
export function v3CommitsDbPath(
  datastorePath: string,
  repoDir: string,
): string {
  if (v3BucketBindingAt(datastorePath) !== undefined) {
    return join(resolve(datastorePath), COMMITS_DB_FILE);
  }
  if (v3ReplicaFor(datastorePath) === undefined) {
    return v3SharedCommitsDbPath(datastorePath);
  }
  const key = createHash("sha256").update(canonicalPath(datastorePath))
    .digest("hex").slice(0, 16);
  return swampPath(
    canonicalPath(repoDir),
    V3_LOCAL_COPIES_DIR,
    key,
    COMMITS_DB_FILE,
  );
}

/**
 * every checkout shares it while replication is off; while on, only the first
 * writer reads it, to seed its copy as the first lineage
 */
export function v3SharedCommitsDbPath(datastorePath: string): string {
  return join(datastorePath, COMMITS_DB_FILE);
}

/**
 * undefined on a bucket or while replicating, so every chunk sync is full:
 * Litestream can ship a commit before its chunks are on disk, and a power loss
 * could leave the replica naming a lost chunk
 */
export function v3ChunksOrderedBefore(
  datastorePath: string,
  commitsDbPath: string,
): string | undefined {
  if (v3BucketBindingAt(datastorePath) !== undefined) return undefined;
  if (v3ReplicaFor(datastorePath) !== undefined) return undefined;
  return commitsDbPath;
}

/**
 * resolves symlinks via the nearest existing parent when path is missing, so
 * the key is the same before and after creation (/tmp/x and /private/tmp/x on
 * macOS)
 */
function canonicalPath(path: string): string {
  try {
    return Deno.realPathSync(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    const parent = dirname(resolve(path));
    if (parent === resolve(path)) return resolve(path);
    return join(canonicalPath(parent), basename(path));
  }
}

export function v3CacheRoot(repoDir: string, namespace: string): string {
  return namespace === "" ? swampPath(repoDir) : swampPath(repoDir, namespace);
}

export interface OpenV3DatastoreOptions {
  readonly repoDir: string;
  readonly datastorePath: string;
  readonly namespace?: string;
  readonly writer?: CommitWriter;
  /**
   * a record key outside directories or matching exclude stays in the checkout
   * and is never committed, as v2 never syncs it
   */
  readonly directories?: readonly string[];
  readonly exclude?: readonly string[];
  /**
   * every commit a unit makes names the fence the lease held when the unit
   * opened
   */
  readonly writerFence?: () => number | undefined;
  /**
   * throws when the writer lease was taken over or released; checked before
   * each commit is appended
   */
  readonly assertWriterCurrent?: () => void;
  /**
   * checked before chunk collection, which deletes chunks no commit in the copy
   * names
   */
  readonly assertCopyCurrent?: () => void;
  /**
   * while replicating, chunks are collected only when no lineage but the copy's
   * current one can still be restored; awaited after assertCopyCurrent
   */
  readonly assertCollectable?: () => Promise<void>;
  readonly clock?: () => Date;
}

export interface CutoffCompaction {
  /** the earlier of the cutoff and the policy's safety window */
  readonly bound: Date;
  readonly compactedThrough: number;
  readonly report: CompactionReport | undefined;
}

/** the same rule DefaultDatastorePathResolver.resolvePath applies on v2 */
export function datastoreKeyFilter(
  directories: readonly string[] | undefined,
  exclude: readonly string[] | undefined,
): (key: string) => boolean {
  const subdirs = new Set(
    getDatastoreDirectories({
      type: "filesystem",
      path: "",
      ...(directories !== undefined ? { directories: [...directories] } : {}),
    }),
  );
  const patterns = compilePatterns([...(exclude ?? [])]);
  return (key) => {
    const first = key.split("/")[0];
    if (!subdirs.has(first) || isAlwaysLocal(first)) return false;
    return patterns.length === 0 || !isExcludedCompiled(key, patterns);
  };
}

export const V3_CHECKOUT_FILTER_CHANGED_CODE =
  "datastore_v3_directories_changed";

/**
 * null stands for the default directories; exclude order matters only with a !
 * pattern (last match wins), so it is kept then and sorted away otherwise
 */
function checkoutFilterInputs(
  directories: readonly string[] | undefined,
  exclude: readonly string[] | undefined,
): string {
  // Setup writes the default set out in full while an override such as
  // SWAMP_DATASTORE gives none: both are the default set.
  const listed = directories === undefined
    ? undefined
    : [...new Set(directories)].sort();
  const defaults = [...new Set<string>(DEFAULT_DATASTORE_SUBDIRS)].sort();
  const isDefault = listed === undefined ||
    (listed.length === defaults.length &&
      listed.every((dir, i) => dir === defaults[i]));
  // As compilePatterns reads them: trimmed, blank and comment lines dropped.
  const patterns = (exclude ?? []).map((p) => p.trim())
    .filter((p) => p !== "" && !p.startsWith("#"));
  return JSON.stringify({
    directories: isDefault ? null : listed,
    exclude: patterns.some((p) => p.startsWith("!"))
      ? patterns
      : [...new Set(patterns)].sort(),
  });
}

function localSubdirsOf(inputs: string): string[] {
  try {
    const parsed = JSON.parse(inputs) as { directories: string[] | null };
    if (parsed.directories === null) return [];
    const listed = new Set(parsed.directories);
    return DEFAULT_DATASTORE_SUBDIRS.filter((dir) =>
      !listed.has(dir) && !isAlwaysLocal(dir)
    );
  } catch {
    return [];
  }
}

function describeCheckoutFilter(inputs: string): string {
  try {
    const parsed = JSON.parse(inputs) as {
      directories: string[] | null;
      exclude: string[];
    };
    const directories = parsed.directories === null
      ? "the default directories"
      : `directories [${parsed.directories.join(", ")}]`;
    return parsed.exclude.length === 0
      ? `${directories} and no exclude patterns`
      : `${directories} and exclude [${parsed.exclude.join(", ")}]`;
  } catch {
    return inputs;
  }
}

/**
 * the read model never projects keys the filter keeps local, and a rebuild
 * would lose the checkout's ownership of its files, so there is no
 * re-projection
 */
export class V3CheckoutFilterChangedError extends UserError {
  constructor(repoDir: string, projected: string, current: string) {
    const local = localSubdirsOf(projected);
    const localFiles = local.length === 0
      ? "the files its exclude patterns keep out of the datastore"
      : `${
        local.map((dir) => join(repoDir, ".swamp", dir)).join(", ")
      } and any file its exclude patterns keep out of the datastore`;
    super(
      `Changing directories on an existing v3 checkout is not supported ` +
        `yet. The repository's datastore config now gives ` +
        `${describeCheckoutFilter(current)}, but the checkout at ${repoDir} ` +
        `was built with ${describeCheckoutFilter(projected)}. The config is ` +
        `committed with the repository, so every existing checkout of it ` +
        `refuses on its next command until the two match again. Nothing was ` +
        `changed. Restore the previous directories (and exclude patterns) in ` +
        `the repository's datastore config. Otherwise, make a fresh checkout ` +
        `of the repository: it will not have this checkout's local-only ` +
        `files (${localFiles}), which were never committed, so copy them ` +
        `out of this checkout first.`,
      V3_CHECKOUT_FILTER_CHANGED_CODE,
    );
    this.name = "V3CheckoutFilterChangedError";
  }
}

/**
 * runs before anything of the datastore is opened, so a refusal leaves nothing
 * open and nothing written but the state's own schema
 */
function assertCheckoutFilterUnchanged(
  repoDir: string,
  directories: readonly string[] | undefined,
  exclude: readonly string[] | undefined,
): void {
  const current = checkoutFilterInputs(directories, exclude);
  const state = ReadModelState.open(
    join(readModelStateDir(repoDir), READ_MODEL_STATE_FILE),
  );
  let projected: string;
  try {
    projected = state.stampFilterInputs(current);
  } finally {
    state.close();
  }
  if (projected !== current) {
    throw markErrorPaths(
      new V3CheckoutFilterChangedError(repoDir, projected, current),
      [repoDir],
    );
  }
}

export function v3CheckoutFilterRefusal(
  repoDir: string,
  directories: readonly string[] | undefined,
  exclude: readonly string[] | undefined,
): string | undefined {
  let path: string;
  try {
    path = join(
      readModelStateDir(Deno.realPathSync(repoDir)),
      READ_MODEL_STATE_FILE,
    );
    if (!Deno.statSync(path).isFile) return undefined;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  const db = new DatabaseSync(path, { readOnly: true });
  let projected: string | undefined;
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'checkout_filter'",
    ).get();
    if (table === undefined) return undefined;
    projected = (db.prepare(
      "SELECT inputs FROM checkout_filter WHERE only = 0",
    ).get() as { inputs: string } | undefined)?.inputs;
  } finally {
    db.close();
  }
  const current = checkoutFilterInputs(directories, exclude);
  return projected === undefined || projected === current
    ? undefined
    : new V3CheckoutFilterChangedError(repoDir, projected, current).message;
}

export interface V3ChunkVerify {
  readonly bytes: number;
  readonly from?: string;
}

function randomShardPrefix(): string {
  const [byte] = crypto.getRandomValues(new Uint8Array(1));
  return byte.toString(16).padStart(2, "0");
}

export interface V3Datastore {
  readonly datastorePath: string;
  readonly commitsDbPath: string;
  readonly commitStore: SqliteCommitStore;
  readonly outbox: SqliteCommitOutbox;
  readonly storage: DatastoreStorage;
  readonly chunkStore: ChunkStore;
  readonly readModel: SqliteReadModel;
  readonly catalogStore: CatalogStore;
  readonly namespace: string;
  readonly writer: CommitWriter;
  catchUp(signal?: AbortSignal, options?: CatchUpOptions): Promise<void>;
  /** a catch-up that first resets the read model to apply every commit again */
  replayEveryCommit(signal?: AbortSignal): Promise<void>;
  /**
   * with mayGoOffline, a copy that has read serve's feed puts the checkout
   * offline at the writer hold's catch-up; later catch-ups of the command then
   * read the copy as it is
   */
  catchUpForWrite?(
    signal?: AbortSignal,
    options?: {
      readonly mayGoOffline?: boolean;
      /** a first page serve sent with a lock, used while still current */
      readonly delivered?: DeliveredCatchUp;
    },
  ): Promise<void>;
  /** where the copy's feed stands, for serve to answer with what it lacks */
  serveCatchUpRequest?(): CatchUpRequest;
  /**
   * the writer hold's offline rule, for a write whose first contact with serve
   * is its lock; true when the checkout went offline
   */
  goOfflineOnUnreachable?(error: unknown): boolean;
  /** whether the copy has read serve's feed, so it may go offline */
  serveHasReadFeed?(): boolean;
  /** the read model alone, for a copy just caught up with catchUpForWrite */
  catchUpReadModel?(
    signal?: AbortSignal,
    options?: CatchUpOptions,
  ): Promise<void>;
  serveFeedCursor?(): number;
  sentToServe?(txnId: string): boolean;
  readonly serveUpstreamStore?: ServeUpstreamCommitStore;
  readonly offlineFlushPort?: OfflineFlushPort;
  readonly serveCopyId?: string;
  /** the principal serve last said this checkout's token acts as */
  readonly servePrincipal?: string;
  /**
   * nothing while the read model is complete; otherwise waits up to lockWaitMs
   * for the catch-up in progress, then catches up itself if still incomplete,
   * unless the live writer `writerPid` left it so
   */
  catchUpUnlessComplete(lockWaitMs: number, writerPid?: number): Promise<void>;
  /**
   * the outbox note and the store fence share no transaction; the note lets the
   * next record tell this copy's fence from another copy's if the record is
   * lost
   */
  raiseWriterFence(fence: number): Promise<void>;
  writerFence(): number | undefined;
  /** run only while this process holds the writer lock */
  recoverInterruptedWriter(
    since: number,
    signal?: AbortSignal,
    options?: { readonly entry?: RecoveryEntry },
  ): Promise<string[]>;
  droppedWork():
    | { readonly since: number; readonly openUnits: number }
    | undefined;
  /**
   * run only while this process holds a current writer lease; roots wait while
   * it runs
   */
  recoverDroppedWork(
    signal?: AbortSignal,
  ): Promise<"clean" | "busy" | "recovered">;
  forgetDroppedWork(): void;
  engineFor(
    markDirty: MarkDirtyHook,
    runRepo: () => WorkflowRunRepository,
    options?: {
      readonly readOnly?: boolean;
      readonly heldByServe?: () => boolean;
    },
  ): CommitLogEngine;
  /**
   * queues behind this process's own commits to the partition; the content must
   * already be stored
   */
  appendForwarded(forwarded: ForwardedCommit): Promise<void>;
  /** run only while this process holds the writer lock */
  collectChunks(
    signal: AbortSignal,
    verify?: V3ChunkVerify,
  ): Promise<ChunkCollectionReport>;
  /**
   * run only while this process holds the writer lock: compaction is the single
   * writer's
   */
  compactIfDue(signal: AbortSignal): Promise<CompactionReport | undefined>;
  /**
   * never folds a commit inside the default policy's last day; a remove is
   * folded, and its chunks released, only once older than the bound. Run only
   * while this process holds the writer lock
   */
  compactBefore(cutoff: Date, signal: AbortSignal): Promise<CutoffCompaction>;
  describe(): Promise<{ storedCommits: number; compactedThrough: number }>;
  close(): Promise<void>;
}

export function processCommitWriter(): CommitWriter {
  return {
    host: Deno.hostname(),
    pid: Deno.pid,
    instance: crypto.randomUUID(),
  };
}

/**
 * every handle on a checkout shares its files and catalog, and the recovery
 * rebuilds them all
 */
interface CheckoutUnits {
  open: number;
  droppedSince?: number;
  /**
   * moves with every drop recorded, so a recovery clears only what was dropped
   * before it started
   */
  droppedGeneration: number;
  /** their recovery sweeps them whatever the mtimes */
  droppedDirs: Map<string, Set<string>>;
  recovering?: Promise<unknown>;
  /**
   * while a unit is open, a catch-up leaves their files as this process wrote
   * them; each is forgotten once the read model applied its commit, so only
   * unapplied ones are kept
   */
  readonly sent: Set<string>;
}

const checkoutUnits = new Map<string, CheckoutUnits>();

const MAX_FORWARDED_REMEMBERED = 4096;

/**
 * a sweep runs only under the writer lease, so a writer that may overlap one is
 * in the same process
 */
const sweepBatches = new Map<string, Promise<void>>();

function sweepBatchAt(path: string): Promise<void> {
  return sweepBatches.get(path) ?? Promise.resolve();
}

/**
 * warned once per command that serve was unreachable and a read used the
 * checkout's copy as it was
 */
let staleReadWarned = false;

export function resetStaleReadWarningForTesting(): void {
  staleReadWarned = false;
}

export interface V3DatastoreFaults {
  readonly wrapStorage?: (storage: DatastoreStorage) => DatastoreStorage;
  readonly wrapSink?: (sink: OutboxCommitSink) => OutboxCommitSink;
}

let faultsForTesting: V3DatastoreFaults | undefined;

export function setV3DatastoreFaultsForTesting(
  faults: V3DatastoreFaults | undefined,
): void {
  faultsForTesting = faults;
}

export const DROPPED_WORK_RECOVERY_RUNNING_CODE =
  "datastore_v3_dropped_work_recovery_running";

export class DroppedWorkRecoveryRunningError extends UserError {
  constructor() {
    super(
      "Swamp is still removing unfinished writes from this checkout, so a " +
        "change started now was refused and nothing from it was written. " +
        "Run the command again once the current one has finished.",
      DROPPED_WORK_RECOVERY_RUNNING_CODE,
    );
    this.name = "DroppedWorkRecoveryRunningError";
  }
}

function checkoutUnitsFor(stateDir: string): CheckoutUnits {
  let units = checkoutUnits.get(stateDir);
  if (units === undefined) {
    units = {
      open: 0,
      droppedGeneration: 0,
      droppedDirs: new Map(),
      sent: new Set(),
    };
    checkoutUnits.set(stateDir, units);
  }
  return units;
}

function offlineRefusalFor(partition: PartitionKey): Error {
  const identity = partition.identity;
  if (identity.kind === "model") {
    return new OfflineLeaseRequiredError(
      `${identity.type} ${identity.id}`,
      "this command",
    );
  }
  return new OfflineConfigEditError(offlineSubjectOf(partition));
}

export function offlineSubjectOf(partition: PartitionKey): string {
  const identity = partition.identity;
  switch (identity.kind) {
    case "config": {
      const kind = identity.definitionKind === "model"
        ? "behavior"
        : identity.definitionKind;
      return `the ${kind} definition "${identity.name}"`;
    }
    case "lockfile":
      return "the extension lockfile";
    case "definition":
      return `the behavior definition ${identity.id}`;
    default:
      return partition.toString();
  }
}

export interface CatchUpOptions {
  /** for a publish of what a stopped command produced, which must still land */
  readonly ignoresStop?: boolean;
}

export function openV3Datastore(options: OpenV3DatastoreOptions): V3Datastore {
  // SQLite cannot open a database through a symlinked directory here, so the
  // stores open on canonical paths: a checkout or datastore reached through
  // a symlink works as its target does.
  ensureDirSync(readModelStateDir(options.repoDir));
  const repoDir = Deno.realPathSync(options.repoDir);
  const datastorePath = Deno.realPathSync(options.datastorePath);
  const namespace = options.namespace ?? "";
  // before anything else opens: the read model must never catch up, load or
  // recover under another filter than it projected with
  assertCheckoutFilterUnchanged(repoDir, options.directories, options.exclude);
  const writer = options.writer ?? processCommitWriter();
  // its outbox entries belong to units of this process
  registerOwnCommitWriter(writer);
  const admits = datastoreKeyFilter(options.directories, options.exclude);
  const commitsDbPath = v3CommitsDbPath(datastorePath, repoDir);
  ensureDirSync(dirname(commitsDbPath));
  // a checkout whose upstream is serve keeps a follower copy of serve's log;
  // serve leaves out the commits it may not read
  const serve = serveUpstreamAt(datastorePath);
  // opened before the copy's files: the copy id it records is never older than
  // the files this handle reads, so a reset by another command fences this
  // one's catch-up writes
  const serveState = serve !== undefined
    ? ServeUpstreamState.open(
      join(dirname(commitsDbPath), SERVE_UPSTREAM_STATE_FILE),
    )
    : undefined;
  const commitStore = SqliteCommitStore.open(commitsDbPath, {
    replicated: v3ReplicatesAt(datastorePath),
    ...(serve !== undefined ? { follower: true } : {}),
  });
  const outbox = new SqliteCommitOutbox(v3OutboxPath(commitsDbPath), {
    // recovery judges whether this process still runs by it
    writerProcess: async () => (await localProcess()).identity,
  });
  const bucket = v3BucketBindingAt(datastorePath);
  const serveClient = serve?.client();
  // a filesystem datastore's storage also sweeps stale temp files; a provider's
  // has none. A serve-mode checkout's is its chunk cache, with serve behind it
  const fsStorage = bucket !== undefined
    ? undefined
    : serveClient !== undefined
    ? new CachedServeStorage(
      datastorePath,
      new ServeChunkStorage(serveClient),
      {
        orderedBefore: v3ChunksOrderedBefore(datastorePath, commitsDbPath),
        offline: () => serveOfflineAt(options.datastorePath) !== undefined,
      },
    )
    : new FileSystemStorage(datastorePath, {
      orderedBefore: v3ChunksOrderedBefore(datastorePath, commitsDbPath),
    });
  const baseStorage: DatastoreStorage = bucket?.storage ?? fsStorage!;
  const storage = faultsForTesting?.wrapStorage?.(baseStorage) ?? baseStorage;
  const chunkStore = new ChunkStore(storage);
  const stateDir = readModelStateDir(repoDir);
  ensureDirSync(stateDir);
  const units = checkoutUnitsFor(stateDir);
  const catalogStore = new CatalogStore(v3CatalogPath(repoDir));
  const readModel = SqliteReadModel.open({
    commitStore,
    chunkStore,
    cacheRoot: (ns) => v3CacheRoot(repoDir, ns),
    stateDir,
    catalog: new V3Catalog(catalogStore),
    // never written onto this checkout's local tier
    checkout: { namespace, admits },
    // the checkout-copy guard stores again the chunks that stored commits, the
    // compacted base or pending commits name, never released ones
    referencedChunks: (ns, hashes) =>
      referencedChunksOf(commitStore, outbox, ns, hashes),
    ...(serve !== undefined ? { follower: true } : {}),
    // a run record another writer changed leaves a stale entry in its
    // workflow's run index; the entry is dropped and the next read repairs it.
    // Only the own namespace is indexed
    recordsChanged: (ns, keys) =>
      ns === namespace ? dropRunIndexEntries(repoDir, keys) : Promise.resolve(),
    writerInstance: writer.instance,
    // a commit this process sent, met while one of its units is open; a unit
    // that drops its work forgets the commits it sent, and a recovery's replay
    // never asks
    holdsOwnWork: (commit) => units.open > 0 && units.sent.has(commit.txnId),
    ownWorkApplied: (commit) => {
      units.sent.delete(commit.txnId);
    },
  });
  // one sink for every engine on this handle, so contexts sharing it queue
  // appends behind each other; it refuses commits once the writer lease is lost
  // and keeps each in the outbox until landed
  const lifetime = new AbortController();
  // A command told to stop leaves a catch-up at its next commit; a commit
  // already being sent keeps lifetime.signal alone.
  const catchUpSignal = (
    signal?: AbortSignal,
    options?: CatchUpOptions,
  ): AbortSignal =>
    options?.ignoresStop === true
      ? signal ?? lifetime.signal
      : AbortSignal.any([signal ?? lifetime.signal, commandStopSignal()]);
  if (serveClient !== undefined && serveState !== undefined) {
    serveClient.checkLog(
      serveLogCheck(serveState, serveClient.baseUrl, dirname(commitsDbPath)),
    );
    serveClient.checkAccess(serveAccessCheck(serveState, serveClient.baseUrl));
  }
  // seeded from the checkout, which an offline command runs on; a catch-up
  // that reaches serve replaces it
  if (serveState !== undefined) {
    try {
      const stored = serveState.initiator();
      if (
        stored !== undefined &&
        serveInitiatorAt(options.datastorePath) === undefined
      ) {
        noteServeInitiator(options.datastorePath, stored);
      }
    } catch (readError) {
      logger
        .debug`Could not read what serve said of run initiators: ${readError}`;
    }
  }
  const serveCatchUp = serveClient !== undefined && serveState !== undefined
    ? new ServeCatchUp({
      client: serveClient,
      commitStore,
      state: serveState,
      copyDir: dirname(commitsDbPath),
      namespace,
      repair: {
        // a unit of this process may have files and outbox entries in flight,
        // which a rebuild's sweep or a resend would disturb
        ready: () => units.open === 0,
        // under the copy's writer lease, which the repair holds
        resendOutbox: async (signal) => {
          const fence = v3WriterFence(dirname(commitsDbPath));
          if (serveSink === undefined || fence === undefined) return;
          await recoverCommitOutbox({
            outbox,
            commitStore: serveSink.upstream,
            chunkStore,
            ...(offlineFlushPort !== undefined
              ? { offline: offlineFlushPort }
              : {}),
          }, { fence, writer, forwarded: true, signal });
        },
        // full: the state still holds the dropped commits a targeted
        // recovery would build on
        rebuildReadModel: async (since, signal) => {
          await readModel.recover(namespace, { since, admits, signal });
        },
        principal: () => serveState.checkedPrincipal(),
      },
    })
    : undefined;
  const serveSink = serveClient !== undefined && serveCatchUp !== undefined
    ? createServeCommitSink({
      client: serveClient,
      commitStore,
      catchUp: serveCatchUp,
      chunkCache: fsStorage!,
      outbox,
      sweepBatch: () => sweepBatchAt(outbox.path),
      signal: () => lifetime.signal,
      leaseOf: (partition) => heldServeLeaseOf(serve!.root, partition),
      dropUnconfirmedLease: (partition, leaseId) =>
        dropUnconfirmedServeLease(serve!.root, partition, leaseId),
      // offline, commits queue where the rules allow: the backstop for any
      // entry point that skipped the command's check
      offline: () => {
        if (serveOfflineAt(options.datastorePath) === undefined) {
          return undefined;
        }
        return {
          queues: async (partition) => {
            const context = await offlineContextAt(options.datastorePath);
            if (
              checkOfflineCommit(partition, {
                ...context,
                registered: offlineRegisteredAt(options.datastorePath),
              })
            ) {
              return true;
            }
            return offlineRefusalFor(partition);
          },
          noteQueued: (txnId) =>
            noteQueuedOffline(options.datastorePath, txnId),
        };
      },
      onLeasedCommit: async (partition, leaseId, landed) => {
        raiseServeLeaseFloor(serve!.root, partition, leaseId, landed);
        try {
          await raiseExplicitLeaseFloor(serve!.root, leaseId, landed);
        } catch (error) {
          // The commit landed; the next command's floor may lag it.
          logger
            .warn`Could not record a model lease's new floor in this checkout: ${error}`;
        }
      },
    })
    : undefined;
  // run by the outbox recovery under the writer hold, once serve is reachable
  const offlineFlushPort: OfflineFlushPort | undefined =
    serveSink !== undefined && serveCatchUp !== undefined
      ? {
        catchUpPartition: async (ns, partition) => {
          await serveCatchUp.catchUpPartition(ns, partition, lifetime.signal);
        },
        partitionState: (ns, partition) =>
          commitStore.partitionState(ns, partition),
        partitionCommits: async (ns, partition) => {
          const commits: Commit[] = [];
          let from = 1;
          while (true) {
            let page;
            try {
              page = await commitStore.readPartition(ns, partition, from, 500);
            } catch (error) {
              // what was compacted is not read: those versions' times are
              // unknown to the rebase
              if (
                error instanceof CommitsCompactedError &&
                error.compactedSeq !== undefined && error.compactedSeq >= from
              ) {
                from = error.compactedSeq + 1;
                continue;
              }
              throw error;
            }
            if (page.length === 0) return commits;
            for (const change of page) commits.push(change.commit);
            from = page[page.length - 1].commit.seq + 1;
          }
        },
        head: (ns, partition) => serveCatchUp.headOf(ns, partition),
        send: (commit, leaseId) =>
          serveSink.upstream.appendUnderLease(commit, leaseId),
        encodeMetadata: (metadata) =>
          new TextEncoder().encode(
            stringifyYaml(
              JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>,
            ),
          ),
        storeChunks: async (_ns, bytes) => {
          const batch = chunkStore.beginBatch(unitNamespace);
          try {
            const blob = await chunkStore.write(
              unitNamespace,
              bytes,
              lifetime.signal,
              batch,
            );
            await batch.commit(lifetime.signal);
            return blob;
          } finally {
            await batch.discard();
          }
        },
        mark: (keys, state, reason, code) =>
          outbox.markState(keys, state, reason, code),
        settle: (keys) => outbox.settle(keys),
        recordOwnLanded: (key, at, carry) =>
          outbox.recordLandedOffline(
            key,
            at,
            COMPACTED_TXN_RETENTION_MS,
            carry,
          ),
        ownLanded: (ns, partition) =>
          outbox.landedOfflineTxnIds(ns, partition.toString()),
        landedCarry: (ns, partition) =>
          outbox.landedOfflineCarry(ns, partition.toString()),
        // kept by serve for an admin to accept
        ...(serveClient !== undefined
          ? {
            quarantined: createQuarantineDeposit({
              client: serveClient,
              chunkCache: fsStorage!,
              signal: () => lifetime.signal,
            }),
            quarantineState: (entry) =>
              serveClient.quarantineState(
                entry.commit.txnId,
                lifetime.signal,
              ),
          }
          : {}),
        markSentMaybe: (key, at) => outbox.markSentMaybe(key, at),
        compactedThrough: async (ns, partition) => {
          try {
            await commitStore.readPartition(ns, partition, 1, 1);
            return 0;
          } catch (error) {
            if (error instanceof CommitsCompactedError) {
              return error.compactedSeq ?? 0;
            }
            throw error;
          }
        },
        // A compacted version's metadata and raw bytes, as the checkout's
        // files hold them: its time is then its writer's `createdAt`.
        compactedVersion: async (ns, partition, name, version) => {
          const identity = partition.identity;
          if (identity.kind !== "model") return undefined;
          const model = new ModelChanges(
            ModelType.create(identity.type),
            identity.id,
          );
          const read = (file: "metadata.yaml" | "raw") =>
            readModel.recordBytes(
              ns,
              partition,
              model.dataKey(name, version, file).toString(),
              COMPACTED_VERSION_MAX_BYTES,
            );
          const metadataFile = await read("metadata.yaml");
          if (metadataFile === undefined) return undefined;
          let parsed;
          try {
            parsed = DataMetadataSchema.safeParse(
              parseYaml(new TextDecoder().decode(metadataFile.bytes)),
            );
          } catch {
            return undefined;
          }
          if (!parsed.success) return undefined;
          const raw = await read("raw");
          return {
            metadata: parsed.data,
            ...(raw !== undefined ? { raw: raw.bytes } : {}),
          };
        },
      }
      : undefined;
  const baseSink: OutboxCommitSink = serveSink ??
    createOutboxCommitSink({
      commitStore,
      outbox,
      sweepBatch: () => sweepBatchAt(outbox.path),
      ...(options.assertWriterCurrent !== undefined
        ? { assertWriterCurrent: options.assertWriterCurrent }
        : {}),
    });
  const faultedSink = faultsForTesting?.wrapSink?.(baseSink) ?? baseSink;
  // noted before it is sent: serve's feed can bring the commit to a catch-up
  // before its reply does. One that never lands never comes back in the feed
  const forwarded = new Set<string>();
  const noteSending = (commit: Commit): void => {
    units.sent.add(commit.txnId);
    forwarded.add(commit.txnId);
    // a long-lived process keeps only its recent sends
    if (forwarded.size > MAX_FORWARDED_REMEMBERED) {
      forwarded.delete(forwarded.values().next().value!);
    }
  };
  const batchOf = faultedSink.beginBatch;
  const sink: OutboxCommitSink = serveSink === undefined ? faultedSink : {
    ...faultedSink,
    append: (commit) => {
      noteSending(commit);
      return faultedSink.append(commit);
    },
    ...(batchOf === undefined ? {} : {
      beginBatch: async (slots, batchOptions) => {
        const batch = await batchOf(slots, batchOptions);
        return batch === undefined ? undefined : {
          append: (slot, commit) => {
            noteSending(commit);
            return batch.append(slot, commit);
          },
          skip: (slot) => batch.skip(slot),
        };
      },
    }),
  };
  /**
   * a read that cannot reach serve goes on with what the copy holds and says
   * so; a write is refused
   */
  let contactRecorded = false;
  let reachedServe = false;
  /**
   * a copy that has read serve's feed goes offline for the rest of the command
   * when serve cannot be reached before a write; false when it may not
   */
  const goOfflineOn = (error: unknown): boolean => {
    if (
      !(error instanceof ServeUnreachableError) || serveState === undefined ||
      !serveState.hasReadFeed()
    ) {
      return false;
    }
    const contact = serveState.lastContact();
    enterServeOffline(
      options.datastorePath,
      {
        serveUrl: error.serveUrl,
        since: clock().getTime(),
        ...(contact !== undefined ? { lastContactAt: contact.at } : {}),
        ...(contact?.clockOffsetMs !== undefined
          ? { clockOffsetMs: contact.clockOffsetMs }
          : {}),
      },
      error.cause instanceof Error ? error.cause.message : String(error.cause),
    );
    return true;
  };
  const catchUpFromServe = async (
    signal: AbortSignal,
    mode: "read" | "write",
    mayGoOffline = false,
    delivered?: DeliveredCatchUp,
  ): Promise<void> => {
    if (serveCatchUp === undefined) return;
    // offline for the rest of the command: the copy is read as it is, and
    // nothing waits on a serve it could not reach
    if (serveOfflineAt(options.datastorePath) !== undefined) return;
    try {
      await serveCatchUp.catchUp(signal, delivered);
      reachedServe = true;
      // a catch-up that read serve's feed heard serve, whatever its features
      const initiator = serveClient!.initiatorMode() ?? { kind: "not-checked" };
      noteServeInitiator(options.datastorePath, initiator);
      try {
        serveState?.recordInitiator(initiator);
      } catch (recordError) {
        logger
          .debug`Could not record what serve said of run initiators: ${recordError}`;
      }
      // Once per command: the last contact, and serve's clock then, are what
      // a later offline command judges its leases and times by.
      if (!contactRecorded && serveState !== undefined) {
        contactRecorded = true;
        try {
          serveState.recordContact(
            clock(),
            serveClockOf(serveClient!.baseUrl)?.offsetMs,
          );
        } catch (recordError) {
          logger
            .debug`Could not record this checkout's contact with serve: ${recordError}`;
        }
      }
    } catch (error) {
      if (mode === "write" && mayGoOffline && goOfflineOn(error)) return;
      if (mode === "read" && error instanceof ServeUnreachableError) {
        // A copy that never read serve's feed holds nothing: an empty answer
        // would pass for an empty datastore.
        if (serveState !== undefined && !serveState.hasReadFeed()) {
          throw new ServeNeverReadError(error.serveUrl, error.cause);
        }
        // Said once per command: a command catches up many times.
        if (!staleReadWarned) {
          staleReadWarned = true;
          const reason = error.cause instanceof Error
            ? error.cause.message
            : String(error.cause);
          logger
            .warn`Could not reach serve at ${error.serveUrl}, so this reads the datastore as this checkout last saw it, which may be out of date: ${reason}`;
          // the logger is silent in json mode, so say it there as a notice
          const contact = serveState?.lastContact();
          emitServeOfflineNotice({
            notice: "datastore_offline",
            serveUrl: error.serveUrl,
            ...(contact !== undefined ? { lastContactAt: contact.at } : {}),
            message: `This command reads the datastore as this checkout ` +
              `last saw it, which may be out of date: ${reason}`,
          });
        }
        return;
      }
      throw error;
    }
  };
  const tracker: UnitTracker = {
    opened: () => {
      units.open++;
    },
    ended: () => {
      units.open--;
    },
    dropped: (openedAt, versionDirs, sentTxnIds) => {
      // its files may hold later writes that never committed over the commits
      // it sent: a catch-up puts those commits back
      for (const txnId of sentTxnIds) units.sent.delete(txnId);
      units.droppedSince = Math.min(units.droppedSince ?? openedAt, openedAt);
      units.droppedGeneration++;
      if (versionDirs.length === 0) return;
      let dirs = units.droppedDirs.get(namespace);
      if (dirs === undefined) {
        dirs = new Set();
        units.droppedDirs.set(namespace, dirs);
      }
      for (const dir of versionDirs) dirs.add(dir);
    },
  };
  const configEditBases: ConfigEditBases = {
    baseOf: (ns, partition, key) =>
      readModel.configBase(ns, PartitionKey.parse(partition), key),
    committed: (ns, partition, key) =>
      readModel.clearConfigBases(ns, PartitionKey.parse(partition), key),
  };
  const unitNamespace = namespace === ""
    ? SOLO_NAMESPACE
    : restoreNamespace(namespace);
  let closed = false;
  const clock = options.clock ?? (() => new Date());

  const compact = async (
    signal: AbortSignal,
    now: Date,
    before?: Date,
  ): Promise<CompactionReport | undefined> => {
    const policy = DEFAULT_COMPACTION_POLICY;
    const through = compactionTarget(
      await commitStore.compactionStatus(retentionOf(policy, now, before)),
      policy,
      before,
    );
    if (through === undefined) return undefined;
    const fence = options.writerFence?.();
    return await commitStore.compactHistory(through, {
      signal,
      clock,
      ...(fence !== undefined ? { fence } : {}),
      // No retry, from a unit or the outbox, is older than the bound.
      pruneTxnsBefore: new Date(now.getTime() - COMPACTED_TXN_RETENTION_MS),
    });
  };

  return {
    // The path as configured: the writer lock and callers key on it.
    datastorePath: options.datastorePath,
    commitsDbPath,
    commitStore,
    outbox,
    storage,
    chunkStore,
    readModel,
    catalogStore,
    namespace,
    writer,
    ...(serveSink !== undefined
      ? { serveUpstreamStore: serveSink.upstream }
      : {}),
    ...(offlineFlushPort !== undefined ? { offlineFlushPort } : {}),
    ...(serveState !== undefined
      ? {
        serveCopyId: serveState.copyId(),
        ...(serveState.checkedPrincipal() !== undefined
          ? { servePrincipal: serveState.checkedPrincipal() }
          : {}),
        serveFeedCursor: () => serveState.feedCursor(),
        sentToServe: (txnId: string) => forwarded.has(txnId),
      }
      : {}),
    async catchUp(signal, catchUpOptions) {
      await catchUpFromServe(catchUpSignal(signal, catchUpOptions), "read");
      await unreachableAsCatchUpError(() =>
        readModel.catchUp(catchUpSignal(signal, catchUpOptions))
      );
    },
    async replayEveryCommit(signal) {
      // Before any await: a restore does not run again once its copy state is written.
      readModel.markReplayPending();
      await catchUpFromServe(catchUpSignal(signal), "read");
      await unreachableAsCatchUpError(() =>
        readModel.catchUp(catchUpSignal(signal))
      );
    },
    ...(serveCatchUp !== undefined
      ? {
        async catchUpForWrite(
          signal?: AbortSignal,
          catchUpOptions?: {
            readonly mayGoOffline?: boolean;
            readonly delivered?: DeliveredCatchUp;
          },
        ) {
          // a write under way lands after a stop: it never follows commandStopSignal
          await catchUpFromServe(
            signal ?? lifetime.signal,
            "write",
            catchUpOptions?.mayGoOffline === true,
            catchUpOptions?.delivered,
          );
        },
        serveCatchUpRequest: () => serveCatchUp.request(),
        goOfflineOnUnreachable: (error: unknown) => goOfflineOn(error),
        serveHasReadFeed: () => serveState?.hasReadFeed() === true,
        async catchUpReadModel(
          signal?: AbortSignal,
          catchUpOptions?: CatchUpOptions,
        ) {
          await unreachableAsCatchUpError(() =>
            readModel.catchUp(catchUpSignal(signal, catchUpOptions))
          );
        },
      }
      : {}),
    async catchUpUnlessComplete(lockWaitMs, writerPid) {
      await catchUpFromServe(catchUpSignal(), "read");
      await unreachableAsCatchUpError(() =>
        readModel.catchUpUnlessComplete(catchUpSignal(), lockWaitMs, writerPid)
      );
    },
    async raiseWriterFence(fence) {
      // Noted first: a writer killed, or failing, before the record leaves
      // the note, and the next record continues the chain over it rather
      // than dropping this copy's prepared commits as another copy's.
      await outbox.notePendingFence(fence);
      await commitStore.raiseWriterFence(fence);
      // Only a copy of its own per checkout can meet another copy's fences.
      await outbox.recordFence(fence, {
        replicated: bucket !== undefined ||
          v3ReplicaFor(datastorePath) !== undefined,
      });
    },
    writerFence() {
      return commitStore.writerFence();
    },
    recoverInterruptedWriter(since, signal, recoverOptions) {
      return readModel.recover(namespace, {
        since,
        admits,
        // a restore's rebuild is not run again once the copy names it
        signal: recoverOptions?.entry === "rebuilt"
          ? signal ?? lifetime.signal
          : catchUpSignal(signal),
        ...(recoverOptions?.entry !== undefined
          ? { entry: recoverOptions.entry }
          : {}),
        targeted: true,
      });
    },
    droppedWork() {
      return units.droppedSince === undefined
        ? undefined
        : { since: units.droppedSince, openUnits: units.open };
    },
    async recoverDroppedWork(signal) {
      const since = units.droppedSince;
      const generation = units.droppedGeneration;
      if (since === undefined) return "clean";
      if (units.open > 0) return "busy";
      const recovery = readModel.recover(namespace, {
        since: recoverySince(since),
        admits,
        // runs at teardown, after a stop has fired; its dropped directories
        // live only in this process, so it must finish
        signal: signal ?? lifetime.signal,
        entry: "dropped_work",
        droppedDirs: [...units.droppedDirs.get(namespace) ?? []],
        targeted: true,
      });
      units.recovering = recovery;
      try {
        await recovery;
      } finally {
        units.recovering = undefined;
      }
      // A drop recorded while it ran stays owed to the next recovery.
      if (units.droppedGeneration === generation) {
        units.droppedSince = undefined;
        units.droppedDirs.clear();
      }
      return "recovered";
    },
    forgetDroppedWork() {
      units.droppedSince = undefined;
      units.droppedDirs.clear();
    },
    appendForwarded(forwarded) {
      const fence = options.writerFence?.();
      return appendForwardedCommit({
        sink,
        chunkStore,
        namespace: unitNamespace,
        writer,
        signal: lifetime.signal,
        ...(fence === undefined ? {} : { fence }),
      }, forwarded);
    },
    engineFor(markDirty, runRepo, engineOptions = {}) {
      const fenced = () => {
        const fence = options.writerFence?.();
        return fence === undefined ? {} : { fence };
      };
      const unitOptions = {
        admits: engineOptions.readOnly === true
          ? (key: string): boolean => {
            throw new ReadOnlyV3WriteError(key);
          }
          : admits,
        sink,
        chunkStore,
        namespace: unitNamespace,
        writer,
        signal: lifetime.signal,
        tracker,
        configEditBases,
        lastChangeOf: (partition: PartitionKey, key: string) =>
          recordLastChange(
            commitStore,
            unitNamespace.toString(),
            partition,
            key,
          ),
        // a serve-mode commit records when it ran and serve's clock then, so
        // one queued offline is judged by when it ran
        ...(serveClient !== undefined && serveState !== undefined
          ? {
            clockOffsetMs: () =>
              serveClockOf(serveClient.baseUrl)?.offsetMs ??
                serveOfflineAt(options.datastorePath)?.clockOffsetMs ??
                serveState.lastContact()?.clockOffsetMs,
          }
          : {}),
      };
      // by root: in serve one engine flushes every run's own root
      const checkpointedAt = new WeakMap<UnitOfWork, number>();
      return {
        openUnit(): UnitOfWork {
          const parent = currentUnitOfWork();
          // a root opened during recovery would write into a checkout being
          // rewritten; it cannot wait, being synchronous, so it is refused. A
          // child joins an open root, so none runs then
          if (
            units.recovering !== undefined &&
            commitLogParentFor(markDirty, parent) === undefined
          ) {
            throw new DroppedWorkRecoveryRunningError();
          }
          return createCommitLogUnitOfWork(markDirty, {
            ...unitOptions,
            ...fenced(),
            parent,
          });
        },
        hasOpenUnit(): boolean {
          return commitLogParentFor(markDirty, currentUnitOfWork()) !==
            undefined;
        },
        async checkpointOpenUnit(
          checkpointOptions?: { readonly release?: string },
        ): Promise<OpenUnitCheckpoint> {
          const unit = commitLogParentFor(markDirty, currentUnitOfWork());
          if (unit === undefined) return "no-unit";
          try {
            if (!await checkpointFrom(unit, checkpointOptions)) {
              return "no-unit";
            }
            const root = commitLogRootFor(markDirty, unit);
            if (root !== undefined) checkpointedAt.set(root, Date.now());
            return "committed";
          } catch (error) {
            if (error instanceof PartitionsRefusedError) return "refused";
            throw error;
          }
        },
        acknowledgeOpenUnitRefusals(partitions) {
          const root = commitLogRootFor(markDirty, currentUnitOfWork()) as
            | CommitLogUnitOfWork
            | undefined;
          root?.acknowledgeRefusals(partitions);
        },
        lastCheckpointAt: () => {
          const root = commitLogRootFor(markDirty, currentUnitOfWork());
          return root === undefined ? undefined : checkpointedAt.get(root);
        },
        forwardsToServe: serveSink !== undefined,
        heldByServe: () => engineOptions.heldByServe?.() === true,
        async appendToOpenUnit(changes, appendOptions) {
          const unit = commitLogParentFor(markDirty, currentUnitOfWork());
          if (unit === undefined) return "no-unit";
          if (
            sink.takesStepStarts?.() === false &&
            changes.some(isStepStartChange)
          ) {
            return "unsupported";
          }
          for (let attempt = 1;; attempt++) {
            try {
              return await appendNowFrom(unit, changes, appendOptions) ??
                "no-unit";
            } catch (error) {
              const refused = error instanceof ServeCommitRefusedError ||
                error instanceof PartitionsRefusedError ||
                (error instanceof CommitRejectedError &&
                  error.reason !== "seq-gap");
              if (
                !refused && isTransientAppendFailure(error) &&
                attempt < DIRECT_APPEND_ATTEMPTS
              ) {
                await new Promise((resolve) =>
                  setTimeout(resolve, DIRECT_APPEND_BACKOFF_MS * attempt)
                );
                continue;
              }
              throw new AppendUnrecordedError(error, refused);
            }
          }
        },
        async storedVersion(partition, key) {
          // The commit store, not the read model, which applies this
          // process's own commits only at its next catch-up.
          const sha256 = await commitStore.recordSha256(
            unitNamespace.toString(),
            partition,
            RecordKey.create(key),
          );
          return sha256 === undefined ? "absent" : { sha256 };
        },
        async staleConfigEdits(partition) {
          const ns = unitNamespace.toString();
          const stale = [];
          for (const { key, base } of readModel.configBases(ns, partition)) {
            if (base === "absent") continue;
            const head = await commitStore.recordSha256(
              ns,
              partition,
              RecordKey.create(key),
            );
            if (head === base.sha256) continue;
            const last = await recordLastChange(
              commitStore,
              ns,
              partition,
              key,
            );
            stale.push({
              key,
              ...(last.changedBy === undefined
                ? {}
                : { changedBy: last.changedBy }),
              ...(last.changedAt === undefined
                ? {}
                : { changedAt: last.changedAt }),
            });
          }
          return stale;
        },
        configLoaded(partition) {
          readModel.clearConfigBases(unitNamespace.toString(), partition);
        },
        reachedServe: () =>
          reachedServe && serveOfflineAt(options.datastorePath) === undefined,
        committedBeforeThrowing(error: unknown): boolean {
          return wasThrownAfterCommit(error);
        },
        async runRoot<T>(
          rootOptions: CommitLogRootRunOptions<T>,
          fn: (root: CommitLogRootView) => Promise<T>,
        ): Promise<T> {
          // recovery rewrites the checkout, so no root opens while it runs; the
          // root counts as open from the call, so no recovery starts while it
          // waits
          units.open++;
          try {
            await units.recovering?.catch(() => {});
          } finally {
            units.open--;
          }
          return await runInCommitLogRoot<T>({ markDirty }, {
            ...unitOptions,
            ...fenced(),
            ...(rootOptions.disposition !== undefined
              ? { disposition: rootOptions.disposition }
              : {}),
            ...(rootOptions.reconcileRuns === true
              ? {
                onRefused: (error) => reconcileRefusedRuns(runRepo(), error),
              }
              : {}),
            ...(rootOptions.onEnded !== undefined
              ? { onEnded: rootOptions.onEnded }
              : {}),
            ...(rootOptions.releaseWithEnd !== undefined
              ? { endRelease: rootOptions.releaseWithEnd }
              : {}),
          }, (root) => fn(root));
        },
      };
    },
    async collectChunks(signal, verify) {
      options.assertCopyCurrent?.();
      await options.assertCollectable?.();
      const sweeper = crypto.randomUUID();
      return await new ChunkCollector({
        // a chunk an outbox entry names is about to be committed, or was by a
        // writer that died before its check
        commitStore: {
          async referencedChunks(ns, hashes, releasedSince) {
            const names = await commitStore.referencedChunks(
              ns,
              hashes,
              releasedSince,
            );
            const rest = hashes.filter((hash) => !names.has(hash));
            for (const hash of await outbox.referencedChunks(ns, rest)) {
              names.add(hash);
            }
            return names;
          },
        },
        storage,
        ...(fsStorage !== undefined ? { tempFiles: fsStorage } : {}),
        sweep: {
          begin: () => outbox.beginSweep(sweeper, Date.now()),
          heartbeat: () => outbox.heartbeatSweep(sweeper, Date.now()),
          end: () => outbox.endSweep(sweeper),
          // writers that may overlap a batch wait for it
          async batch(run) {
            const done = run();
            const settled = done.then(() => {}, () => {});
            sweepBatches.set(outbox.path, settled);
            try {
              return await done;
            } finally {
              if (sweepBatches.get(outbox.path) === settled) {
                sweepBatches.delete(outbox.path);
              }
            }
          },
        },
        ...(options.assertCopyCurrent !== undefined
          ? { assertMayDelete: options.assertCopyCurrent }
          : {}),
        clock,
      }).collect(unitNamespace, {
        signal,
        ...(verify !== undefined && verify.bytes > 0
          ? {
            verifyBytes: verify.bytes,
            verifyFrom: verify.from ?? randomShardPrefix(),
          }
          : {}),
      });
    },
    compactIfDue(signal) {
      return compact(signal, clock());
    },
    async compactBefore(cutoff, signal) {
      const now = clock();
      const bound = compactionBound(DEFAULT_COMPACTION_POLICY, now, cutoff);
      const report = await compact(signal, now, cutoff);
      return {
        bound,
        compactedThrough: report?.point ??
          (await commitStore.history()).compactedThrough,
        report,
      };
    },
    describe() {
      return commitStore.history();
    },
    async close() {
      if (closed) return;
      closed = true;
      lifetime.abort();
      try {
        await sink.retryOwedRemovals();
      } catch (error) {
        logger
          .warn`Discarding outbox entries of failed v3 commits failed again; the next writer may land them: ${error}`;
      }
      await readModel.close();
      await commitStore.close();
      await outbox.close();
      serveState?.close();
      serveClient?.close();
    },
  };
}

/**
 * what a setup that stopped after writing the marker leaves; a missing or blank
 * marker is taken only under a stricter check, so no datastore with history
 * passes for a skeleton
 */
export async function isFreshV3Skeleton(
  datastorePath: string,
): Promise<boolean> {
  const allowed = new Set([
    DATASTORE_FORMAT_MARKER_FILE,
    COMMITS_DB_FILE,
    `${COMMITS_DB_FILE}-wal`,
    `${COMMITS_DB_FILE}-shm`,
    "_blobs",
    // a writer's Litestream sidecar state, present only when replication is on
    replicationDirName(COMMITS_DB_FILE),
    litestreamStateDirName(COMMITS_DB_FILE),
    // the commit outbox, while it holds no entries
    COMMIT_OUTBOX_FILE,
    `${COMMIT_OUTBOX_FILE}-wal`,
    `${COMMIT_OUTBOX_FILE}-shm`,
  ]);
  const names = new Set<string>();
  for await (const entry of Deno.readDir(datastorePath)) {
    if (!allowed.has(entry.name)) return false;
    names.add(entry.name);
  }
  const marker = await v3MarkerState(datastorePath);
  if (marker === "other") return false;
  const lost = marker !== "v3";
  if (
    lost && (names.has(replicationDirName(COMMITS_DB_FILE)) ||
      names.has(litestreamStateDirName(COMMITS_DB_FILE)))
  ) {
    return false;
  }
  // Without a regular-file commits.db nothing tells a lost marker's
  // skeleton from another directory; checked before the outbox is opened,
  // which would create it.
  if (lost) {
    try {
      const info = await Deno.lstat(join(datastorePath, COMMITS_DB_FILE));
      if (!info.isFile) return false;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
  }
  try {
    for await (const _ of Deno.readDir(join(datastorePath, "_blobs"))) {
      return false;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const outbox = new SqliteCommitOutbox(
    join(datastorePath, COMMIT_OUTBOX_FILE),
  );
  try {
    if (await outbox.hasEntries()) return false;
  } catch (error) {
    logger
      .debug`The commit outbox of ${datastorePath} could not be read, so it is not a fresh skeleton: ${error}`;
    return false;
  } finally {
    await outbox.close();
  }
  try {
    await Deno.lstat(join(datastorePath, COMMITS_DB_FILE));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return true;
    throw error;
  }
  if (lost) {
    try {
      const facts = readCommitLogFacts(join(datastorePath, COMMITS_DB_FILE));
      return facts.schemaVersion <= COMMIT_STORE_SCHEMA_VERSION &&
        facts.compactionPoint === 0 &&
        (facts.partitionHeads === 0 || facts.unschemaed);
    } catch (error) {
      logger
        .debug`The commit log of ${datastorePath} could not be read, so it is not a fresh skeleton: ${error}`;
      return false;
    }
  }
  const store = SqliteCommitStore.open(join(datastorePath, COMMITS_DB_FILE));
  try {
    const history = await store.history();
    return history.storedCommits === 0 && history.compactedThrough === 0;
  } finally {
    await store.close();
  }
}

/**
 * opened read-only, so it never creates, migrates or locks the database and
 * runs beside a writer
 */
export function listV3Namespaces(
  datastorePath: string,
  repoDir: string,
): string[] {
  const path = v3CommitsDbPath(datastorePath, repoDir);
  try {
    Deno.statSync(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  return queryNamespaces(new DatabaseSync(path, { readOnly: true }));
}

function queryNamespaces(db: DatabaseSync): string[] {
  try {
    // A reader can meet a writer's lock while the WAL index is rebuilt.
    db.exec("PRAGMA busy_timeout=5000");
    // A partition head is written with every commit and never deleted, so
    // it names each namespace that ever committed, compacted or not.
    const rows = db.prepare(
      "SELECT DISTINCT namespace FROM partition_heads WHERE namespace != '' " +
        "ORDER BY namespace",
    ).all() as { namespace: string }[];
    return rows.map((row) => row.namespace);
  } finally {
    db.close();
  }
}

/**
 * the marker is durable before commits.db exists: each created directory's
 * parent is synced first, the marker write syncs the datastore directory, and
 * only then is commits.db created
 */
export async function initializeV3Datastore(
  datastorePath: string,
  writtenBy: string,
  options: {
    readonly syncDirectory?: (dir: string) => Promise<void>;
    readonly rename?: (from: string, to: string) => Promise<void>;
    /**
     * for a copy swamp creates by itself, which two commands may create at
     * once: a v3 marker found after markerSeen was absent is another creator's.
     * Never for datastore setup
     */
    readonly adoptConcurrentMarker?: {
      readonly markerSeen: "absent" | "blank" | "other";
    };
    readonly link?: (from: string, to: string) => Promise<void>;
  } = {},
): Promise<void> {
  const syncDir = options.syncDirectory ?? syncDirectory;
  const created = await absentDirectories(datastorePath);
  await Deno.mkdir(datastorePath, { recursive: true });
  for (const dir of created) await syncDir(dirname(dir));
  const resuming = await isFreshV3Skeleton(datastorePath);
  const marker = resuming ? await v3MarkerState(datastorePath) : "absent";
  const adoptable = resuming ||
    options.adoptConcurrentMarker?.markerSeen === "absent";
  if (marker === "v3") {
    // A marker an older swamp linked without syncing the directory.
    await syncDir(datastorePath);
  } else {
    // A setup resuming beside this one may remove the blank marker and
    // write the v3 one first, as a racing restore may.
    if (marker === "blank") {
      await removeBlankMarker(datastorePath, options.rename);
    }
    try {
      await writeDatastoreFormatMarker(datastorePath, {
        format: V3_DATASTORE_FORMAT,
        minReaderFormat: V3_DATASTORE_FORMAT,
        writtenBy,
      }, {
        syncDirectory: syncDir,
        ...(options.link !== undefined ? { link: options.link } : {}),
      });
    } catch (error) {
      // Only a resume, or a copy that adopts the winner's marker, lost a
      // race: a fresh setup still refuses a marker that appeared meanwhile.
      if (!adoptable || !(error instanceof UserError)) throw error;
      if (await v3MarkerState(datastorePath) !== "v3") {
        // Not yet whole, as an exclusive create shows it: a retry finds it.
        if (options.adoptConcurrentMarker !== undefined) {
          throw markErrorPaths(new V3CopySetupRacedError(datastorePath), [
            datastorePath,
          ]);
        }
        throw error;
      }
      // Durable before commits.db, whether or not the winner has synced.
      await syncDir(datastorePath);
    }
  }
  // while replicating, each checkout keeps its own copy, so the datastore holds
  // no commits.db
  if (v3ReplicaFor(datastorePath) === undefined) {
    const store = SqliteCommitStore.open(
      join(datastorePath, COMMITS_DB_FILE),
    );
    await store.close();
  }
  await Deno.mkdir(join(datastorePath, "_blobs"), { recursive: true });
}

/**
 * commits.db must be a regular file holding a v3 commit log at a schema this
 * swamp reads; it is opened read-write without changing its schema, so SQLite
 * recovers a write-ahead log a crash left
 */
export async function restoreV3FormatMarker(
  datastorePath: string,
  writtenBy: string,
  options: Parameters<typeof writeDatastoreFormatMarker>[2] & {
    readonly rename?: (from: string, to: string) => Promise<void>;
  } = {},
): Promise<string> {
  const commitsDb = join(datastorePath, COMMITS_DB_FILE);
  const markerPath = join(datastorePath, DATASTORE_FORMAT_MARKER_FILE);
  const refuse = (reason: string) =>
    markErrorPaths(
      new UserError(
        `The format marker of ${datastorePath} was not restored: ${reason}. ` +
          "Nothing was changed.",
      ),
      [datastorePath],
    );
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(commitsDb);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw refuse(`${commitsDb} does not exist`);
    }
    throw error;
  }
  if (!info.isFile) throw refuse(`${commitsDb} is not a regular file`);
  let facts: CommitLogFacts;
  try {
    facts = readCommitLogFacts(commitsDb);
  } catch (error) {
    throw refuse(
      `${commitsDb} could not be read as a v3 commit log (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  if (facts.schemaVersion > COMMIT_STORE_SCHEMA_VERSION) {
    throw refuse(
      `${commitsDb} is at schema version ${facts.schemaVersion}, newer than ` +
        `this swamp's ${COMMIT_STORE_SCHEMA_VERSION}: upgrade swamp`,
    );
  }
  if (facts.schemaVersion < 1 || facts.partitionHeads === undefined) {
    throw refuse(`${commitsDb} is not a v3 commit log`);
  }
  const marker = await v3MarkerState(datastorePath);
  if (marker === "v3") return markerPath;
  if (marker === "other") {
    throw refuse(`${markerPath} is not a marker a crash left blank`);
  }
  if (marker === "blank") {
    await removeBlankMarker(datastorePath, options.rename);
  }
  try {
    await writeDatastoreFormatMarker(datastorePath, {
      format: V3_DATASTORE_FORMAT,
      minReaderFormat: V3_DATASTORE_FORMAT,
      writtenBy,
    }, options);
  } catch (error) {
    // Another restore won the race: it wrote what this one would have.
    if (
      error instanceof UserError &&
      await v3MarkerState(datastorePath) === "v3"
    ) {
      return markerPath;
    }
    throw error;
  }
  return markerPath;
}

/**
 * another setup or restore may have replaced the blank marker, so move it aside
 * and delete it only if still blank; anything else is put back for the marker
 * write to find
 */
async function removeBlankMarker(
  datastorePath: string,
  rename: (from: string, to: string) => Promise<void> = Deno.rename,
): Promise<void> {
  const path = join(datastorePath, DATASTORE_FORMAT_MARKER_FILE);
  const aside = join(datastorePath, `.${crypto.randomUUID()}.tmp`);
  try {
    await rename(path, aside);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  const bytes = await Deno.readFile(aside);
  if (!isBlankDatastoreFormatMarker(bytes)) {
    // Another process's marker: put back without replacing one written
    // meanwhile, which then stands instead.
    try {
      await Deno.link(aside, path);
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) {
        // A filesystem without hard links: an exclusive create.
        await Deno.writeFile(path, bytes, { createNew: true }).catch(
          (createError) => {
            if (!(createError instanceof Deno.errors.AlreadyExists)) {
              throw createError;
            }
          },
        );
      }
    }
  }
  await Deno.remove(aside);
}

export async function v3MarkerState(
  datastorePath: string,
): Promise<"v3" | "absent" | "blank" | "other"> {
  const path = join(datastorePath, DATASTORE_FORMAT_MARKER_FILE);
  let bytes: Uint8Array;
  try {
    const info = await Deno.lstat(path);
    if (!info.isFile || info.size > DATASTORE_FORMAT_MARKER_MAX_BYTES) {
      return "other";
    }
    bytes = await Deno.readFile(path);
  } catch (error) {
    return error instanceof Deno.errors.NotFound ? "absent" : "other";
  }
  if (isBlankDatastoreFormatMarker(bytes)) return "blank";
  try {
    const marker = parseDatastoreFormatMarker(
      bytes,
      DATASTORE_FORMAT_MARKER_FILE,
    );
    return marker.format === V3_DATASTORE_FORMAT ? "v3" : "other";
  } catch {
    return "other";
  }
}

interface CommitLogFacts {
  readonly schemaVersion: number;
  readonly partitionHeads: number | undefined;
  readonly compactionPoint: number;
  /**
   * only what opening a new commits.db leaves before its schema transaction
   * commits; an unrelated SQLite file is neither
   */
  readonly unschemaed: boolean;
}

/**
 * opened read-write so SQLite recovers a write-ahead log a crash left, which a
 * read-only open refuses to do; its schema is never changed
 */
function readCommitLogFacts(path: string): CommitLogFacts {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const schemaVersion =
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version;
    const hasTable = (name: string) =>
      db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(name) !== undefined;
    const partitionHeads = hasTable("partition_heads")
      ? Number(
        (db.prepare("SELECT COUNT(*) AS n FROM partition_heads").get() as {
          n: number;
        }).n,
      )
      : undefined;
    const compactionPoint = hasTable("compaction")
      ? Number(
        (db.prepare("SELECT point FROM compaction WHERE id = 1").get() as
          | { point: number }
          | undefined)?.point ?? 0,
      )
      : 0;
    const get = (pragma: string) =>
      Object.values(db.prepare(pragma).get() as Record<string, unknown>)[0];
    const unschemaed = schemaVersion === 0 &&
      Number(get("SELECT COUNT(*) FROM sqlite_master")) === 0 &&
      (Number(get("PRAGMA page_count")) === 0 ||
        get("PRAGMA journal_mode") === "wal");
    return { schemaVersion, partitionHeads, compactionPoint, unschemaed };
  } finally {
    db.close();
  }
}

async function absentDirectories(dir: string): Promise<string[]> {
  const missing: string[] = [];
  for (let current = resolve(dir);; current = dirname(current)) {
    try {
      await Deno.lstat(current);
      return missing;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    missing.push(current);
    if (dirname(current) === current) return missing;
  }
}

/**
 * a catch-up the storage cut off changed nothing past what it applied, and the
 * next one finishes it
 */
export async function unreachableAsCatchUpError<T>(
  catchUp: () => Promise<T>,
): Promise<T> {
  try {
    return await catchUp();
  } catch (error) {
    if (
      error instanceof ReadModelApplyRefusedError ||
      (error instanceof ReadModelApplyError &&
        !(error instanceof CheckoutCopyAtRiskError) &&
        isNetworkFailure(error))
    ) {
      throw new ReadModelCatchUpUnreachableError(error);
    }
    throw error;
  }
}

/** the bound other v3 commits retry within; no knob of its own */
const DIRECT_APPEND_ATTEMPTS = 3;
const DIRECT_APPEND_BACKOFF_MS = 250;

/**
 * a commit that may have landed is retried too: it lands the same bytes again;
 * serve unreachable is not retried, as the run stops at that commit
 */
function isTransientAppendFailure(error: unknown): boolean {
  if (fromUnreachableServe(error)) return false;
  if (isNetworkFailure(error) || error instanceof MayLandLaterError) {
    return true;
  }
  if (error instanceof CommitRejectedError) return error.reason === "seq-gap";
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === V3_SERVE_UNREACHABLE_CODE ||
    code === V3_STORAGE_UNREACHABLE_CODE;
}

function fromUnreachableServe(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    if (
      (current as { code?: unknown } | undefined)?.code ===
        V3_SERVE_UNREACHABLE_CODE
    ) {
      return true;
    }
    if (!(current instanceof Error)) return false;
    current = current.cause;
  }
  return false;
}

function isStepStartChange(change: TypedChange): boolean {
  const intent = "put" in change
    ? change.put.intent
    : "intent" in change.op
    ? change.op.intent
    : undefined;
  return intent?.kind === "run-start.save" ||
    intent?.kind === "run-start.delete";
}
