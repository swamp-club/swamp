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

/** Shared repository execution locks and datastore publication lifecycle. */

import { withRunPhase } from "../../domain/remote/run_progress.ts";
import { dirname, isAbsolute, join, relative, SEPARATOR } from "@std/path";
import { hostname } from "node:os";
import { isProcessGone } from "../runtime/process.ts";
import {
  type RepositoryContext,
  writeCatalogExport,
} from "./repository_factory.ts";
import type { CatalogStore } from "./catalog_store.ts";
import { UserError } from "../../domain/errors.ts";
import {
  modelLockKey,
  workflowRunLockKey,
} from "../../domain/datastore/lock_key.ts";
import type { WorkflowRunClaims } from "../../domain/workflows/run_claim.ts";
import { isUuid } from "../../domain/models/model_lookup.ts";
import { ensureDir, exists, walk } from "@std/fs";
import { parse as parseYaml } from "@std/yaml";
import {
  flushDatastoreSyncNamed,
  registerDatastoreSyncNamed,
  SLOW_LOCK_NAMESPACE_ADVICE,
} from "./datastore_sync_coordinator.ts";
import { summarizeSyncError } from "./sync_error_diagnostic.ts";
import { FileLock } from "./file_lock.ts";
import {
  createDatastoreLock,
  datastoreGlobalLockOptions,
  resolveCustomProvider,
} from "./datastore_global_lock.ts";
import { SWAMP_SUBDIRS } from "./paths.ts";
import {
  type DistributedLock,
  type LockInfo,
  lockSkipping,
  lockStillNames,
  LockTimeoutError,
} from "../../domain/datastore/distributed_lock.ts";
import {
  type CustomDatastoreConfig,
  type DatastoreConfig,
  getDatastoreDirectories,
  isCustomDatastoreConfig,
  resolveDurableWrites,
  resolveLockTimeoutMs,
} from "../../domain/datastore/datastore_config.ts";
import { slowLockAdvice } from "../../domain/datastore/slow_lock_advice.ts";
import type { DatastoreProvider } from "../../domain/datastore/datastore_provider.ts";
import {
  DataVersionConflictError,
  type LostModelLock,
  ModelLockLostError,
  UnpublishedDataVersionError,
} from "../../domain/datastore/datastore_sync_service.ts";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
  PushManifest,
  SyncCapabilities,
  SyncContext,
  WrittenVersion,
} from "../../domain/datastore/datastore_sync_service.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  checkpointOpenUnitOfWork,
  runInRootUnitOfWork,
} from "./repo_unit_of_work.ts";
import {
  atomicWriteFile,
  type AtomicWriteSync,
  syncWrittenDirectory,
} from "./atomic_write.ts";
import {
  type PendingPublish,
  readPendingPublishes,
  recordPendingPublish,
  removePendingPublishes,
} from "./pending_publish_store.ts";
import { pushModelLockScope } from "./push_paths.ts";
import {
  type LentLocks,
  processLockHolderMarker,
} from "../../domain/datastore/lock_holder_marker.ts";
import { getSwampLogger, getSystemPipeWidth } from "../logging/logger.ts";
import { dim, yellow } from "@std/fmt/colors";
import {
  ensureSupportedDatastoreFormat,
  isV2CustomDatastore,
} from "./datastore_format_guard.ts";
import { lockingConfigOf } from "./datastore_lock_target.ts";
import { createServeLock, ServeLock } from "../datastore_v3/serve_lock.ts";
import {
  explicitLeaseOn,
  forgetExplicitLease,
} from "../datastore_v3/explicit_model_leases.ts";
import { serveOfflineAt } from "../datastore_v3/serve_offline.ts";
import { passOwnLockGate } from "../datastore_v3/own_lock_gate.ts";
import { WRITER_LEASE_CLOCK_SKEW_MS } from "../../domain/datastore_v3/writer_lease.ts";
import { catchUpV3HandlesAt } from "../datastore_v3/v3_repo_context.ts";

export type LockProgressWriter = (message: string) => void;

function labeledPrefix(label: string): string {
  const padded = label.padStart(getSystemPipeWidth() + 1);
  return dim(`${padded} │`);
}

let lockProgressQuiet = false;

export function setLockProgressQuiet(quiet: boolean): void {
  lockProgressQuiet = quiet;
}

// json mode has no console log output and a failing command's stderr must stay
// one JSON document, so progress is written in log mode only
let lockProgressJson = false;

export function setLockProgressJson(json: boolean): void {
  lockProgressJson = json;
}

const writeStderrLine = (line: string): void => console.error(line);

export function defaultLockWriter(message: string): void {
  createLockProgressWriter("system")(message);
}

export function createLockProgressWriter(
  label: string,
  writeStderr: (line: string) => void = writeStderrLine,
): LockProgressWriter {
  return (message: string) => {
    if (lockProgressQuiet || lockProgressJson) return;
    writeStderr(`${labeledPrefix(label)} ${message}`);
  };
}

/**
 * a first segment that merely starts with two dots (..hidden) is inside the
 * root; a cross-drive relative result on Windows is absolute
 */
export function escapesRoot(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${SEPARATOR}`) || isAbsolute(rel);
}

/**
 * a per-model lock is released as soon as its run finishes, so FileLock's 1s
 * default slept through releases; backoff doubles from here up to the max
 */
export const MODEL_LOCK_RETRY_INTERVAL_MS = 25;

/**
 * steps against one instance queue on its lock, and FileLock's 8s default left
 * the queue tail sleeping after each release; this cap keeps every waiter
 * within a quarter second of the holder letting go
 */
export const MODEL_LOCK_MAX_BACKOFF_MS = 250;

/**
 * other machines pick data versions from their own copies, so only serve's lock
 * keeps them and serve's runs apart; once held, the checkout catches up from
 * serve first
 */
function serveLockOf(
  config: DatastoreConfig,
  serveKey: string,
  displayKey: string,
  maxWaitMs: number,
  options?: ServeLockHoldOptions,
): DistributedLock | undefined {
  if (isCustomDatastoreConfig(config)) return undefined;
  const root = config.path;
  return createServeLock(root, {
    lockKey: serveKey,
    displayKey,
    maxWaitMs,
    onAcquired: () => catchUpV3HandlesAt(root),
    // registered while held, so the checkout's commits to the partition name
    // the lease
    root,
    ...(options?.onLost === undefined ? {} : { onLost: options.onLost }),
    // an explicit lease this checkout holds on the key is used, not asked for
    // again
    adopt: () => explicitLeaseOn(root, serveKey),
    forget: (leaseId) => forgetExplicitLease(root, leaseId),
    // offline the hold never asks serve: it uses the checkout's own lock and
    // the explicit lease it recorded while that lasts
    offline: () => {
      const state = serveOfflineAt(root);
      return state === undefined ? undefined : {
        ...(state.clockOffsetMs !== undefined
          ? { clockOffsetMs: state.clockOffsetMs }
          : {}),
        skewMs: WRITER_LEASE_CLOCK_SKEW_MS,
      };
    },
    // under an explicit lease serve no longer keeps the checkout's own commands
    // apart, so a lock local to the checkout does
    localLock: () =>
      new FileLock(root, {
        lockKey: `explicit-leases/${serveKey}`,
        maxWaitMs,
        retryIntervalMs: MODEL_LOCK_RETRY_INTERVAL_MS,
        maxBackoffMs: MODEL_LOCK_MAX_BACKOFF_MS,
      }),
  });
}

export interface ServeLockHoldOptions {
  /**
   * Called once when a fenced lease at serve lapses: the work under the
   * lock must stop. Never called for a local lock.
   */
  readonly onLost?: (error: Error) => void;
}

/**
 * creates the model's data directory and parents before the repository writes
 * under it; on durable datastores it syncs the parent of each directory it
 * creates
 */
/**
 * once serve's own run may take the lock: no lease the previous leader kept on
 * the behavior is still being adopted. A CLI process sets no gate, so never
 * waits
 */
async function ownLockAfterAdoption(
  modelType: string,
  modelId: string,
  create: () => Promise<DistributedLock>,
): Promise<DistributedLock> {
  await passOwnLockGate(
    modelLockKey(undefined, modelType, modelId),
    resolveLockTimeoutMs(),
  );
  return await create();
}

export async function createModelLock(
  datastoreConfig: DatastoreConfig,
  modelType: string,
  modelId: string,
  options?: ServeLockHoldOptions,
): Promise<DistributedLock> {
  const config = lockingConfigOf(datastoreConfig);
  const lockKey = modelLockKey(config.namespace, modelType, modelId);
  const maxWaitMs = resolveLockTimeoutMs();
  const atServe = serveLockOf(
    config,
    modelLockKey(undefined, modelType, modelId),
    lockKey,
    maxWaitMs,
    options,
  );
  if (atServe !== undefined) return atServe;
  if (isCustomDatastoreConfig(config)) {
    const provider = await resolveCustomProvider(config);
    return provider.createLock(config.datastorePath, { lockKey, maxWaitMs });
  }
  return new FileLock(config.path, {
    lockKey,
    maxWaitMs,
    retryIntervalMs: MODEL_LOCK_RETRY_INTERVAL_MS,
    maxBackoffMs: MODEL_LOCK_MAX_BACKOFF_MS,
    syncCreatedDirectories: resolveDurableWrites(datastoreConfig) &&
      (config.format !== 3 || mayKeepDataLocal(config)),
  });
}

/**
 * no commit replays data a datastore filter may keep local, so the model lock
 * syncs the directories it creates for it, as on v2; the lock has no data name,
 * so any exclude pattern counts
 */
function mayKeepDataLocal(config: DatastoreConfig): boolean {
  return !getDatastoreDirectories(config).includes(SWAMP_SUBDIRS.data) ||
    (config.exclude?.length ?? 0) > 0;
}

/**
 * a claim is held for one load, decision and save of the run record, so it uses
 * the per-model lock's short retry settings; a resume's take-over also restores
 * sensitive values, which can read a vault
 */
export async function createWorkflowRunLock(
  datastoreConfig: DatastoreConfig,
  runId: string,
): Promise<DistributedLock> {
  // The id becomes part of the lock's path. A run id is always a UUID.
  if (!isUuid(runId)) {
    throw new UserError(`Not a workflow run id: ${runId}`);
  }
  const config = lockingConfigOf(datastoreConfig);
  const lockKey = workflowRunLockKey(config.namespace, runId);
  const maxWaitMs = resolveLockTimeoutMs();
  const atServe = serveLockOf(
    config,
    workflowRunLockKey(undefined, runId),
    lockKey,
    maxWaitMs,
  );
  if (atServe !== undefined) return atServe;
  if (isCustomDatastoreConfig(config)) {
    const provider = await resolveCustomProvider(config);
    return provider.createLock(config.datastorePath, { lockKey, maxWaitMs });
  }
  return new FileLock(config.path, {
    lockKey,
    maxWaitMs,
    retryIntervalMs: MODEL_LOCK_RETRY_INTERVAL_MS,
    maxBackoffMs: MODEL_LOCK_MAX_BACKOFF_MS,
  });
}

export function createWorkflowRunClaims(
  config: DatastoreConfig,
): WorkflowRunClaims {
  return {
    withClaim: async (runId, fn) => {
      const lock = await createWorkflowRunLock(config, runId);
      return await lock.withLock(fn);
    },
  };
}

export interface ModelLockResult {
  /**
   * one remaining caller is the per-step model lock in a workflow run;
   * everything else pushes through a root unit of work with push and calls
   * release after the root ends
   */
  flush: (written?: readonly WrittenVersion[]) => Promise<void>;
  push: () => Promise<void>;
  /**
   * push, given the versions its work wrote: publishes each and checks the
   * remote holds it, retrying a bounded number of times. A root calls its flush
   * with its outcome, so pass this through a closure
   */
  pushWritten: (written: readonly WrittenVersion[]) => Promise<void>;
  release: () => Promise<void>;
  /**
   * false when every pull reported 0 files, which spares a full catalog
   * backfill while the lock is held
   */
  synced: boolean;
  /**
   * a snapshot taken at acquisition: a re-key changes the nonces, so never hand
   * this list to a child; use lentLocks
   */
  heldLockIds: readonly string[];
  lentLocks: LentLocks;
  leaseLost?: AbortSignal;
}

/**
 * a refusal fails the step since its writes were not taken under the lease; any
 * other failure is warned about and the run's end commit tries again
 */
async function checkpointStepUnderLease(
  repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">,
): Promise<void> {
  let outcome: Awaited<ReturnType<typeof checkpointOpenUnitOfWork>>;
  try {
    outcome = await checkpointOpenUnitOfWork(repoContext);
  } catch (error) {
    getSwampLogger(["cli", "lock"])
      .warn`Could not commit this step's writes before releasing its lock at serve; the run's end commit tries again: ${error}`;
    return;
  }
  if (outcome === "refused") {
    throw new UserError(
      "Serve refused this step's writes while it held the behavior's lock: " +
        "the lease may have lapsed. See 'swamp datastore lock status'",
    );
  }
}

export interface ReclaimModelLocksOptions {
  timeoutMs?: number;
  pollMs?: number;
  progressWriter?: LockProgressWriter;
  displayKey?: string;
  isProcessDead?: (pid: number) => boolean;
  signal?: AbortSignal;
}

function pollDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * re-keys each lock so a nested swamp left by the hop no longer matches; waits
 * while a structural command's skipped list names a retired nonce; on timeout
 * the caller must write nothing
 */
export async function reclaimModelLocks(
  locks: readonly FileLock[],
  globalLock: Pick<DistributedLock, "inspect">,
  options: ReclaimModelLocksOptions = {},
): Promise<void> {
  const retired: string[] = [];
  for (const lock of locks) {
    const nonce = await lock.rekey();
    if (nonce !== undefined) retired.push(nonce);
  }
  if (retired.length === 0) return;

  const write = options.progressWriter ?? defaultLockWriter;
  const timeoutMs = options.timeoutMs ?? resolveLockTimeoutMs();
  const processDead = options.isProcessDead ?? isProcessGone;
  const start = Date.now();
  let announced = false;
  await withRunPhase("waiting_for_lock", {
    resource: options.displayKey ?? ".datastore.lock",
  }, async () => {
    while (true) {
      const info = await globalLock.inspect();
      if (!info) break;
      if (Date.now() - new Date(info.acquiredAt).getTime() > info.ttlMs) break;
      // a structural command killed with its hop (a shell step's timeout kills
      // the whole process tree) leaves its lock behind until the ttl
      if (info.hostname === hostname() && processDead(info.pid)) break;
      // a lock file caught mid-write is reported held with no nonce and no
      // list; read it again rather than take a working structural command for
      // one that skipped nothing
      const unreadable = info.nonce === undefined && info.pid === 0;
      const skipping = lockSkipping(info);
      if (!unreadable && !retired.some((nonce) => skipping.has(nonce))) break;
      if (!unreadable && options.signal?.aborted) {
        throw new DOMException(
          `Cancelled while a structural command held by ${info.holder} (pid ${info.pid}) was still working under a lock this run handed down`,
          "AbortError",
        );
      }
      if (!announced && !unreadable) {
        announced = true;
        write(
          yellow(
            `A structural command held by ${info.holder} (pid ${info.pid}) is still working under a lock this run handed down — waiting for it to finish...`,
          ),
        );
      }
      const elapsed = Date.now() - start;
      if (elapsed >= timeoutMs) {
        throw new LockTimeoutError(
          options.displayKey ?? ".datastore.lock",
          info,
          elapsed,
        );
      }
      await pollDelay(options.pollMs ?? 500, options.signal);
    }
  });
  if (announced) {
    write(dim("Structural command finished, proceeding"));
  }
}

/**
 * push-alone is the last publish attempt of a push whose earlier attempts other
 * syncs undid; it must not run alongside any other sync
 */
export type SyncCallWrapper = <T>(
  fn: () => Promise<T>,
  kind: "pull" | "push" | "push-alone",
) => Promise<T>;

export interface AcquireModelLocksOptions {
  /**
   * wraps only the step-start pull and the push inside flush, never lock waits
   * or release, so a caller never holds what the wrapper acquires while waiting
   * on a model lock. Serve passes its shared sync gate
   */
  wrapSync?: SyncCallWrapper;
  /**
   * another sync in this process can undo a push by clearing dirty marks early
   * or pulling an older latest marker, so a push given versions re-stages them
   * and reads them back, repeating while missing or behind
   */
  repoContext?: Pick<
    RepositoryContext,
    "markDirty" | "commitLog" | "unifiedDataRepo"
  >;
  restoreWriteHooks?: AtomicWriteSync;
  /**
   * false takes the locks without pulling; the push then cannot tell a
   * same-numbered version another clone wrote from its own, so it publishes
   * every version as this host holds it
   */
  pull?: boolean;
  failIfBusy?: boolean;
}

/**
 * long enough for one retry, short enough that the run is never held up by a
 * writer
 */
export const READ_PUBLISH_LOCK_WAIT_MS = 2_000;

class ModelLocksBusyError extends Error {
  constructor(lockKey: string) {
    super(`${lockKey} is held by another run`);
    this.name = "ModelLocksBusyError";
  }
}

export const PUBLISH_ATTEMPTS = 3;

export const PUBLISH_CHECK_FETCH_TIMEOUT_MS = 30_000;

function cacheRelativePath(
  cachePath: string,
  absPath: string,
): string | undefined {
  const rel = relative(cachePath, absPath);
  if (escapesRoot(rel)) return undefined;
  return SEPARATOR === "/" ? rel : rel.split(SEPARATOR).join("/");
}

interface PublishTarget {
  readonly written: WrittenVersion;
  readonly metadataRel: string;
  readonly latestRel: string;
}

/**
 * staging runs in a root unit of work with no push: inside a command's root it
 * rolls up into that root, and after the root has ended it reaches the mark
 * hook on its own
 */
async function stageVersionsForPublish(
  written: readonly WrittenVersion[],
  repoContext: Pick<
    RepositoryContext,
    "markDirty" | "commitLog" | "unifiedDataRepo"
  >,
  cachePath: string,
): Promise<PublishTarget[]> {
  const byName = new Map<string, WrittenVersion[]>();
  for (const w of written) {
    const key = JSON.stringify([w.modelType, w.modelId, w.dataName]);
    const list = byName.get(key);
    if (list) list.push(w);
    else byName.set(key, [w]);
  }
  return await runInRootUnitOfWork(
    repoContext,
    { flush: undefined },
    async () => {
      const targets: PublishTarget[] = [];
      for (const versions of byName.values()) {
        const descending = [...versions].sort((a, b) => b.version - a.version);
        for (const w of descending) {
          const paths = await repoContext.unifiedDataRepo
            .reassertLatestVersion(
              ModelType.create(w.modelType),
              w.modelId,
              w.dataName,
              w.version,
            );
          if (paths === undefined) continue;
          const dirRel = cacheRelativePath(cachePath, paths.versionDir);
          const latestRel = cacheRelativePath(cachePath, paths.latestPath);
          if (dirRel !== undefined && latestRel !== undefined) {
            targets.push({
              written: w,
              metadataRel: `${dirRel}/metadata.yaml`,
              latestRel,
            });
          } else {
            getSwampLogger(["datastore", "lock"])
              .debug`Version ${w.version} of ${w.dataName} is outside the datastore cache; not checked`;
          }
          break;
        }
      }
      return targets;
    },
  );
}

export const DISCARD_RESTORE_TIMEOUT_MS = 10_000;

interface DiscardRestoreOptions {
  readonly sync: AtomicWriteSync | undefined;
  readonly lazy: boolean;
}

interface FetchedMarker {
  readonly rel: string;
  readonly nameDir: string;
  readonly bytes: Uint8Array;
  readonly version: number | undefined;
}

/**
 * a removed file stays marked dirty and extensions push it as a delete of the
 * remote copy, so each removed file and latest marker is put back as the
 * datastore holds it; best effort, the refusal stands
 */
async function discardRefusedVersions(
  refused: readonly WrittenVersion[],
  repoContext: Pick<
    RepositoryContext,
    "markDirty" | "commitLog" | "unifiedDataRepo"
  >,
  syncService: DatastoreSyncService,
  cachePath: string,
  namespace: string | undefined,
  restore: DiscardRestoreOptions,
): Promise<void> {
  const logger = getSwampLogger(["datastore", "lock"]);
  const repo = repoContext.unifiedDataRepo;
  const content = new Set<string>();
  const markers = new Map<string, string>();
  const owner = new Map<string, string>();
  const marked = new Map<string, Set<string>>();
  const names = new Map<string, string>();
  const markedUnder = (nameDir: string, rel: string | undefined) => {
    if (rel === undefined) return;
    owner.set(rel, nameDir);
    let rels = marked.get(nameDir);
    if (rels === undefined) marked.set(nameDir, rels = new Set());
    rels.add(rel);
  };
  const failed = new Set<string>();
  const failOwnerOf = (rel: string) => {
    const nameDir = owner.get(rel);
    if (nameDir !== undefined) failed.add(nameDir);
  };
  let discarded = true;
  try {
    await runInRootUnitOfWork(repoContext, { flush: undefined }, async () => {
      for (const w of refused) {
        const type = ModelType.create(w.modelType);
        const versionDir = repo.getPath(type, w.modelId, w.dataName, w.version);
        const nameDir = repo.getDataNameDir(type, w.modelId, w.dataName);
        names.set(nameDir, `${w.modelType}/${w.modelId}/${w.dataName}`);
        try {
          for await (const entry of walk(versionDir, { includeDirs: false })) {
            const rel = cacheRelativePath(cachePath, entry.path);
            if (rel !== undefined) content.add(rel);
            markedUnder(nameDir, rel);
          }
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        const latestRel = cacheRelativePath(cachePath, join(nameDir, "latest"));
        if (latestRel !== undefined) markers.set(latestRel, nameDir);
        markedUnder(nameDir, latestRel);
        markedUnder(nameDir, cacheRelativePath(cachePath, versionDir));
        markedUnder(nameDir, cacheRelativePath(cachePath, nameDir));
        await repo.delete(type, w.modelId, w.dataName, w.version);
      }
    });
  } catch (error) {
    discarded = false;
    logger.debug`Discarding the refused data versions failed: ${error}`;
  }
  if (!syncService.clearDirty && marked.size > 0) {
    const kept = [...marked.keys()].map((nameDir) => names.get(nameDir))
      .join(", ");
    logger
      .warn`This datastore's extension cannot clear the dirty marks the refused push left on ${kept}, so a later push from this checkout can delete or overwrite the versions the other run wrote there (swamp-club#4091). Updating the datastore extension fixes this once a release implements clearDirty.`;
  }
  const fetchContent = syncService.fetchContent;
  if (!fetchContent || (content.size === 0 && markers.size === 0)) return;
  const signal = AbortSignal.timeout(DISCARD_RESTORE_TIMEOUT_MS);
  const hasMetadata = (nameDir: string, version: number) =>
    exists(join(nameDir, String(version), "metadata.yaml"));
  const write = async (rel: string, bytes: Uint8Array, syncParent: boolean) => {
    const absPath = join(cachePath, ...rel.split("/"));
    await ensureDir(dirname(absPath));
    await atomicWriteFile(
      absPath,
      bytes,
      restore.sync ? { sync: { ...restore.sync, syncParent } } : undefined,
    );
    return absPath;
  };

  const fetched: FetchedMarker[] = [];
  for (const [rel, nameDir] of markers) {
    let bytes: Uint8Array | null;
    try {
      bytes = await fetchContent(rel, { namespace, signal });
    } catch (error) {
      failed.add(nameDir);
      logger
        .debug`Restoring from the datastore after a refused push failed reading ${rel}: ${error}`;
      continue;
    }
    if (bytes === null) {
      if (await exists(join(nameDir, "latest")).catch(() => true)) {
        failed.add(nameDir);
      }
      continue;
    }
    const named = parseInt(new TextDecoder().decode(bytes).trim(), 10);
    const version = Number.isInteger(named) && named > 0 ? named : undefined;
    fetched.push({ rel, nameDir, bytes, version });
    if (version === undefined || await hasMetadata(nameDir, version)) continue;
    const dirRel = cacheRelativePath(cachePath, join(nameDir, String(version)));
    if (dirRel === undefined) continue;
    content.add(`${dirRel}/metadata.yaml`);
    owner.set(`${dirRel}/metadata.yaml`, nameDir);
    if (!restore.lazy) {
      content.add(`${dirRel}/raw`);
      owner.set(`${dirRel}/raw`, nameDir);
    }
  }

  const versionDirs = new Set<string>();
  const pending = [...content];
  for (const [i, rel] of pending.entries()) {
    try {
      const bytes = await fetchContent(rel, { namespace, signal });
      if (bytes === null) continue;
      versionDirs.add(dirname(await write(rel, bytes, false)));
    } catch (error) {
      for (const left of pending.slice(i)) failOwnerOf(left);
      logger.debug`Restoring ${
        pending.length - i
      } file(s) from the datastore after a refused push failed at ${rel}: ${error}`;
      break;
    }
  }

  if (restore.sync) {
    const dataRoot = join(cachePath, "data");
    const dirs = new Set<string>();
    for (const versionDir of versionDirs) {
      for (let dir = versionDir;; dir = dirname(dir)) {
        dirs.add(dir);
        if (dir === dataRoot || dir === cachePath || dirname(dir) === dir) {
          break;
        }
      }
    }
    // Deepest first, so each entry is durable before its parent's sync.
    const ordered = [...dirs].sort((a, b) =>
      b.split(SEPARATOR).length - a.split(SEPARATOR).length
    );
    try {
      for (const dir of ordered) await syncWrittenDirectory(dir, restore.sync);
    } catch (error) {
      for (const nameDir of marked.keys()) failed.add(nameDir);
      logger
        .debug`Syncing the data restored after a refused push failed: ${error}`;
    }
  }

  for (const marker of fetched) {
    if (
      marker.version !== undefined &&
      !(await hasMetadata(marker.nameDir, marker.version))
    ) {
      logger
        .debug`Restoring ${marker.rel} naming version ${marker.version}, which is not in the cache; the next pull fetches it`;
    }
    try {
      await write(marker.rel, marker.bytes, true);
    } catch (error) {
      failed.add(marker.nameDir);
      logger
        .debug`Restoring ${marker.rel} after a refused push failed: ${error}`;
    }
  }

  const clearDirty = syncService.clearDirty;
  if (!clearDirty || !discarded) return;
  const cleared: string[] = [];
  for (const [nameDir, rels] of marked) {
    if (failed.has(nameDir)) continue;
    for (const rel of rels) cleared.push(rel);
  }
  if (cleared.length === 0) return;
  try {
    await clearDirty.call(syncService, cleared);
  } catch (error) {
    logger
      .debug`Clearing the marks a refused push left failed: ${error}`;
  }
}

/**
 * the local copy is moved out first and put back if the read fails, never left
 * missing: a push deletes the remote copy of a marked file missing here. Throws
 * so nothing overwrites the datastore's copy
 */
async function rehydrateContent(
  absPath: string,
  syncService: DatastoreSyncService,
  cachePath: string,
  namespace: string | undefined,
): Promise<void> {
  const rel = cacheRelativePath(cachePath, absPath);
  if (rel === undefined) return;
  const options = () => ({
    namespace,
    signal: AbortSignal.timeout(PUBLISH_CHECK_FETCH_TIMEOUT_MS),
  });
  let present: boolean;
  if (syncService.fetchContent) {
    const bytes = await syncService.fetchContent(rel, options());
    present = bytes !== null;
    if (bytes !== null) await atomicWriteFile(absPath, bytes);
  } else if (syncService.hydrateFile) {
    present = await hydrateOverLocal(
      absPath,
      rel,
      cachePath,
      syncService.hydrateFile.bind(syncService),
      options(),
    );
  } else {
    throw new Error(
      `Cannot read ${rel} back from the datastore, so the push is withheld`,
    );
  }
  if (present) return;
  try {
    await Deno.remove(absPath);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function hydrateOverLocal(
  absPath: string,
  rel: string,
  cachePath: string,
  hydrateFile: NonNullable<DatastoreSyncService["hydrateFile"]>,
  options: DatastoreSyncOptions,
): Promise<boolean> {
  const aside = `${cachePath}.rehydrate-${crypto.randomUUID()}`;
  let moved = false;
  try {
    await Deno.rename(absPath, aside);
    moved = true;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const restore = async () => {
    if (moved) await Deno.rename(aside, absPath);
  };
  let present: boolean;
  try {
    present = await hydrateFile(rel, options);
  } catch (error) {
    await restore();
    throw error;
  }
  if (present && !await exists(absPath)) {
    await restore();
    throw new Error(
      `The datastore reported reading ${rel} back but wrote no file, so the push is withheld`,
    );
  }
  if (moved) await Deno.remove(aside);
  return present;
}

async function localDataIds(
  versions: readonly WrittenVersion[],
  repo: RepositoryContext["unifiedDataRepo"],
  options: { strict?: boolean } = {},
): Promise<Array<{ written: WrittenVersion; localId: string | undefined }>> {
  const present: Array<
    { written: WrittenVersion; localId: string | undefined }
  > = [];
  for (const w of versions) {
    let parsed: unknown;
    try {
      parsed = parseYaml(
        await Deno.readTextFile(
          join(
            repo.getPath(
              ModelType.create(w.modelType),
              w.modelId,
              w.dataName,
              w.version,
            ),
            "metadata.yaml",
          ),
        ),
      );
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      if (options.strict) throw error;
      getSwampLogger(["datastore", "lock"])
        .debug`Skipping deferred ${w.dataName} version ${w.version}: ${error}`;
      continue;
    }
    const id = typeof parsed === "object" && parsed !== null
      ? (parsed as { id?: unknown }).id
      : undefined;
    present.push({
      written: w,
      localId: typeof id === "string" ? id : undefined,
    });
  }
  return present;
}

const PUBLISH_CHECK_CONCURRENCY = 8;

/**
 * a push that cannot be checked counts as unverified, not lost, so an
 * unreachable remote never fails work whose push succeeded
 */
async function unpublishedTargets(
  targets: readonly PublishTarget[],
  fetchContent: NonNullable<DatastoreSyncService["fetchContent"]>,
  namespace: string | undefined,
): Promise<PublishTarget[] | undefined> {
  const options = () => ({
    namespace,
    signal: AbortSignal.timeout(PUBLISH_CHECK_FETCH_TIMEOUT_MS),
  });
  const isBehind = async (target: PublishTarget): Promise<boolean> => {
    const metadata = await fetchContent(target.metadataRel, options());
    if (metadata === null) return true;
    const latest = await fetchContent(target.latestRel, options());
    if (latest === null) return true;
    const remoteLatest = parseInt(new TextDecoder().decode(latest).trim(), 10);
    return isNaN(remoteLatest) || remoteLatest < target.written.version;
  };
  const behind: PublishTarget[] = [];
  try {
    for (let i = 0; i < targets.length; i += PUBLISH_CHECK_CONCURRENCY) {
      const batch = targets.slice(i, i + PUBLISH_CHECK_CONCURRENCY);
      const results = await Promise.all(batch.map(isBehind));
      batch.forEach((target, j) => {
        if (results[j]) behind.push(target);
      });
    }
  } catch (error) {
    getSwampLogger(["datastore", "lock"]).warn(
      "Could not check the datastore holds the pushed data versions: {error}",
      { error: error instanceof Error ? error.message : String(error) },
    );
    return undefined;
  }
  return behind;
}

/**
 * a lock that reads nothing, is still being written, or cannot be read gives
 * undefined: its push is not checked, rather than refused for a backend that
 * cannot report
 */
async function readTakenLock(
  lock: DistributedLock,
): Promise<LockInfo | undefined> {
  try {
    const info = await lock.inspect();
    return info === null || info.holderUnknown ? undefined : info;
  } catch {
    return undefined;
  }
}

/**
 * without deleting it, the wait loops only break past a stale lock and the
 * post-acquire recheck re-detects it, retrying forever; failures are swallowed
 * since the wait timeout still bounds the wait
 */
async function tryForceReleaseStaleLock(
  lock: DistributedLock,
  info: LockInfo,
): Promise<void> {
  if (!info.nonce) return;
  const logger = getSwampLogger(["datastore", "lock"]);
  try {
    await lock.forceRelease(info.nonce);
  } catch (error) {
    logger.debug(
      "Best-effort forceRelease of stale global lock failed: {error}",
      { error: error instanceof Error ? error.message : String(error) },
    );
  }
}

function pullModelData(
  syncService: DatastoreSyncService,
  config: DatastoreConfig,
  caps: SyncCapabilities | undefined,
  modelType: string,
  modelId: string,
) {
  const ns = isCustomDatastoreConfig(config) ? config.namespace : undefined;
  if (caps?.scopedSync) {
    const context: SyncContext = { models: [{ modelType, modelId }] };
    return syncService.pullChanged({
      context,
      ...(ns ? { namespace: ns } : {}),
    });
  }
  if (ns) return syncService.pullChanged({ namespace: ns });
  return syncService.pullChanged();
}

async function waitForGlobalLockRelease(
  globalLock: DistributedLock,
  config: DatastoreConfig,
  write: LockProgressWriter,
  next: string,
): Promise<void> {
  const globalInfo = await globalLock.inspect();
  if (globalInfo) {
    write(
      yellow(
        `Global lock held by ${globalInfo.holder} — waiting for structural command to finish...`,
      ),
    );
    // timeout after 2x TTL prevents indefinite hangs if staleness detection
    // fails (clock skew, S3 consistency)
    const globalWaitStart = Date.now();
    const globalMaxWaitMs = (globalInfo.ttlMs ?? 30_000) * 2;
    await withRunPhase(
      "waiting_for_lock",
      { resource: ".datastore.lock" },
      async () => {
        while (true) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          const info = await globalLock.inspect();
          if (!info) break;
          const acquiredAt = new Date(info.acquiredAt).getTime();
          if (Date.now() - acquiredAt > info.ttlMs) {
            write(
              dim(
                `Global lock held by ${info.holder} appears stale (exceeded TTL of ${info.ttlMs}ms) — proceeding`,
              ),
            );
            await tryForceReleaseStaleLock(globalLock, info);
            break;
          }
          const globalElapsed = Date.now() - globalWaitStart;
          if (globalElapsed >= globalMaxWaitMs) {
            const lockOpts = datastoreGlobalLockOptions(config);
            const displayKey = lockOpts?.namespace
              ? `${lockOpts.namespace}/.datastore.lock`
              : ".datastore.lock";
            throw new LockTimeoutError(
              displayKey,
              info,
              globalElapsed,
            );
          }
        }
      },
    );
    write(
      dim(`Global lock released, proceeding with ${next}`),
    );
  }
}

/**
 * a lock past its TTL is force-released, as the waiting path does, so a crashed
 * structural command does not hold such runs off until a waiting run clears it
 */
async function liveGlobalLockHolder(
  globalLock: DistributedLock,
  write: LockProgressWriter,
): Promise<LockInfo | undefined> {
  const info = await globalLock.inspect();
  if (!info) return undefined;
  if (Date.now() - new Date(info.acquiredAt).getTime() > info.ttlMs) {
    write(
      dim(
        `Global lock held by ${info.holder} appears stale (exceeded TTL of ${info.ttlMs}ms) — proceeding`,
      ),
    );
    await tryForceReleaseStaleLock(globalLock, info);
    return undefined;
  }
  return info;
}

/**
 * never waits and never fails the run: while a structural command holds the
 * global lock or the pull fails, the run uses this host's cache and its publish
 * check still refuses another clone's version
 */
export async function pullModelsUnlocked(
  config: DatastoreConfig,
  models: Array<{ modelType: string; modelId: string }>,
  repoDir: string,
  syncService: DatastoreSyncService | undefined,
  options?: {
    wrapSync?: SyncCallWrapper;
    progressWriter?: LockProgressWriter;
  },
): Promise<boolean> {
  if (
    !syncService || !isCustomDatastoreConfig(config) ||
    !isV2CustomDatastore(config)
  ) {
    return false;
  }
  await ensureSupportedDatastoreFormat(repoDir, config);
  const write = options?.progressWriter ?? defaultLockWriter;
  const wrapSync: SyncCallWrapper = options?.wrapSync ?? ((fn) => fn());
  const useCache = (error: unknown) => {
    getSwampLogger(["datastore", "sync"])
      .warn`Could not pull from the datastore, so this run uses this host's data: ${error}`;
  };
  // a read never waits on a structural command: it runs on this host's cache
  // instead
  let globalInfo: LockInfo | undefined;
  let provider: DatastoreProvider;
  try {
    provider = await resolveCustomProvider(config);
    globalInfo = await liveGlobalLockHolder(
      provider.createLock(config.datastorePath, {
        ...datastoreGlobalLockOptions(config),
        maxWaitMs: resolveLockTimeoutMs(),
      }),
      write,
    );
  } catch (error) {
    useCache(error);
    return false;
  }
  if (globalInfo) {
    write(
      dim(
        `Global lock held by ${globalInfo.holder} — running on this host's data without pulling`,
      ),
    );
    return false;
  }
  let caps: SyncCapabilities | undefined;
  try {
    caps = syncService.capabilities?.();
  } catch {
    // Buggy extension — degrade to full sync
  }
  let synced = false;
  for (const { modelType, modelId } of models) {
    try {
      // a run on this host holding the behavior's lock writes unpublished files
      // into this cache that a pull would overwrite, so use this host's data; a
      // holder elsewhere does not write here
      const holder = await provider.createLock(config.datastorePath, {
        lockKey: modelLockKey(config.namespace, modelType, modelId),
        maxWaitMs: resolveLockTimeoutMs(),
      }).inspect();
      if (holder?.hostname === hostname()) {
        write(
          dim(
            `Behavior ${modelType}/${modelId} is locked by ${holder.holder} — running on this host's data without pulling`,
          ),
        );
        continue;
      }
      write(dim(`Syncing behavior ${modelType}/${modelId} from datastore...`));
      const pulled = await wrapSync(
        () => pullModelData(syncService, config, caps, modelType, modelId),
        "pull",
      );
      // 0 means the local cache is unchanged; void means unknown.
      if (pulled !== 0) synced = true;
    } catch (error) {
      useCache(error);
      // A pull that failed part-way may have written some files.
      return true;
    }
  }
  return synced;
}

/**
 * when another run holds the locks, records the versions for the next run on
 * this host to publish and returns undefined, so a writer never holds the run
 * up; a nested run defers to its parent's push
 */
export async function acquirePublishLocksOrDefer(
  config: DatastoreConfig,
  model: { modelType: string; modelId: string },
  written: readonly WrittenVersion[],
  repoDir: string,
  syncService: DatastoreSyncService | undefined,
  catalogStore: CatalogStore | undefined,
  options: Pick<AcquireModelLocksOptions, "wrapSync" | "repoContext">,
): Promise<ModelLockResult | undefined> {
  try {
    const locks = await acquireModelLocks(
      config,
      [model],
      repoDir,
      syncService,
      catalogStore,
      undefined,
      {
        ...options,
        // The pull replaces each version another clone also wrote with its
        // copy; the push reports those as a conflict and publishes the rest.
        failIfBusy: true,
      },
    );
    if (locks.synced) catalogStore?.invalidate();
    return locks;
  } catch (error) {
    if (
      !(error instanceof ModelLocksBusyError) ||
      !isCustomDatastoreConfig(config) || !config.cachePath
    ) {
      throw error;
    }
    getSwampLogger(["datastore", "lock"])
      .debug`Deferring the publish of ${written.length} data version(s): ${error.message}`;
    // Only the locked model's versions: a record naming another's would
    // wait for a lock that holds both, which no method run takes.
    await recordPendingPublish(
      config.cachePath,
      written.filter((w) =>
        w.modelType === model.modelType && w.modelId === model.modelId
      ),
    );
    return undefined;
  }
}

export async function acquireModelLocks(
  config: DatastoreConfig,
  models: Array<{ modelType: string; modelId: string }>,
  repoDir?: string,
  /**
   * normally supplied by the caller so one instance handles both the markDirty
   * hook and the watermark read; omit only when no separate markDirty hook will
   * race this instance
   */
  syncService?: DatastoreSyncService,
  /**
   * reuses the repo context's SQLite handle instead of opening a second one,
   * avoiding lock contention on _catalog.db
   */
  catalogStore?: CatalogStore,
  progressWriter?: LockProgressWriter,
  options?: AcquireModelLocksOptions,
): Promise<ModelLockResult> {
  const write = progressWriter ?? defaultLockWriter;
  const leaseLost = new AbortController();
  const logger = getSwampLogger(["datastore", "lock"]);
  const wrapSync: SyncCallWrapper = options?.wrapSync ?? ((fn) => fn());
  let synced = false;

  await ensureSupportedDatastoreFormat(repoDir ?? ".", config);

  let customProvider: DatastoreProvider | undefined;
  let customSyncService = syncService;
  if (isCustomDatastoreConfig(config) && isV2CustomDatastore(config)) {
    customProvider = await resolveCustomProvider(config);
    if (!customSyncService && config.cachePath) {
      customSyncService = customProvider.createSyncService?.(
        repoDir ?? ".",
        config.cachePath,
      );
    }
  }

  // the inspected key must match the namespaced key the structural command
  // acquires, or the symmetric drain coordinates against the wrong lock; custom
  // types use the cached provider so all locks share one instance
  const globalLock = customProvider && isCustomDatastoreConfig(config)
    ? customProvider.createLock(
      config.datastorePath,
      {
        ...datastoreGlobalLockOptions(config),
        maxWaitMs: resolveLockTimeoutMs(),
      },
    )
    : await createDatastoreLock(config);
  if (options?.failIfBusy) {
    // Never waits; the re-check after each lock below throws busy too.
    if (await liveGlobalLockHolder(globalLock, write)) {
      throw new ModelLocksBusyError(".datastore.lock");
    }
  } else {
    await waitForGlobalLockRelease(
      globalLock,
      config,
      write,
      "per-model locks",
    );
  }

  // sorted for deterministic lock ordering, to prevent deadlock
  const sorted = [...models].sort((a, b) => {
    const keyA = `${a.modelType}/${a.modelId}`;
    const keyB = `${b.modelType}/${b.modelId}`;
    return keyA.localeCompare(keyB);
  });

  const seen = new Set<string>();
  const unique = sorted.filter((m) => {
    const key = `${m.modelType}/${m.modelId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const lockKeys: string[] = [];
  const heldLocks: DistributedLock[] = [];
  const heldLockModels: Array<{ modelType: string; modelId: string }> = [];
  const heldLockTaken: Array<LockInfo | undefined> = [];
  // A v3 context fences its own writer; a filesystem datastore has no push.
  const checkLocks = customSyncService !== undefined &&
    isCustomDatastoreConfig(config) &&
    options?.repoContext?.commitLog === undefined;

  const release = async () => {
    for (const key of lockKeys) {
      await flushDatastoreSyncNamed(key);
    }
  };

  let caps: SyncCapabilities | undefined;
  if (customSyncService) {
    try {
      caps = customSyncService.capabilities?.();
    } catch {
      // Buggy extension — degrade to full sync
    }
  }

  const pullModel = (
    syncService: DatastoreSyncService,
    modelType: string,
    modelId: string,
  ) => pullModelData(syncService, config, caps, modelType, modelId);

  // all or nothing: without this unwind a throw below leaves every lock taken
  // so far held until the process exits
  try {
    for (const { modelType, modelId } of unique) {
      const lockFileKey = modelLockKey(config.namespace, modelType, modelId);
      const lock = customProvider && isCustomDatastoreConfig(config)
        ? customProvider.createLock(config.datastorePath, {
          lockKey: lockFileKey,
          maxWaitMs: options?.failIfBusy
            ? READ_PUBLISH_LOCK_WAIT_MS
            : resolveLockTimeoutMs(),
        })
        : await ownLockAfterAdoption(
          modelType,
          modelId,
          () =>
            createModelLock(config, modelType, modelId, {
              onLost: (error) => leaseLost.abort(error),
            }),
        );
      // unique coordinator key so parallel steps on the same model do not
      // overwrite each other's registration and orphan the first lock
      const coordinatorKey = `${lockFileKey}#${
        crypto.randomUUID().slice(0, 8)
      }`;
      await registerDatastoreSyncNamed(coordinatorKey, {
        lock,
        namespace: config.namespace,
        slowLockScope: {
          scope: { kind: "model", modelType, modelId },
          shareable: isCustomDatastoreConfig(config),
        },
      });
      lockKeys.push(coordinatorKey);
      heldLocks.push(lock);
      heldLockModels.push({ modelType, modelId });
      heldLockTaken.push(checkLocks ? await readTakenLock(lock) : undefined);

      // re-check the global lock after each per-model acquire to close a TOCTOU
      // race: if a structural command took it meanwhile, release everything and
      // wait
      const postAcquireGlobalInfo = options?.failIfBusy
        ? await liveGlobalLockHolder(globalLock, write)
        : await globalLock.inspect();
      if (postAcquireGlobalInfo && options?.failIfBusy) {
        throw new ModelLocksBusyError(".datastore.lock");
      }
      if (postAcquireGlobalInfo) {
        write(
          dim(
            `Global lock acquired by ${postAcquireGlobalInfo.holder} during per-model lock acquisition — releasing and retrying`,
          ),
        );
        await release();
        lockKeys.length = 0;
        heldLocks.length = 0;
        heldLockModels.length = 0;
        heldLockTaken.length = 0;

        const retryWaitStart = Date.now();
        const retryMaxWaitMs = (postAcquireGlobalInfo.ttlMs ?? 30_000) * 2;
        await withRunPhase(
          "waiting_for_lock",
          { resource: ".datastore.lock" },
          async () => {
            while (true) {
              await new Promise((resolve) => setTimeout(resolve, 1_000));
              const info = await globalLock.inspect();
              if (!info) break;
              const acquiredAt = new Date(info.acquiredAt).getTime();
              if (Date.now() - acquiredAt > info.ttlMs) {
                write(
                  dim(
                    `Global lock held by ${info.holder} appears stale (exceeded TTL of ${info.ttlMs}ms) — proceeding`,
                  ),
                );
                await tryForceReleaseStaleLock(globalLock, info);
                break;
              }
              const retryElapsed = Date.now() - retryWaitStart;
              if (retryElapsed >= retryMaxWaitMs) {
                const retryLockOpts = datastoreGlobalLockOptions(config);
                const retryDisplayKey = retryLockOpts?.namespace
                  ? `${retryLockOpts.namespace}/.datastore.lock`
                  : ".datastore.lock";
                throw new LockTimeoutError(
                  retryDisplayKey,
                  info,
                  retryElapsed,
                );
              }
            }
          },
        );

        // restart with the shared sync service; the retry's pulls of
        // already-pulled models report 0, so carry synced forward or the caller
        // would skip catalog invalidation
        const retried = await acquireModelLocks(
          config,
          models,
          repoDir,
          customSyncService,
          catalogStore,
          progressWriter,
          options,
        );
        return { ...retried, synced: synced || retried.synced };
      }

      if (customSyncService && options?.pull !== false) {
        try {
          write(
            dim(`Syncing behavior ${modelType}/${modelId} from datastore...`),
          );

          const syncService = customSyncService;
          const pulled = await wrapSync(
            () => pullModel(syncService, modelType, modelId),
            "pull",
          );
          // 0 means the local cache is unchanged; void means unknown.
          if (pulled !== 0) synced = true;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          write(
            dim(`Failed to pull behavior data from datastore: ${msg}`),
          );
          throw new Error(
            `Datastore sync failed: could not pull data for ${modelType}/${modelId}: ${msg}`,
          );
        }
      }
    }
  } catch (error) {
    await release();
    if (options?.failIfBusy && error instanceof LockTimeoutError) {
      throw new ModelLocksBusyError(error.lockKey ?? "a behavior lock");
    }
    throw error;
  }

  // older nested swamps read only the holder; set once and never cleared, so
  // concurrent lock holders in this process cannot clear it under each other
  processLockHolderMarker.markHoldingLocks();

  const refusalRestore = (
    custom: CustomDatastoreConfig,
  ): DiscardRestoreOptions => ({
    sync: isV2CustomDatastore(custom) && resolveDurableWrites(custom)
      ? { ...options?.restoreWriteHooks }
      : undefined,
    lazy: custom.hydrationStrategy === "lazy",
  });

  // a breakglass lets another clone take a model's lock mid-run and push the
  // same version number, so refuse to push unless every per-model lock still
  // names its holder. The check and upload are not atomic
  const assertModelLocksHeld = async (
    refused: readonly WrittenVersion[],
  ) => {
    const lost: LostModelLock[] = [];
    for (const [i, lock] of heldLocks.entries()) {
      const taken = heldLockTaken[i];
      if (taken === undefined) continue;
      // A read that fails here fails the push, like the upload after it
      // would: a push that cannot confirm its lock does not go ahead.
      const info = await lock.inspect();
      if (lockStillNames(info, taken)) continue;
      lost.push({
        ...heldLockModels[i],
        ...(info ? { heldBy: { holder: info.holder, pid: info.pid } } : {}),
      });
    }
    if (lost.length === 0) return;
    // refused versions stay marked dirty and a later push would upload them
    // over the other run's, so discard them first, even if the datastore is
    // unreachable, then pull the lost models; best effort
    if (customSyncService) {
      try {
        const repoContext = options?.repoContext;
        if (
          refused.length > 0 && repoContext !== undefined &&
          isCustomDatastoreConfig(config) && config.cachePath
        ) {
          await discardRefusedVersions(
            refused,
            repoContext,
            customSyncService,
            config.cachePath,
            config.namespace,
            refusalRestore(config),
          );
        }
        for (const { modelType, modelId } of lost) {
          try {
            await pullModel(customSyncService, modelType, modelId);
          } catch (error) {
            logger
              .debug`Pull after losing the lock on ${modelType}/${modelId} failed: ${error}`;
          }
        }
      } finally {
        catalogStore?.invalidate();
      }
    }
    throw new ModelLockLostError(lost);
  };

  // beforePush runs inside the same wrapped call as the push, so in serve no
  // run pull can land between it and the upload
  const pushOnce = async (
    beforePush?: () => Promise<void>,
    kind: "push" | "push-alone" = "push",
    versions: readonly WrittenVersion[] = [],
  ) => {
    if (
      customSyncService && customProvider && isCustomDatastoreConfig(config)
    ) {
      const pushNs = config.namespace;
      const provider = customProvider;
      const syncService = customSyncService;

      if (
        caps?.twoPhaseSync && syncService.preparePush &&
        syncService.commitPush
      ) {
        await wrapSync(async () => {
          await assertModelLocksHeld(versions);
          await beforePush?.();
          return await flushTwoPhasePush(
            provider,
            syncService,
            config,
            caps,
            unique,
            pushNs,
            catalogStore,
            logger,
            progressWriter,
          );
        }, kind);
      } else {
        await wrapSync(async () => {
          await assertModelLocksHeld(versions);
          await beforePush?.();
          return await flushSinglePhasePush(
            provider,
            syncService,
            config,
            caps,
            unique,
            pushNs,
            catalogStore,
            logger,
            progressWriter,
          );
        }, kind);
      }
    }
  };

  const lockedModels = new Set(
    unique.map((m) => JSON.stringify([m.modelType, m.modelId])),
  );
  // whether these locks pulled their models before the check: the pull
  // overwrote, with the datastore's copy, every version another clone also
  // wrote under the same number
  const pulledUnderLocks = customSyncService !== undefined &&
    options?.pull !== false;
  const push = async (written?: readonly WrittenVersion[]) => {
    const publishContext = options?.repoContext;
    const isLocked = (w: WrittenVersion) =>
      lockedModels.has(JSON.stringify([w.modelType, w.modelId]));
    // Only versions of models these locks hold: no other writer can own a
    // newer marker for them while the push runs.
    const ours = (written ?? []).filter(isLocked);
    if (
      publishContext === undefined ||
      // A v3 context commits through its commit log, not this push.
      publishContext.commitLog !== undefined ||
      !customSyncService ||
      !isCustomDatastoreConfig(config) || !config.cachePath
    ) {
      await pushOnce();
      return;
    }
    const syncService = customSyncService;
    const custom = config;
    const cachePath = config.cachePath;
    let deferred: PendingPublish[] = [];
    try {
      // A record naming another model's versions too is left for a lock
      // that holds them all.
      deferred = (await readPendingPublishes(cachePath, unique))
        .filter((record) => record.versions.every(isLocked));
    } catch (error) {
      logger.warn`Reading the data versions left to publish failed: ${error}`;
    }
    const versionKey = (w: WrittenVersion) =>
      JSON.stringify([w.modelType, w.modelId, w.dataName, w.version]);
    const ownKeys = new Set(ours.map(versionKey));
    const seen = new Set(ownKeys);
    const left: WrittenVersion[] = [];
    for (const w of deferred.flatMap((record) => record.versions)) {
      if (seen.has(versionKey(w))) continue;
      seen.add(versionKey(w));
      left.push(w);
    }
    if (ours.length === 0 && left.length === 0) {
      await pushOnce();
      return;
    }
    const settleDeferred = async () => {
      try {
        await removePendingPublishes(
          cachePath,
          deferred.map((record) => record.file),
        );
      } catch (error) {
        logger
          .warn`Removing the data versions left to publish failed: ${error}`;
      }
    };
    const present = [
      // The run's own metadata must read: one that cannot is not skipped.
      ...await localDataIds(ours, publishContext.unifiedDataRepo, {
        strict: true,
      }),
      ...await localDataIds(left, publishContext.unifiedDataRepo),
    ];
    // a version whose data id is no longer the run's was replaced by the pull
    // under these locks: another clone wrote that number first, so the push
    // sends and deletes none of that clone's data
    const replaced = pulledUnderLocks
      ? present
        .filter((p) =>
          // Metadata naming no id cannot tell whose version it is.
          p.written.dataId !== undefined && p.localId !== undefined &&
          p.localId !== p.written.dataId
        )
        .map((p) => p.written)
      : [];
    const replacedKeys = new Set(replaced.map(versionKey));
    const toPublish = present
      .map((p) => p.written)
      .filter((w) => !replacedKeys.has(versionKey(w)));
    let conflict: DataVersionConflictError | undefined;
    if (replaced.length > 0) {
      // on a lazy cache read the datastore's content over it, never remove it:
      // the run's write left it marked and a push deletes the remote copy of a
      // marked file missing here
      const own = replaced.filter((w) => ownKeys.has(versionKey(w)));
      const earlier = replaced.filter((w) => !ownKeys.has(versionKey(w)));
      if (custom.hydrationStrategy === "lazy") {
        try {
          for (const w of replaced) {
            await rehydrateContent(
              join(
                publishContext.unifiedDataRepo.getPath(
                  ModelType.create(w.modelType),
                  w.modelId,
                  w.dataName,
                  w.version,
                ),
                "raw",
              ),
              syncService,
              cachePath,
              custom.namespace,
            );
          }
        } catch (error) {
          // content left beside the other clone's metadata is still marked and
          // nothing would read it back, so record the run's own such versions
          // for the next lock to read back before it pushes
          try {
            await recordPendingPublish(cachePath, own);
          } catch (recordError) {
            logger
              .warn`Recording the versions whose content could not be read back failed: ${recordError}`;
          }
          throw error;
        }
      }
      catalogStore?.invalidate();
      if (earlier.length > 0) {
        const names = earlier.map((w) =>
          `${w.modelType}/${w.modelId} ${w.dataName} version ${w.version}`
        ).join(", ");
        logger
          .warn`An earlier read run's data was not published: another swamp process wrote ${names} first, and this host now holds that copy.`;
      }
      if (own.length > 0) conflict = new DataVersionConflictError(own);
    }
    if (toPublish.length === 0) {
      try {
        await pushOnce();
      } catch (error) {
        if (conflict === undefined) throw error;
        throw new DataVersionConflictError(conflict.versions, {
          publishFailure: error,
        });
      }
      await settleDeferred();
      if (conflict !== undefined) throw conflict;
      return;
    }
    const publish = async () => {
      let pending: readonly WrittenVersion[] = toPublish;
      for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt++) {
        let targets: PublishTarget[] = [];
        const stage = pending;
        // The last attempt runs alone, so no other sync can undo it.
        await pushOnce(
          async () => {
            targets = await stageVersionsForPublish(
              stage,
              publishContext,
              cachePath,
            );
          },
          attempt === PUBLISH_ATTEMPTS ? "push-alone" : "push",
          stage,
        );
        if (!syncService.fetchContent || targets.length === 0) return [];
        const behind = await unpublishedTargets(
          targets,
          syncService.fetchContent.bind(syncService),
          config.namespace,
        );
        if (behind === undefined || behind.length === 0) return [];
        pending = behind.map((t) => t.written);
        logger
          .debug`Datastore lacks ${pending.length} written version(s) after push ${attempt}; publishing again`;
      }
      return pending;
    };
    // the records go only once every version they name is confirmed published;
    // a failed push keeps them for the next lock. Only the run's own versions
    // fail the run
    let failure: unknown;
    try {
      const unconfirmed = await publish();
      const ownLeft = unconfirmed.filter((w) => ownKeys.has(versionKey(w)));
      const deferredLeft = unconfirmed.length - ownLeft.length;
      if (deferredLeft > 0) {
        logger
          .warn`${deferredLeft} data version(s) an earlier read run left are not confirmed on the datastore yet; the next run that locks the behavior on this host publishes them again.`;
      } else {
        await settleDeferred();
      }
      if (ownLeft.length > 0) {
        failure = new UnpublishedDataVersionError(ownLeft, PUBLISH_ATTEMPTS);
      }
    } catch (error) {
      failure = error;
    }
    if (failure !== undefined) {
      if (conflict === undefined) throw failure;
      // the refusal carries the failure: the versions it left were not all
      // published either, so a caller that tolerates the refusal still fails on
      // the rest
      throw new DataVersionConflictError(conflict.versions, {
        publishFailure: failure,
      });
    }
    if (conflict !== undefined) throw conflict;
  };

  // a v3 step's writes are committed by run checkpoints that can land after the
  // locks are released; under a lease at serve they commit before release, so
  // they reach serve naming the lease
  const atServe = heldLocks.some((lock) => lock instanceof ServeLock);
  const flush = async (written?: readonly WrittenVersion[]) => {
    try {
      if (atServe && options?.repoContext !== undefined) {
        await checkpointStepUnderLease(options.repoContext);
      }
      await push(written);
    } finally {
      await release();
    }
  };

  const fileLocks = heldLocks.filter((lock): lock is FileLock =>
    lock instanceof FileLock
  );
  const lockIds = () =>
    fileLocks.flatMap((lock) => lock.heldNonce ? [lock.heldNonce] : []);
  const globalLockOptions = datastoreGlobalLockOptions(config);
  const lentLocks: LentLocks = {
    lockIds,
    reclaim: (signal) =>
      reclaimModelLocks(fileLocks, globalLock, {
        signal,
        progressWriter,
        displayKey: globalLockOptions?.namespace
          ? `${globalLockOptions.namespace}/.datastore.lock`
          : ".datastore.lock",
      }),
  };
  return {
    flush,
    push: () => push(),
    pushWritten: push,
    release,
    synced,
    heldLockIds: lockIds(),
    lentLocks,
    leaseLost: leaseLost.signal,
  };
}

/**
 * wrap the whole consumption of a method run's event stream: an async
 * generator's body runs in the context of whoever iterates it
 */
export function runUnderModelLocks<T>(
  lockResult: Pick<ModelLockResult, "lentLocks"> | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return processLockHolderMarker.runHolding(lockResult?.lentLocks ?? [], fn);
}

export async function flushSinglePhasePush(
  provider: DatastoreProvider,
  syncService: DatastoreSyncService,
  config: CustomDatastoreConfig,
  caps: SyncCapabilities | undefined,
  models: ReadonlyArray<{ modelType: string; modelId: string }>,
  namespace: string | undefined,
  catalogStore: CatalogStore | undefined,
  logger: ReturnType<typeof getSwampLogger>,
  progressWriter?: LockProgressWriter,
): Promise<void> {
  const write = progressWriter ?? defaultLockWriter;

  // write the catalog export before taking the global lock so its SQLite read
  // and JSON serialization do not block writers; a later writer overwrites with
  // a more complete full snapshot
  await writeCatalogExportIfNeeded(
    syncService,
    config,
    namespace,
    catalogStore,
    progressWriter,
  );

  const pushLock = provider.createLock(
    config.datastorePath,
    {
      ...datastoreGlobalLockOptions(config),
      maxWaitMs: resolveLockTimeoutMs(),
    },
  );
  try {
    const lockStart = Date.now();
    await pushLock.acquire();
    const lockMs = Date.now() - lockStart;
    if (
      slowLockAdvice({
        waitedMs: lockMs,
        scope: { kind: "global" },
        shareable: true,
        namespace: config.namespace,
      }) === "namespace"
    ) {
      write(
        yellow(
          `Lock acquisition took ${lockMs}ms — ${SLOW_LOCK_NAMESPACE_ADVICE}`,
        ),
      );
    }
    write(dim("Pushing changes to datastore..."));

    const pushed = await pushModelLockScope(
      syncService,
      caps?.scopedSync === true,
      models,
      namespace,
    );
    if (pushed && pushed > 0) {
      write(dim(`Pushed ${pushed} file(s) to datastore`));
    } else {
      write(dim("Push complete, no changes"));
    }
  } catch (error) {
    const { summary, fields } = summarizeSyncError(
      "push",
      config.type,
      error,
    );
    logger.error("{summary}", { summary, ...fields });
    throw new Error(summary, { cause: error });
  } finally {
    try {
      await pushLock.release();
    } catch {
      // Best-effort release
    }
  }
}

export async function flushTwoPhasePush(
  provider: DatastoreProvider,
  syncService: DatastoreSyncService,
  config: CustomDatastoreConfig,
  caps: SyncCapabilities | undefined,
  models: ReadonlyArray<{ modelType: string; modelId: string }>,
  namespace: string | undefined,
  catalogStore: CatalogStore | undefined,
  logger: ReturnType<typeof getSwampLogger>,
  progressWriter?: LockProgressWriter,
): Promise<void> {
  const write = progressWriter ?? defaultLockWriter;
  await writeCatalogExportIfNeeded(
    syncService,
    config,
    namespace,
    catalogStore,
    progressWriter,
  );

  let manifest: PushManifest;
  try {
    write(dim("Preparing push (uploading files)..."));
    const prepareOpts = caps?.scopedSync
      ? {
        context: { models: [...models] } as SyncContext,
        ...(namespace ? { namespace } : {}),
      }
      : namespace
      ? { namespace }
      : undefined;
    manifest = await syncService.preparePush!(prepareOpts);
  } catch (error) {
    const { summary, fields } = summarizeSyncError(
      "push",
      config.type,
      error,
    );
    logger.error("{summary}", { summary, ...fields });
    throw new Error(summary, { cause: error });
  }

  const pushLock = provider.createLock(
    config.datastorePath,
    {
      ...datastoreGlobalLockOptions(config),
      maxWaitMs: resolveLockTimeoutMs(),
    },
  );
  try {
    const lockStart = Date.now();
    await pushLock.acquire();
    const lockMs = Date.now() - lockStart;
    if (
      slowLockAdvice({
        waitedMs: lockMs,
        scope: { kind: "global" },
        shareable: true,
        namespace: config.namespace,
      }) === "namespace"
    ) {
      write(
        yellow(
          `Lock acquisition took ${lockMs}ms — ${SLOW_LOCK_NAMESPACE_ADVICE}`,
        ),
      );
    }
    write(dim("Committing index update..."));

    const commitOpts = namespace ? { namespace } : undefined;
    const pushed = await syncService.commitPush!(manifest, commitOpts);
    if (pushed && pushed > 0) {
      write(dim(`Committed ${pushed} file(s) to datastore index`));
    } else {
      write(dim("Commit complete, no index changes"));
    }
  } catch (error) {
    const { summary, fields } = summarizeSyncError(
      "push",
      config.type,
      error,
    );
    logger.error("{summary}", { summary, ...fields });
    throw new Error(summary, { cause: error });
  } finally {
    try {
      await pushLock.release();
    } catch {
      // Best-effort release
    }
  }
}

export async function writeCatalogExportIfNeeded(
  syncService: DatastoreSyncService,
  config: CustomDatastoreConfig,
  namespace: string | undefined,
  catalogStore: CatalogStore | undefined,
  progressWriter?: LockProgressWriter,
): Promise<void> {
  const write = progressWriter ?? defaultLockWriter;
  if (namespace && catalogStore && config.cachePath) {
    try {
      const exportCount = await writeCatalogExport(
        catalogStore,
        config.cachePath,
        namespace,
      );
      await syncService.markDirty({
        relPath: `${namespace}/.catalog-export.json`,
      });
      write(
        dim(
          `Wrote catalog export (${exportCount} row(s)) for namespace ${namespace}`,
        ),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      write(yellow(`Catalog export write failed: ${msg}`));
    }
  }
}
