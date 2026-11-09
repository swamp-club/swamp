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

import { nameLockHolder } from "./auth_context.ts";
import { CommitLeaseLostError } from "../domain/datastore_v3/commit_log_unit_of_work.ts";
import { serveUpstreamAt } from "../infrastructure/datastore_v3/serve_upstream_registry.ts";
import type { ServeUpstreamTarget } from "../domain/datastore_v3/serve_upstream.ts";
import { recordServeUpstreamFormat } from "../infrastructure/persistence/datastore_format_guard.ts";
import {
  bindV3ServeUpstream,
  serveUpstreamLocalRoot,
} from "../infrastructure/datastore_v3/serve_upstream_binding.ts";
import {
  resolveServeUpstream,
  serveUpstreamCommandPath,
} from "./serve_upstream.ts";
import { noteRetentionCandidate } from "./retention_candidate.ts";
import type { RetentionWatermarkRepository } from "../domain/retention/retention_watermark.ts";
import { ControlPlaneRetentionWatermarkRepository } from "../infrastructure/persistence/control_plane_retention_watermark_repository.ts";
import { withRunPhase } from "../domain/remote/run_progress.ts";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import { hostname } from "node:os";
import { isProcessGone } from "../infrastructure/runtime/process.ts";
import type { OutputMode } from "../presentation/output/output.ts";
import {
  createRepositoryContext,
  type RepositoryContext,
  type RepositoryFactoryConfig,
  writeCatalogExport,
} from "../infrastructure/persistence/repository_factory.ts";
import type { CatalogStore } from "../infrastructure/persistence/catalog_store.ts";
import { RepoPath } from "../domain/repo/repo_path.ts";
import { RepoService } from "../domain/repo/repo_service.ts";
import {
  type RepoMarkerData,
  RepoMarkerRepository,
} from "../infrastructure/persistence/repo_marker_repository.ts";
import { errorPaths, markErrorPaths, UserError } from "../domain/errors.ts";
import { VERSION } from "./commands/version.ts";
import { resolveWorkflowsDir } from "./resolve_workflows_dir.ts";
import { resolveModelsDir } from "./resolve_models_dir.ts";
import type { Logger } from "@logtape/logtape";
import { repoUnitOfWorkFactory } from "../infrastructure/persistence/repo_unit_of_work.ts";
import {
  createLibSwampContext,
  type LibSwampContext,
} from "../libswamp/context.ts";
import { enumeratePulledExtensionDirs } from "../libswamp/extensions/enumerate_pulled.ts";
import {
  modelLockKey,
  parseModelLockKey,
  stripNamespacePrefix,
  workflowRunLockKey,
} from "../libswamp/datastores/lock.ts";
import type { WorkflowRunClaims } from "../domain/workflows/run_claim.ts";
import { isUuid } from "../domain/models/model_lookup.ts";
import {
  resolveDatastoreConfig,
  type ResolveDatastoreOptions,
} from "./resolve_datastore.ts";
import { RENAMED_DATASTORE_TYPES } from "../domain/datastore/renamed_datastore_types.ts";
import {
  extensionCandidateNames,
  type ExtensionLookupPort,
} from "../domain/extensions/extension_auto_resolver.ts";
import { datastoreExtensionCandidates } from "../domain/datastore/datastore_extension_candidates.ts";
import { DefaultDatastorePathResolver } from "../infrastructure/persistence/default_datastore_path_resolver.ts";
import type { DatastorePathResolver } from "../domain/datastore/datastore_path_resolver.ts";
import { ensureDir, exists, walk } from "@std/fs";
import { parse as parseYaml } from "@std/yaml";
import {
  flushDatastoreSyncNamed,
  registerDatastoreSync,
  registerDatastoreSyncNamed,
  SLOW_LOCK_NAMESPACE_ADVICE,
} from "../infrastructure/persistence/datastore_sync_coordinator.ts";
import { summarizeSyncError } from "../infrastructure/persistence/sync_error_diagnostic.ts";
import {
  DEFAULT_LOCK_TTL_MS,
  FileLock,
  readLockFileState,
} from "../infrastructure/persistence/file_lock.ts";
import { FileSystemControlPlaneStore } from "../infrastructure/persistence/fs_control_plane_store.ts";
import {
  ControlPlaneContinuationClaimStore,
  heartbeatLiveness,
} from "../infrastructure/persistence/control_plane_continuation_claim_store.ts";
import {
  type ContinuationClaims,
  localHolder,
  type RunRecordCurrency,
} from "../domain/workflows/continuation_claim.ts";
import {
  type AtomicControlPlaneStore,
  ControlPlaneSignalWaitStore,
  isAtomicControlPlaneStore,
} from "../infrastructure/persistence/control_plane_signal_wait_store.ts";
import { closeWaitsOfEndedRun } from "../domain/workflows/signal_wait_cleanup.ts";
import {
  SIGNAL_WAITS_NOT_CONFIGURED,
  type SignalWaitSupport,
} from "../domain/workflows/signal_wait_store.ts";
import {
  createDatastoreLock,
  datastoreGlobalLockOptions,
  resolveCustomProvider,
} from "../infrastructure/persistence/datastore_global_lock.ts";
import {
  getManagedConfigBase,
  isManagedConfigBaseResolved,
  managedConfigLockfilePath,
  registerManagedConfig,
  SWAMP_SUBDIRS,
  swampPath,
} from "../infrastructure/persistence/paths.ts";
import {
  type DatastoreEnvReader,
  effectiveDatastoreType,
  isExtensionBackedDatastore,
} from "../infrastructure/persistence/managed_config_lockfile.ts";
import {
  type DistributedLock,
  type LockInfo,
  lockSkipping,
  lockStillNames,
  LockTimeoutError,
  LockWaitCycleError,
  MAX_LOCK_SKIPPING,
} from "../domain/datastore/distributed_lock.ts";
import {
  type CustomDatastoreConfig,
  type DatastoreConfig,
  getDatastoreDirectories,
  isCustomDatastoreConfig,
  readDatastoreFormatKey,
  resolveDurableWrites,
  resolveLockTimeoutMs,
  resolveSyncTimeoutMs,
} from "../domain/datastore/datastore_config.ts";
import {
  isShareableDatastore,
  slowLockAdvice,
} from "../domain/datastore/slow_lock_advice.ts";
import type { DatastoreProvider } from "../domain/datastore/datastore_provider.ts";
import {
  DataVersionConflictError,
  HydrateContractViolationError,
  type LostModelLock,
  ModelLockLostError,
  UnpublishedDataVersionError,
} from "../domain/datastore/datastore_sync_service.ts";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
  HydrateFileHook,
  MarkDirtyHook,
  PushManifest,
  SyncCapabilities,
  SyncContext,
  WrittenVersion,
} from "../domain/datastore/datastore_sync_service.ts";
import type { ForeignContentFetcher } from "../domain/data/repositories.ts";
import { ModelType } from "../domain/models/model_type.ts";
import {
  checkpointOpenUnitOfWork,
  runInRootUnitOfWork,
} from "../infrastructure/persistence/repo_unit_of_work.ts";
import {
  atomicWriteFile,
  type AtomicWriteSync,
  syncWrittenDirectory,
} from "../infrastructure/persistence/atomic_write.ts";
import {
  type PendingPublish,
  readPendingPublishes,
  recordPendingPublish,
  removePendingPublishes,
} from "../infrastructure/persistence/pending_publish_store.ts";
import { datastoreTypeRegistry } from "../domain/datastore/datastore_type_registry.ts";
import { pushModelLockScope } from "../infrastructure/persistence/push_paths.ts";
import {
  type LentLocks,
  type LockHolderMarker,
  processLockHolderMarker,
} from "../domain/datastore/lock_holder_marker.ts";
import {
  DRAIN_WAIT_TTL_MS,
  drainToYieldTo,
  type DrainWait,
  MAX_DRAIN_WAIT_LOCKS,
} from "../domain/datastore/drain_wait.ts";
import { DrainWaitStore } from "../infrastructure/persistence/drain_wait_store.ts";
import {
  getSwampLogger,
  getSystemPipeWidth,
} from "../infrastructure/logging/logger.ts";
import { dim, yellow } from "@std/fmt/colors";

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

export function setLockProgressOutputMode(mode: OutputMode): void {
  lockProgressJson = mode === "json";
}

const writeStderrLine = (line: string): void => console.error(line);

/**
 * in json mode, where the logger is silent, each offline notice is one JSON
 * object on stderr; log mode says them through the logger
 */
export function setServeOfflineOutputMode(mode: OutputMode): void {
  setServeOfflineNoticeWriter(
    mode === "json"
      ? (notice) => unguardedConsole.error(JSON.stringify(notice))
      : undefined,
  );
}

export function enableV3RecoveryProgress(): void {
  setV3RecoveryProgress(createLockProgressWriter("system"));
}

function defaultLockWriter(message: string): void {
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
import { withSpan } from "../infrastructure/tracing/mod.ts";
import {
  datastoreEngineOf,
  ensureSupportedDatastoreFormat,
  isV2CustomDatastore,
} from "../infrastructure/persistence/datastore_format_guard.ts";
import { lockingConfigOf } from "../infrastructure/persistence/datastore_lock_target.ts";
import { setV3RecoveryProgress } from "../infrastructure/datastore_v3/interrupted_writer_recovery.ts";
import type { DatastoreEngine } from "../domain/datastore/datastore_format.ts";
import {
  createServeLock,
  ServeLock,
} from "../infrastructure/datastore_v3/serve_lock.ts";
import {
  explicitLeaseOn,
  forgetExplicitLease,
} from "../infrastructure/datastore_v3/explicit_model_leases.ts";
import {
  offlineContextAt,
  registerOfflineReadPartition,
  serveOfflineAt,
  setServeOfflineNoticeWriter,
} from "../infrastructure/datastore_v3/serve_offline.ts";
import { passOwnLockGate } from "../infrastructure/datastore_v3/own_lock_gate.ts";
import { unguardedConsole } from "../domain/models/console_guard.ts";
import { WRITER_LEASE_CLOCK_SKEW_MS } from "../domain/datastore_v3/writer_lease.ts";
import { decideOfflineWork } from "../domain/datastore_v3/offline_write_policy.ts";
import { partitionOf } from "../domain/datastore_v3/partition_key.ts";
import type { MethodKind } from "../domain/models/model.ts";
import {
  catchUpDeferredAt,
  catchUpDeferredTo,
  catchUpV3HandlesAt,
  goServeOfflineAt,
  holdV3Writer,
  serveCatchUpRequestAt,
  v3BucketNamespacedStoreAt,
  type V3DatastoreConfig,
  v3DatastoreConfigOf,
  type V3OwnerCheck,
  v3RepositoryFactoryConfig,
  v3ServeControlPlaneAt,
} from "../infrastructure/datastore_v3/v3_repo_context.ts";
import { assertV3CheckoutJoinable } from "../infrastructure/datastore_v3/v3_checkout_join.ts";
import {
  adoptV3Config,
  planV3ConfigAdoption,
} from "../infrastructure/datastore_v3/v3_config_adoption.ts";
import {
  collectDirsForKind,
  expandSourcePaths,
  readSwampSources,
  resolveSourceExtensionDirs,
} from "../infrastructure/persistence/swamp_sources_repository.ts";
import { resolveSourceBaseDirs } from "../infrastructure/persistence/git_worktree.ts";
import type { ExtensionWorkflowRepository } from "../infrastructure/persistence/extension_workflow_repository.ts";
import { importCheckoutControlPlane } from "../infrastructure/persistence/checkout_control_plane_import.ts";

const sourceWorkflowDirCache = new Map<string, string[]>();
export async function getSourceWorkflowDirs(
  repoDir: string,
): Promise<string[]> {
  const cached = sourceWorkflowDirCache.get(repoDir);
  if (cached) return cached;
  const sourcesConfig = await readSwampSources(repoDir);
  if (!sourcesConfig) {
    sourceWorkflowDirCache.set(repoDir, []);
    return [];
  }
  const { baseDir, legacyBaseDir } = await resolveSourceBaseDirs(repoDir);
  const expanded = await expandSourcePaths(
    sourcesConfig,
    repoDir,
    baseDir,
    legacyBaseDir,
  );
  const { resolved } = await resolveSourceExtensionDirs(expanded);
  const dirs = collectDirsForKind(resolved, "workflows");
  sourceWorkflowDirCache.set(repoDir, dirs);
  return dirs;
}

/**
 * the repository context enumerates these once at creation; call this after
 * changing what is on disk (a managed-config pull, a reload)
 */
export async function refreshExtensionWorkflowDirs(
  extWorkflowRepo: Pick<ExtensionWorkflowRepository, "updateAdditionalDirs">,
  repoDir: string,
  lockfilePath: string,
  pulledExtensionsRoot?: string,
): Promise<number> {
  const sourceWfDirs = await getSourceWorkflowDirs(repoDir);
  const pulledWfDirs = await enumeratePulledExtensionDirs(
    lockfilePath,
    repoDir,
    "workflows",
    pulledExtensionsRoot,
  );
  extWorkflowRepo.updateAdditionalDirs([...sourceWfDirs, ...pulledWfDirs]);
  return pulledWfDirs.length;
}

export function libSwampContextForRepo(
  repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">,
  options?: { logger?: Logger; signal?: AbortSignal },
): LibSwampContext {
  return createLibSwampContext({
    ...options,
    openUnitOfWork: repoUnitOfWorkFactory(repoContext),
  });
}

/**
 * a path outside both roots is never synced: the S3 and GCS extensions treat an
 * escaping relPath as bulk invalidation, which would turn the next push into a
 * walk of the whole cache
 */
export function buildMarkDirtyHook(
  syncService: DatastoreSyncService,
  cacheRoot: string,
  repoDir: string,
): MarkDirtyHook {
  return (absPath?: string) => {
    if (absPath === undefined) {
      return syncService.markDirty();
    }
    const relPath = cacheRelativeMarkPath(absPath, cacheRoot, repoDir);
    if (relPath === undefined) return Promise.resolve();
    return syncService.markDirty({ relPath });
  };
}

export function cacheRelativeMarkPath(
  absPath: string,
  cacheRoot: string,
  repoDir: string,
): string | undefined {
  let rel = relative(cacheRoot, absPath);
  if (escapesRoot(rel)) {
    rel = relative(swampPath(repoDir), absPath);
    if (escapesRoot(rel)) return undefined;
  }
  return SEPARATOR === "/" ? rel : rel.split(SEPARATOR).join("/");
}

function buildForeignContentFetcher(
  syncService: DatastoreSyncService | undefined,
): ForeignContentFetcher | undefined {
  if (!syncService?.fetchForeignContent) return undefined;
  return (namespace, relPath) =>
    syncService.fetchForeignContent!(namespace, relPath);
}

function buildHydrateFileHook(
  syncService: DatastoreSyncService,
  cacheRoot: string,
  repoDir: string,
  datastoreType: string,
): HydrateFileHook | undefined {
  if (!syncService.hydrateFile) return undefined;
  const repoSwampDir = swampPath(repoDir);
  return async (absPath: string, options?: { signal?: AbortSignal }) => {
    let rel = relative(cacheRoot, absPath);
    const insideCache = !escapesRoot(rel);
    if (!insideCache) {
      rel = relative(repoSwampDir, absPath);
    }
    const relPath = SEPARATOR === "/" ? rel : rel.split(SEPARATOR).join("/");
    const hydrated =
      await (options?.signal
        ? syncService.hydrateFile!(relPath, { signal: options.signal })
        : syncService.hydrateFile!(relPath));
    // outside the cache the datastore writes somewhere other than absPath, so
    // only a path inside it can hold the datastore to its claim
    if (hydrated && insideCache && !(await fileExists(absPath))) {
      getSwampLogger(["cli", "datastore"])
        .warn`Datastore ${datastoreType} reported hydrateFile success for ${relPath} but no file exists at ${absPath}`;
      throw markErrorPaths(
        new HydrateContractViolationError(datastoreType, relPath, absPath),
        [absPath],
      );
    }
    return hydrated;
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/**
 * a first segment that merely starts with two dots (..hidden) is inside the
 * root; a cross-drive relative result on Windows is absolute
 */
function escapesRoot(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${SEPARATOR}`) || isAbsolute(rel);
}

export interface RequireRepoOptions {
  repoDir: string;
  outputMode: OutputMode;
  /**
   * on v3, take the writer lease again once another writer took it over and
   * finished, rather than refusing every later commit; serve's lifetime hold
   * sets it, a one-shot command fails instead
   */
  retakeLostV3Lease?: boolean;
  /**
   * on v3, follow rather than wait when another process holds the writer lease
   * (serve's team mode); the result's v3Role says which this process became
   */
  followV3Lease?: boolean;
  /**
   * in team mode, leave the writer hold's catch-up to the command's lock at
   * serve, which answers with it; a command that ends up taking no lock calls
   * catchUpDeferredAt before it reads
   */
  catchUpAtLock?: boolean;
  /**
   * on v3, how the lease hold meets a claim on it: a direct writer's is refused
   * once serve owns the datastore, unless set; serve passes its address,
   * datastore claim and release pass claimer
   */
  v3OwnerCheck?: V3OwnerCheck;
  /**
   * give up after this long instead of the lock timeout; the end-of-command
   * retention pass sets it so a busy repository skips the pass rather than
   * holding up the command
   */
  lockWaitMs?: number;
  /**
   * skip the implicit pull and push but still take the lock; datastore sync
   * owns its own pull and push, and an implicit pull would make its explicit
   * pull report 0 files
   */
  skipImplicitSync?: boolean;
  /**
   * pull the config tier from the remote datastore before reading; only
   * effective under managedConfig with a custom datastore, for read-only
   * commands needing fresh remote state
   */
  pull?: boolean;
}

export interface EnsureManagedConfigBaseOptions {
  /**
   * When false, resolve with installed datastore extensions only: a missing
   * datastore extension is never auto-installed. Defaults to true.
   */
  autoResolve?: boolean;
}

/**
 * if the datastore cannot be resolved nothing is registered; the in-repo
 * .swamp/config fallback is then recorded unresolved and write commands refuse
 * it. lock_timeout errors are rethrown
 */
export async function ensureManagedConfigBase(
  repoDir: string,
  marker: RepoMarkerData | null,
  resolverOverride?: DatastorePathResolver,
  options?: EnsureManagedConfigBaseOptions,
): Promise<boolean> {
  if (marker?.datastore?.managedConfig !== true) return false;

  try {
    if (resolverOverride) {
      const configBase = resolverOverride.resolvePath("config");
      registerManagedConfig(repoDir, true, configBase, true);
      return true;
    }
    const datastoreConfig = await resolveDatastoreConfig(
      marker,
      undefined,
      repoDir,
      { autoResolve: options?.autoResolve },
    );
    const resolver = new DefaultDatastorePathResolver(
      repoDir,
      datastoreConfig,
    );
    const configBase = resolver.resolvePath("config");
    registerManagedConfig(repoDir, true, configBase, true);
    lastResolutionFailure.delete(resolve(repoDir));
    return true;
  } catch (error) {
    if (error instanceof UserError && error.code === "lock_timeout") {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    lastResolutionFailure.set(resolve(repoDir), message);
    const logger = getSwampLogger(["cli", "managed-config"]);
    logger
      .debug`Failed to resolve datastore for managedConfig base: ${message}`;
    datastoreTypeRegistry.resetLoadedFlag();
    return false;
  }
}

const lastResolutionFailure = new Map<string, string>();

/**
 * without a registered base the in-repo .swamp/config fallback is used and
 * recorded as unresolved, never replacing a resolved base; pulled extension
 * sources always live under the in-repo root
 */
export function resolveManagedConfigPaths(
  repoDir: string,
  marker: RepoMarkerData | null,
  configBasePath?: string,
): { lockfilePath: string; active: boolean } {
  const managedConfig = marker?.datastore?.managedConfig === true;
  let effectiveBase = configBasePath ?? swampPath(repoDir, "config");
  const resolved = configBasePath !== undefined ||
    isManagedConfigBaseResolved(repoDir);

  let active = false;
  if (managedConfig) {
    active = true;
    if (!configBasePath) {
      const registeredBase = getManagedConfigBase(repoDir);
      if (registeredBase) {
        effectiveBase = registeredBase;
      }
    }
  }

  registerManagedConfig(repoDir, active, effectiveBase, resolved);
  if (active) {
    return {
      lockfilePath: join(effectiveBase, "upstream_extensions.json"),
      active,
    };
  }
  const rawModelsDir = resolveModelsDir(marker);
  const modelsDir = isAbsolute(rawModelsDir)
    ? rawModelsDir
    : resolve(repoDir, rawModelsDir);
  return {
    lockfilePath: join(modelsDir, "upstream_extensions.json"),
    active,
  };
}

/**
 * writing the lockfile to the in-repo guess would never reach the datastore's
 * lockfile
 */
export class ManagedConfigUnresolvedError extends UserError {
  constructor(
    datastoreType: string,
    reason: string | undefined,
    datastoreExtension = "<datastore extension>",
  ) {
    const detail = reason ? ` (${reason})` : "";
    super(
      `Cannot resolve the ${datastoreType} datastore for managedConfig` +
        `${detail}, so extension changes cannot be recorded in the ` +
        `datastore's lockfile. Install the datastore extension with ` +
        `\`swamp extension pull ${datastoreExtension}\` (add \`--force\` ` +
        `if it is installed but fails to load), then run ` +
        `\`swamp datastore sync --pull\` and retry.`,
      "managed_config_unresolved",
    );
    this.name = "ManagedConfigUnresolvedError";
  }
}

export function assertManagedConfigWritable(
  repoDir: string,
  marker: RepoMarkerData | null,
  readDatastoreEnv?: DatastoreEnvReader,
): void {
  if (!isExtensionBackedDatastore(marker, readDatastoreEnv)) return;
  if (isManagedConfigBaseResolved(repoDir)) return;
  const type = effectiveDatastoreType(marker, readDatastoreEnv);
  const extensionType = RENAMED_DATASTORE_TYPES[type] ?? type;
  throw new ManagedConfigUnresolvedError(
    type,
    describeResolutionFailure(lastResolutionFailure.get(resolve(repoDir))),
    extensionCandidateNames(extensionType)[0],
  );
}

export interface ManagedLockfileWrite {
  lockfilePath: string;
  /**
   * false when the datastore-extension exemption records into the in-repo
   * lockfile because the base is unresolved; nothing in the datastore cache
   * changed
   */
  publish: boolean;
}

/**
 * an unresolved base on an extension-backed datastore is allowed only when
 * every target is the datastore extension itself: it records in-repo without
 * publishing; otherwise it throws
 */
export async function resolveManagedLockfileForWrite(
  repoDir: string,
  marker: RepoMarkerData | null,
  options?: {
    exemptTargets?: readonly string[];
    extensionLookup?: ExtensionLookupPort;
    readDatastoreEnv?: DatastoreEnvReader;
  },
): Promise<ManagedLockfileWrite> {
  await ensureManagedConfigBase(repoDir, marker);
  const { lockfilePath } = resolveManagedConfigPaths(repoDir, marker);
  if (
    !isExtensionBackedDatastore(marker, options?.readDatastoreEnv) ||
    isManagedConfigBaseResolved(repoDir)
  ) {
    return { lockfilePath, publish: true };
  }
  const targets = options?.exemptTargets ?? [];
  if (targets.length > 0) {
    const type = effectiveDatastoreType(marker, options?.readDatastoreEnv);
    const allCandidates = async (lookup?: ExtensionLookupPort) => {
      const candidates = await datastoreExtensionCandidates(type, lookup);
      return targets.every((target) => candidates.includes(target));
    };
    // static candidates first: the usual target needs no registry round trip,
    // which matters on an offline machine
    const exempt = await allCandidates() ||
      (options?.extensionLookup !== undefined &&
        await allCandidates(options.extensionLookup));
    if (exempt) {
      return {
        lockfilePath: managedConfigLockfilePath(repoDir),
        publish: false,
      };
    }
  }
  assertManagedConfigWritable(repoDir, marker, options?.readDatastoreEnv);
  return { lockfilePath, publish: true };
}

/**
 * a missing datastore extension is reported as not installed and not
 * auto-installable, so the error's own remedy (pull the extension) is the only
 * one shown
 */
function describeResolutionFailure(
  message: string | undefined,
): string | undefined {
  if (!message) return undefined;
  if (
    message.includes("Unknown datastore type") ||
    message.includes("Install it with:")
  ) {
    return "its datastore extension is not installed and could not be " +
      "installed automatically";
  }
  return message.trim().replace(/[.\s]+$/, "");
}

export interface RepoValidationContext {
  repoDir: string;
  marker: RepoMarkerData | null;
  repoContext: RepositoryContext;
  datastoreResolver: DatastorePathResolver;
  lockfilePath: string;
  managedConfig?: boolean;
  vaultsDir: string;
}

export interface DatastoreResolutionResult {
  repoDir: string;
  datastoreConfig: DatastoreConfig;
  marker: RepoMarkerData | null;
  engine: DatastoreEngine;
  /**
   * serve, when this checkout's v3 datastore is written through it: the config
   * says format 3, the command takes serve mode, and a serve address is
   * configured. Its storage is then never read
   */
  serveUpstream?: ServeUpstreamTarget;
}

/**
 * only a format-3 datastore with no SWAMP_DATASTORE override takes serve mode;
 * an override names the datastore to open directly
 */
export function markerSaysV3(marker: RepoMarkerData | null): boolean {
  const ds = marker?.datastore;
  if (ds === undefined || Deno.env.get("SWAMP_DATASTORE")) return false;
  try {
    return readDatastoreFormatKey(ds.type, ds.format) === 3;
  } catch {
    // The config's own resolution reports a bad format key.
    return false;
  }
}

export async function serveUpstreamOf(
  marker: RepoMarkerData | null,
): Promise<ServeUpstreamTarget | undefined> {
  if (!markerSaysV3(marker)) return undefined;
  return await resolveServeUpstream({
    engine: "v3",
    commandPath: serveUpstreamCommandPath(),
    ...(marker?.serverAddress !== undefined
      ? { markerServerAddress: marker.serverAddress }
      : {}),
  });
}

/** the serve a team member's checkout writes through, from its marker alone */
export async function serveUpstreamOfRepo(
  repoDir: string,
): Promise<ServeUpstreamTarget | undefined> {
  return await serveUpstreamOf(
    await new RepoMarkerRepository().read(RepoPath.create(repoDir)),
  );
}

/**
 * every resolver of a serve-mode checkout's config passes this, extension
 * loaders included, so none reaches the datastore's extension
 */
export function serveUpstreamConfigOptions(
  repoDir: string,
  upstream: ServeUpstreamTarget | undefined,
): ResolveDatastoreOptions | undefined {
  if (upstream === undefined) return undefined;
  return {
    autoResolve: false,
    serveUpstreamRoot: (namespace) =>
      serveUpstreamLocalRoot(repoDir, upstream.serverUrl, namespace ?? ""),
  };
}

export async function v3LocationOf(
  resolution: Pick<
    DatastoreResolutionResult,
    "repoDir" | "datastoreConfig" | "serveUpstream"
  >,
): Promise<V3DatastoreConfig> {
  return resolution.serveUpstream !== undefined
    ? await bindV3ServeUpstream(
      resolution.repoDir,
      resolution.datastoreConfig,
      resolution.serveUpstream,
      VERSION,
    )
    : await v3DatastoreConfigOf(
      resolution.repoDir,
      resolution.datastoreConfig,
    );
}

function redactHomePath(path: string): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) return path;
  const prefix = home.endsWith(SEPARATOR) ? home : home + SEPARATOR;
  if (path === home) return "~";
  if (path.startsWith(prefix)) {
    return "~" + SEPARATOR + path.slice(prefix.length);
  }
  return path;
}

async function throwRepoNotInitialized(
  service: RepoService,
  repoPath: RepoPath,
): Promise<never> {
  const displayPath = redactHomePath(repoPath.value);
  if (await service.hasOrphanedSwampDir(repoPath)) {
    throw markErrorPaths(
      new UserError(
        `Found a .swamp/ directory at ${displayPath} but no .swamp.yaml marker — ` +
          "the repository appears partially initialized or corrupted. " +
          "If you previously used a remote datastore, re-initializing with " +
          "'swamp repo init' will not reconnect to it. Restore .swamp.yaml " +
          "from version control or re-initialize with the correct --datastore flag.",
      ),
      [displayPath],
    );
  }
  throw markErrorPaths(
    new UserError(
      `Not a swamp repository: ${displayPath}. To initialize a new repository, run 'swamp repo init', or specify an existing repository with 'swamp <command> --repo-dir /path/to/repo'.`,
    ),
    [displayPath],
  );
}

export async function resolveDatastoreForRepo(
  repoDir: string,
): Promise<DatastoreResolutionResult> {
  const repoPath = RepoPath.create(repoDir);
  const service = new RepoService(VERSION);
  const isInit = await service.isInitialized(repoPath);

  if (!isInit) {
    await throwRepoNotInitialized(service, repoPath);
  }

  const markerRepo = new RepoMarkerRepository();
  const marker = await markerRepo.read(repoPath);

  // decided from .swamp.yaml before the config resolves, so an extension
  // datastore's type is never installed nor its provider built; a v2 datastore
  // with a serve address never comes here
  const serveUpstream = await serveUpstreamOf(marker);

  const datastoreConfig = await withSpan(
    "swamp.repo.datastore.config",
    {},
    () =>
      resolveDatastoreConfig(
        marker,
        undefined,
        repoPath.value,
        serveUpstreamConfigOptions(repoPath.value, serveUpstream),
      ),
  );
  if (serveUpstream !== undefined) {
    getSwampLogger(["cli", "datastore"])
      .debug`Running locally with serve at ${serveUpstream.serverUrl} as the datastore's upstream: this checkout's datastore is format 3, so its data is read and written through serve. Pass --server to run the command on serve instead.`;
    recordServeUpstreamFormat(datastoreConfig);
    await withSpan(
      "swamp.datastore.v3.join_check",
      {},
      () => assertV3CheckoutJoinable(repoPath.value, datastoreConfig.namespace),
    );
    return {
      repoDir: repoPath.value,
      datastoreConfig,
      marker,
      engine: "v3",
      serveUpstream,
    };
  }

  // refuse a datastore marked with a format this binary cannot read before any
  // caller locks, pulls, pushes or writes
  const engine = await withSpan(
    "swamp.repo.datastore.format",
    {},
    () => ensureSupportedDatastoreFormat(repoPath.value, datastoreConfig),
  );
  // a checkout joining a v3 datastore through .swamp.yaml while its .swamp
  // holds records is refused before anything leases, catches up or writes
  if (engine === "v3") {
    await withSpan(
      "swamp.datastore.v3.join_check",
      {},
      () => assertV3CheckoutJoinable(repoPath.value, datastoreConfig.namespace),
    );
  }

  return { repoDir: repoPath.value, datastoreConfig, marker, engine };
}

/**
 * decided without checking format or reading anything remote; anything
 * unreadable answers v2, so the open that follows reports it
 */
export async function peekRepoDatastoreEngine(
  repoDir: string,
): Promise<DatastoreEngine> {
  try {
    const repoPath = RepoPath.create(repoDir);
    const marker = await new RepoMarkerRepository().read(repoPath);
    return datastoreEngineOf(
      await resolveDatastoreConfig(marker, undefined, repoPath.value),
    );
  } catch {
    return "v2";
  }
}

export interface RepoMarkerResult {
  repoDir: string;
  marker: RepoMarkerData | null;
}

export async function requireRepoMarker(
  repoDir: string,
): Promise<RepoMarkerResult> {
  const repoPath = RepoPath.create(repoDir);
  const service = new RepoService(VERSION);
  const isInit = await service.isInitialized(repoPath);

  if (!isInit) {
    await throwRepoNotInitialized(service, repoPath);
  }

  const markerRepo = new RepoMarkerRepository();
  const marker = await markerRepo.read(repoPath);

  return { repoDir: repoPath.value, marker };
}

/**
 * on a custom datastore the context carries no wait records: opening that store
 * pulls the namespace, which this path never does
 */
export async function requireInitializedRepoReadOnly(
  options: RequireRepoOptions,
  factoryConfig?: Partial<Omit<RepositoryFactoryConfig, "repoDir">>,
): Promise<RepoValidationContext> {
  const resolution = await withSpan(
    "swamp.repo.datastore.resolve",
    {},
    () => resolveDatastoreForRepo(options.repoDir),
  );
  const { repoDir, datastoreConfig, marker, engine } = resolution;
  const v3 = engine === "v3"
    ? await withSpan(
      "swamp.datastore.v3.bind",
      {},
      () => v3LocationOf(resolution),
    )
    : undefined;

  const repoPath = RepoPath.create(repoDir);

  const workflowsDirRel = resolveWorkflowsDir(marker);
  const workflowsDir = isAbsolute(workflowsDirRel)
    ? workflowsDirRel
    : resolve(repoPath.value, workflowsDirRel);

  const datastoreResolver = new DefaultDatastorePathResolver(
    repoPath.value,
    datastoreConfig,
  );

  // used solely for on-demand hydration, with no lock or pull/push lifecycle;
  // created only when the extension advertises lazyHydration and the config
  // enables it
  let hydrateFileHook: HydrateFileHook | undefined;
  let readOnlySyncService:
    | ReturnType<
      NonNullable<DatastoreProvider["createSyncService"]>
    >
    | undefined;

  if (isCustomDatastoreConfig(datastoreConfig) && v3 === undefined) {
    if (datastoreConfig.cachePath) {
      await ensureDir(datastoreConfig.cachePath);
    }

    if (datastoreConfig.cachePath) {
      const provider = await resolveCustomProvider(datastoreConfig);
      readOnlySyncService = provider.createSyncService?.(
        repoPath.value,
        datastoreConfig.cachePath,
      );
      if (
        datastoreConfig.hydrationStrategy === "lazy" &&
        readOnlySyncService?.hydrateFile
      ) {
        hydrateFileHook = buildHydrateFileHook(
          readOnlySyncService,
          datastoreConfig.cachePath,
          repoPath.value,
          datastoreConfig.type,
        );
      }
    }
  } else if (
    !isCustomDatastoreConfig(datastoreConfig) &&
    datastoreConfig.type === "filesystem"
  ) {
    try {
      const stat = await Deno.stat(datastoreConfig.path);
      if (!stat.isDirectory) {
        throw markErrorPaths(
          new UserError(
            `Datastore path is not a directory: ${datastoreConfig.path}`,
          ),
          [datastoreConfig.path],
        );
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // Directory doesn't exist yet - that's OK, it will be created
      } else if (error instanceof UserError) {
        throw error;
      } else {
        throw markErrorPaths(
          new UserError(
            `Cannot access datastore at ${datastoreConfig.path}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
          [datastoreConfig.path, ...errorPaths(error)],
        );
      }
    }
  }

  const configBase = datastoreResolver.resolvePath("config");
  const {
    lockfilePath,
    active: managedActive,
  } = resolveManagedConfigPaths(
    repoPath.value,
    marker,
    configBase,
  );

  if (options.pull && managedActive && readOnlySyncService?.pullChanged) {
    const logger = getSwampLogger(["datastore", "sync"]);
    const timeoutMs = isCustomDatastoreConfig(datastoreConfig)
      ? resolveSyncTimeoutMs(datastoreConfig)
      : 30_000;
    logger.info("Pulling config tier from remote datastore...");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await readOnlySyncService.pullChanged({
        subdirs: ["config"],
        signal: controller.signal,
        namespace: isCustomDatastoreConfig(datastoreConfig)
          ? datastoreConfig.namespace
          : undefined,
      });
    } catch (error) {
      throw new UserError(
        `Failed to pull config from remote datastore: ${
          error instanceof Error ? error.message : String(error)
        }. Check datastore connectivity and credentials.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  const definitionsDir = managedActive
    ? join(configBase, "models")
    : join(repoPath.value, "models");
  const yamlWorkflowsDir = managedActive
    ? join(configBase, "workflows")
    : join(repoPath.value, "workflows");
  const vaultsDir = managedActive
    ? join(configBase, "vaults")
    : join(repoPath.value, "vaults");

  const sourceWorkflowDirs = await getSourceWorkflowDirs(repoPath.value);

  const v3Factory = v3 !== undefined
    ? await v3RepositoryFactoryConfig(repoPath.value, v3, {
      managedConfig: marker?.datastore?.managedConfig === true,
      readOnly: true,
    })
    : {};
  const repoContext = createRepositoryContext({
    repoDir: repoPath.value,
    workflowsDir,
    additionalWorkflowsDirs: [
      ...sourceWorkflowDirs,
      ...(await enumeratePulledExtensionDirs(
        lockfilePath,
        repoPath.value,
        "workflows",
      )),
    ],
    definitionsDir,
    yamlWorkflowsDir,
    vaultsDir,
    datastoreResolver,
    namespace: datastoreConfig.namespace,
    hydrateFile: hydrateFileHook,
    fetchForeignContent: buildForeignContentFetcher(readOnlySyncService),
    autoGc: marker?.autoGc === true,
    filterStaleRows: !isCustomDatastoreConfig(datastoreConfig) ||
      v3 !== undefined,
    ...v3Factory,
    ...factoryConfig,
  });

  markForwardedRunRecords(repoContext, v3);

  // only a filesystem or v3 datastore's wait records are read here: a v2 custom
  // store pulls its namespace on open, which this path never does. The store
  // has no save hook, so no wait record is written
  if (!isCustomDatastoreConfig(datastoreConfig) || v3 !== undefined) {
    repoContext.signalWaits = resolveSignalWaitSupport(
      datastoreConfig,
      undefined,
      { v3 },
    );
    repoContext.retentionWatermarks = resolveRetentionWatermarks(
      datastoreConfig,
      undefined,
      { v3 },
    );
  }

  if (v3 !== undefined && managedActive) {
    await warnUnadoptedManagedConfig(
      repoPath.value,
      v3,
      configBase,
      marker,
    );
  }

  return {
    repoDir: repoPath.value,
    marker,
    repoContext,
    datastoreResolver,
    lockfilePath,
    managedConfig: managedActive,
    vaultsDir,
  };
}

/**
 * commits the repo's existing definitions, workflows and vault configs into a
 * v3 config tier once, when managedConfig is on; a refusal is a warning and the
 * command goes on
 */
async function adoptManagedConfigOnV3(
  repoContext: RepositoryContext,
  repoDir: string,
  config: V3DatastoreConfig,
  configBase: string,
  marker: RepoMarkerData | null,
): Promise<void> {
  const logger = getSwampLogger(["cli", "managed-config"]);
  // offline, a definition cannot be committed: the next writing command that
  // reaches serve adopts it
  if (serveOfflineAt(config.path) !== undefined) {
    logger.debug`Serve is unreachable: existing config is adopted later`;
    return;
  }
  // a copy whose catch-up waits for the lock can only list more to adopt than
  // a current one: with nothing listed there is nothing to commit, and with
  // anything listed the copy is caught up first, as without the wait
  if (catchUpDeferredTo(config.path)) {
    const pending = await planV3ConfigAdoption(repoDir, config, configBase, {
      lockfileSource: repoLocalLockfilePath(repoDir, marker),
    });
    if (pending.adoptions.length === 0 && pending.lockfile === undefined) {
      return;
    }
    await catchUpDeferredAt(config.path);
  }
  try {
    const plan = await adoptV3Config({
      repoContext,
      repoDir,
      config,
      configBase,
      lockfileSource: repoLocalLockfilePath(repoDir, marker),
    });
    if (plan.adoptions.length > 0 || plan.lockfile !== undefined) {
      logger
        .info`Committed ${plan.adoptions.length} existing definition(s), workflow(s) and vault config(s)${
        plan.lockfile !== undefined ? " and the extension lockfile" : ""
      } into the datastore config tier`;
    }
    if (
      (plan.adoptions.length > 0 || plan.lockfile !== undefined) &&
      plan.skipped.length > 0
    ) {
      logger
        .warn`${plan.skipped.length} existing config file(s) were not committed. Run 'swamp datastore config migrate' to list them and why`;
    }
  } catch (error) {
    // Adoption is the context's own errand: whatever stops it, the command
    // goes on, and `config migrate` surfaces the cause.
    logger
      .warn`Could not commit this repo's existing config into the datastore config tier: ${
      error instanceof Error ? error.message : String(error)
    }. Run 'swamp datastore config migrate' to retry`;
  }
}

async function warnUnadoptedManagedConfig(
  repoDir: string,
  config: V3DatastoreConfig,
  configBase: string,
  marker: RepoMarkerData | null,
): Promise<void> {
  const logger = getSwampLogger(["cli", "managed-config"]);
  try {
    const plan = await planV3ConfigAdoption(repoDir, config, configBase, {
      lockfileSource: repoLocalLockfilePath(repoDir, marker),
    });
    const pending = plan.adoptions.length +
      (plan.lockfile !== undefined ? 1 : 0);
    if (pending === 0) return;
    logger
      .warn`${pending} existing definition(s), workflow(s), vault config(s) or extension lockfile in this repo are not in the datastore config tier yet. The next writing command, or 'swamp datastore config migrate', commits them`;
  } catch (error) {
    logger.debug`Could not check for unadopted config: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

function repoLocalLockfilePath(
  repoDir: string,
  marker: RepoMarkerData | null,
): string {
  const raw = resolveModelsDir(marker);
  return join(
    isAbsolute(raw) ? raw : resolve(repoDir, raw),
    "upstream_extensions.json",
  );
}

export function requireInitializedRepo(
  options: RequireRepoOptions,
  factoryConfig?: Partial<Omit<RepositoryFactoryConfig, "repoDir">>,
): Promise<RepoValidationContext> {
  return withSpan("swamp.repo.init", {}, async () => {
    const resolution = await resolveDatastoreForRepo(options.repoDir);
    const { repoDir, datastoreConfig, marker, engine } = resolution;
    // teardown may run a retention pass on a repository opened to write
    noteRetentionCandidate(repoDir);
    // a v3 datastore takes one writing process at a time; join this process's
    // hold before any other lock. A bucket datastore's hold is at its local
    // root
    const v3 = engine === "v3" ? await v3LocationOf(resolution) : undefined;
    if (v3 !== undefined) {
      await holdV3Writer(v3, repoDir, {
        ...(options.v3OwnerCheck !== undefined
          ? { ownerCheck: options.v3OwnerCheck }
          : {}),
      });
    }

    const repoPath = RepoPath.create(repoDir);

    const workflowsDirRel = resolveWorkflowsDir(marker);
    const workflowsDir = isAbsolute(workflowsDirRel)
      ? workflowsDirRel
      : resolve(repoPath.value, workflowsDirRel);

    const datastoreResolver = new DefaultDatastorePathResolver(
      repoPath.value,
      datastoreConfig,
    );

    let needsCatalogInvalidation = false;

    // shared between the coordinator (pull/push) and the repositories
    // (markDirty on cache writes); hoisted so both use the same instance
    let syncService:
      | ReturnType<
        NonNullable<DatastoreProvider["createSyncService"]>
      >
      | undefined;

    // a v3 bucket datastore syncs nothing: it locks and commits as a filesystem
    // v3 datastore does, at its local root
    const lockConfig = lockingConfigOf(datastoreConfig);
    if (isCustomDatastoreConfig(lockConfig)) {
      const provider = await resolveCustomProvider(lockConfig);
      const lock = provider.createLock(
        lockConfig.datastorePath,
        {
          ...datastoreGlobalLockOptions(lockConfig),
          maxWaitMs: resolveLockTimeoutMs(options.lockWaitMs),
        },
      );

      syncService = lockConfig.cachePath
        ? provider.createSyncService?.(
          repoPath.value,
          lockConfig.cachePath,
        )
        : undefined;

      if (lockConfig.cachePath) {
        await ensureDir(lockConfig.cachePath);
      }

      // with skipImplicitSync the service is not registered with the
      // coordinator (no implicit pull/push); the repository factory still
      // receives it for markDirty hooks
      const registerService = options.skipImplicitSync
        ? undefined
        : syncService;
      await registerDatastoreSync({
        service: registerService,
        lock,
        label: lockConfig.type,
        syncTimeoutMs: resolveSyncTimeoutMs(lockConfig),
        metadataOnly: lockConfig.hydrationStrategy === "lazy",
        namespace: lockConfig.namespace,
        slowLockScope: { scope: { kind: "global" }, shareable: true },
      });
      if (registerService) {
        needsCatalogInvalidation = true;
      }
    } else if (lockConfig.type === "filesystem") {
      try {
        const stat = await Deno.stat(lockConfig.path);
        if (!stat.isDirectory) {
          throw markErrorPaths(
            new UserError(
              `Datastore path is not a directory: ${lockConfig.path}`,
            ),
            [lockConfig.path],
          );
        }
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          // Directory doesn't exist yet - that's OK, it will be created
        } else if (error instanceof UserError) {
          throw error;
        } else {
          throw markErrorPaths(
            new UserError(
              `Cannot access datastore at ${lockConfig.path}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
            [lockConfig.path, ...errorPaths(error)],
          );
        }
      }

      // first drain: wait for per-model locks visible at command start; a
      // writer that already passed its TOCTOU recheck is committed to writing
      // and must finish
      await waitForPerModelLocks(
        lockConfig.path,
        lockConfig.namespace,
        { maxWaitMs: options.lockWaitMs },
      );

      // acquire the global lock; a writer that slipped past the first drain may
      // have taken a per-model lock since, and its in-flight write would still
      // race our structural work
      const lock = new FileLock(
        lockConfig.path,
        {
          ...datastoreGlobalLockOptions(lockConfig),
          maxWaitMs: resolveLockTimeoutMs(options.lockWaitMs),
        },
      );
      await registerDatastoreSync({
        lock,
        namespace: lockConfig.namespace,
        slowLockScope: {
          scope: { kind: "global" },
          shareable: isShareableDatastore(lockConfig, repoPath.value),
        },
      });

      // second drain closes the symmetric TOCTOU window: writers past the
      // recheck must finish before we touch the filesystem. Skipped locks are
      // listed in the global lock so a holder re-taking one waits
      await waitForPerModelLocks(
        lockConfig.path,
        lockConfig.namespace,
        {
          publishSkipping: (lockIds) => lock.publishSkipping(lockIds),
          maxWaitMs: options.lockWaitMs,
        },
      );

      if (lockConfig.namespace) {
        needsCatalogInvalidation = true;
      }
    }

    const configBase = datastoreResolver.resolvePath("config");
    const {
      lockfilePath,
      active: managedActive,
    } = resolveManagedConfigPaths(
      repoPath.value,
      marker,
      configBase,
    );
    const definitionsDir = managedActive
      ? join(configBase, "models")
      : join(repoPath.value, "models");
    const yamlWorkflowsDir = managedActive
      ? join(configBase, "workflows")
      : join(repoPath.value, "workflows");
    const vaultsDir = managedActive
      ? join(configBase, "vaults")
      : join(repoPath.value, "vaults");

    const sourceWorkflowDirs = await getSourceWorkflowDirs(repoPath.value);

    const v3Factory = v3 !== undefined
      ? await v3RepositoryFactoryConfig(repoPath.value, v3, {
        managedConfig: marker?.datastore?.managedConfig === true,
      })
      : {};
    const repoContext = createRepositoryContext({
      repoDir: repoPath.value,
      workflowsDir,
      additionalWorkflowsDirs: [
        ...sourceWorkflowDirs,
        ...(await enumeratePulledExtensionDirs(
          lockfilePath,
          repoPath.value,
          "workflows",
        )),
      ],
      definitionsDir,
      yamlWorkflowsDir,
      vaultsDir,
      datastoreResolver,
      markDirty: syncService && isCustomDatastoreConfig(datastoreConfig) &&
          datastoreConfig.cachePath
        ? buildMarkDirtyHook(
          syncService,
          datastoreConfig.cachePath,
          repoPath.value,
        )
        : undefined,
      hydrateFile: syncService && isCustomDatastoreConfig(datastoreConfig) &&
          datastoreConfig.cachePath
        ? buildHydrateFileHook(
          syncService,
          datastoreConfig.cachePath,
          repoPath.value,
          datastoreConfig.type,
        )
        : undefined,
      fetchForeignContent: buildForeignContentFetcher(syncService),
      namespace: datastoreConfig.namespace,
      autoGc: marker?.autoGc === true,
      filterStaleRows: !isCustomDatastoreConfig(datastoreConfig) ||
        v3 !== undefined,
      ...v3Factory,
      ...factoryConfig,
    });
    markForwardedRunRecords(repoContext, v3);
    attachSignalWaits(
      repoContext,
      resolveSignalWaitSupport(datastoreConfig, syncService, {
        runsInDatastore: runsLiveInDatastore(datastoreResolver),
        v3,
      }),
    );
    repoContext.retentionWatermarks = resolveRetentionWatermarks(
      datastoreConfig,
      syncService,
      { v3 },
    );
    repoContext.continuationClaims = resolveContinuationClaims(
      datastoreConfig,
      repoPath.value,
      syncService,
      { v3 },
    );

    // On v3 the read model writes the catalog: an invalidate only forces a full replay.
    if (needsCatalogInvalidation && v3 === undefined) {
      repoContext.catalogStore.invalidate();
    }

    if (v3 !== undefined && managedActive) {
      await adoptManagedConfigOnV3(
        repoContext,
        repoPath.value,
        v3,
        configBase,
        marker,
      );
    }

    return {
      repoDir: repoPath.value,
      marker,
      repoContext,
      datastoreResolver,
      lockfilePath,
      vaultsDir,
    };
  });
}

export async function requireInitializedRepoUnlocked(
  options: RequireRepoOptions,
  factoryConfig?: Partial<Omit<RepositoryFactoryConfig, "repoDir">>,
): Promise<
  RepoValidationContext & {
    datastoreConfig: DatastoreConfig;
    /**
     * one sync service shared by the markDirty hook and acquireModelLocks, so
     * cache writes and the watermark read stay coherent across both
     */
    syncService?: DatastoreSyncService;
    v3Role?: "writer" | "follower";
  }
> {
  const resolution = await resolveDatastoreForRepo(options.repoDir);
  const { repoDir, datastoreConfig, marker, engine } = resolution;
  // teardown may run a retention pass on a repository opened to write
  noteRetentionCandidate(repoDir);
  // a v3 datastore takes one writing process at a time; join this process's
  // hold before any model lock. A bucket datastore's hold is at its local root
  const v3 = engine === "v3" ? await v3LocationOf(resolution) : undefined;
  let v3Role: "writer" | "follower" | undefined;
  if (v3 !== undefined) {
    v3Role = await holdV3Writer(v3, repoDir, {
      ...(options.retakeLostV3Lease === true ? { retakeLost: true } : {}),
      ...(options.followV3Lease === true ? { follow: true } : {}),
      ...(options.v3OwnerCheck !== undefined
        ? { ownerCheck: options.v3OwnerCheck }
        : {}),
      ...(options.catchUpAtLock === true ? { catchUpAtLock: true } : {}),
    });
    // the principal serve named at the hold's catch-up, or that the checkout
    // stored; a lock's catch-up names it again
    nameLockHolder(datastoreRootOf(datastoreConfig));
  }

  const repoPath = RepoPath.create(repoDir);

  const workflowsDirRel = resolveWorkflowsDir(marker);
  const workflowsDir = isAbsolute(workflowsDirRel)
    ? workflowsDirRel
    : resolve(repoPath.value, workflowsDirRel);

  const datastoreResolver = new DefaultDatastorePathResolver(
    repoPath.value,
    datastoreConfig,
  );

  let syncService: DatastoreSyncService | undefined;

  if (isCustomDatastoreConfig(datastoreConfig) && v3 === undefined) {
    if (datastoreConfig.cachePath) {
      await ensureDir(datastoreConfig.cachePath);
      const provider = await resolveCustomProvider(datastoreConfig);
      syncService = provider.createSyncService?.(
        repoPath.value,
        datastoreConfig.cachePath,
      );
    }
  } else if (
    !isCustomDatastoreConfig(datastoreConfig) &&
    datastoreConfig.type === "filesystem"
  ) {
    try {
      const stat = await Deno.stat(datastoreConfig.path);
      if (!stat.isDirectory) {
        throw markErrorPaths(
          new UserError(
            `Datastore path is not a directory: ${datastoreConfig.path}`,
          ),
          [datastoreConfig.path],
        );
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // Directory doesn't exist yet - that's OK, it will be created
      } else if (error instanceof UserError) {
        throw error;
      } else {
        throw markErrorPaths(
          new UserError(
            `Cannot access datastore at ${datastoreConfig.path}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
          [datastoreConfig.path, ...errorPaths(error)],
        );
      }
    }
  }

  const configBase = datastoreResolver.resolvePath("config");
  const {
    lockfilePath,
    active: managedActive,
  } = resolveManagedConfigPaths(
    repoPath.value,
    marker,
    configBase,
  );
  const definitionsDir = managedActive
    ? join(configBase, "models")
    : join(repoPath.value, "models");
  const yamlWorkflowsDir = managedActive
    ? join(configBase, "workflows")
    : join(repoPath.value, "workflows");
  const vaultsDir = managedActive
    ? join(configBase, "vaults")
    : join(repoPath.value, "vaults");

  const sourceWorkflowDirs = await getSourceWorkflowDirs(repoPath.value);

  const v3Factory = v3 !== undefined
    ? await v3RepositoryFactoryConfig(repoPath.value, v3, {
      managedConfig: marker?.datastore?.managedConfig === true,
    })
    : {};
  const repoContext = createRepositoryContext({
    repoDir: repoPath.value,
    workflowsDir,
    additionalWorkflowsDirs: [
      ...sourceWorkflowDirs,
      ...(await enumeratePulledExtensionDirs(
        lockfilePath,
        repoPath.value,
        "workflows",
      )),
    ],
    definitionsDir,
    yamlWorkflowsDir,
    vaultsDir,
    datastoreResolver,
    markDirty: syncService && isCustomDatastoreConfig(datastoreConfig) &&
        datastoreConfig.cachePath
      ? buildMarkDirtyHook(
        syncService,
        datastoreConfig.cachePath,
        repoPath.value,
      )
      : undefined,
    hydrateFile: syncService && isCustomDatastoreConfig(datastoreConfig) &&
        datastoreConfig.cachePath
      ? buildHydrateFileHook(
        syncService,
        datastoreConfig.cachePath,
        repoPath.value,
        datastoreConfig.type,
      )
      : undefined,
    fetchForeignContent: buildForeignContentFetcher(syncService),
    namespace: datastoreConfig.namespace,
    autoGc: marker?.autoGc === true,
    filterStaleRows: !isCustomDatastoreConfig(datastoreConfig) ||
      v3 !== undefined,
    ...v3Factory,
    ...factoryConfig,
  });
  markForwardedRunRecords(repoContext, v3);
  attachSignalWaits(
    repoContext,
    resolveSignalWaitSupport(datastoreConfig, syncService, {
      runsInDatastore: runsLiveInDatastore(datastoreResolver),
      v3,
    }),
  );
  repoContext.retentionWatermarks = resolveRetentionWatermarks(
    datastoreConfig,
    syncService,
    { v3 },
  );
  repoContext.continuationClaims = resolveContinuationClaims(
    datastoreConfig,
    repoPath.value,
    syncService,
    { v3 },
  );

  if (v3 !== undefined && managedActive) {
    await adoptManagedConfigOnV3(
      repoContext,
      repoPath.value,
      v3,
      configBase,
      marker,
    );
  }

  return {
    repoDir: repoPath.value,
    marker,
    repoContext,
    datastoreResolver,
    datastoreConfig,
    syncService,
    lockfilePath,
    vaultsDir,
    ...(v3Role !== undefined ? { v3Role } : {}),
  };
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
    onAcquired: async (delivered) => {
      await catchUpV3HandlesAt(
        root,
        options?.ignoresStop === true ? { ignoresStop: true } : undefined,
        delivered,
      );
      nameLockHolder(root);
    },
    // a lock that is a deferred hold's first contact goes offline as the
    // hold's catch-up would have
    onUnreachable: (error) => goServeOfflineAt(root, error),
    // serve answers the lock with what the copy lacks, sparing a catch-up
    catchUpRequest: () => serveCatchUpRequestAt(root),
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

/**
 * a command that left its writer hold's catch-up to a lock, and takes none,
 * catches up before it reads; nothing for a hold that caught up itself
 */
export async function catchUpDeferred(config: DatastoreConfig): Promise<void> {
  const root = datastoreRootOf(config);
  if (root !== undefined) await catchUpDeferredAt(root);
}

/** the datastore root a serve-mode checkout's state is kept under, if local */
export function datastoreRootOf(config: DatastoreConfig): string | undefined {
  const locking = lockingConfigOf(config);
  return isCustomDatastoreConfig(locking) ? undefined : locking.path;
}

/**
 * when offline, reads and lists are allowed and their partition is registered
 * so what they record queues; anything that changes things needs a live
 * explicit lease on the behavior, by serve's clock
 */
export async function assertOfflineRunAllowed(
  config: DatastoreConfig,
  run: {
    readonly modelType: string;
    readonly modelId: string;
    readonly behaviorName: string;
    readonly methodName: string;
    readonly methodKind: MethodKind | undefined;
  },
): Promise<void> {
  const locking = lockingConfigOf(config);
  if (isCustomDatastoreConfig(locking)) return;
  const root = locking.path;
  if (serveOfflineAt(root) === undefined) return;
  const type = ModelType.create(run.modelType);
  const decision = decideOfflineWork({
    kind: "method",
    model: { type: type.normalized, id: run.modelId.toLowerCase() },
    behaviorName: run.behaviorName,
    method: run.methodName,
    methodKind: run.methodKind,
  }, await offlineContextAt(root));
  if (!decision.allowed) throw decision.error;
  if (decision.lease === undefined) {
    registerOfflineReadPartition(
      root,
      partitionOf({ kind: "model", type, id: run.modelId }),
    );
  }
}

export interface ServeLockHoldOptions {
  /**
   * Called once when a fenced lease at serve lapses: the work under the
   * lock must stop. Never called for a local lock.
   */
  readonly onLost?: (error: Error) => void;
  /** the catch-up once held ignores the command's stop, as a publish must land */
  readonly ignoresStop?: boolean;
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

/**
 * null when the model's lock is held or not taken within waitMs; a provider
 * lock that ignores the signal waits at most its own timeout
 */
export async function tryModelLock(
  datastoreConfig: DatastoreConfig,
  modelType: string,
  modelId: string,
  waitMs: number,
): Promise<DistributedLock | null> {
  const lock = await createModelLock(datastoreConfig, modelType, modelId);
  if (await lock.inspect()) return null;
  const signal = AbortSignal.timeout(waitMs);
  try {
    await lock.acquire(signal);
  } catch (error) {
    if (signal.aborted || error instanceof LockTimeoutError) return null;
    throw error;
  }
  return lock;
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
  // a stopped resume still puts its suspended run back under this claim
  const atServe = serveLockOf(
    config,
    workflowRunLockKey(undefined, runId),
    lockKey,
    maxWaitMs,
    { ignoresStop: true },
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

/**
 * wait records must be visible to every process that can settle a wait, so they
 * live with the datastore, never under the repository; any other datastore does
 * not support waits
 */
export function resolveSignalWaitSupport(
  config: DatastoreConfig,
  syncService?: DatastoreSyncService,
  options?: {
    namespaceBound?: boolean;
    /**
     * only a filesystem datastore of which this is true lets the sweep judge a
     * wait by its run record
     */
    runsInDatastore?: boolean;
    v3?: V3DatastoreConfig;
  },
): SignalWaitSupport {
  // serve can deliver a signal only to a wait it registered itself, so a member
  // driving a run from a checkout cannot wait on one
  if (options?.v3 !== undefined && serveUpstreamAt(options.v3.path)) {
    return {
      supported: false,
      reason:
        "in team mode such a run executes on serve, so use --server, or a trigger or schedule",
    };
  }
  const bucket = options?.v3 === undefined
    ? undefined
    : v3BucketNamespacedStoreAt(options.v3);
  if (bucket !== undefined) {
    return {
      supported: true,
      localRunAbsenceIsAuthoritative: options?.runsInDatastore === true,
      store: new ControlPlaneSignalWaitStore(bucket),
    };
  }
  if (!isCustomDatastoreConfig(config)) {
    return {
      supported: true,
      localRunAbsenceIsAuthoritative: options?.runsInDatastore === true,
      store: new ControlPlaneSignalWaitStore(
        new FileSystemControlPlaneStore(
          config.namespace ? join(config.path, config.namespace) : config.path,
        ),
      ),
    };
  }
  const update =
    `update the "${config.type}" datastore extension, or use a filesystem datastore`;
  if (
    !syncService?.capabilities?.().controlPlane ||
    !syncService.controlPlaneStore
  ) {
    return {
      supported: false,
      reason:
        `the "${config.type}" datastore has no control-plane store shared between hosts; ${update}`,
    };
  }
  // the S3 and GCS extensions bind their namespace on the first sync call and
  // older ones fix the list prefix at creation, so the store is opened only by
  // a command that uses a wait
  const remote = lazyRemoteStore(
    syncService,
    config.namespace && !options?.namespaceBound ? config.namespace : undefined,
    `the control-plane store of the "${config.type}" datastore cannot create a record atomically (putIfAbsent); ${update}`,
  );
  return {
    supported: true,
    store: new ControlPlaneSignalWaitStore(remote.store),
    ready: remote.open,
  };
}

export function continuationClaimsOver(
  store: AtomicControlPlaneStore,
  holder: string,
  options?: { staleMs?: number },
): ContinuationClaims {
  return {
    store: new ControlPlaneContinuationClaimStore(store),
    holder,
    liveness: heartbeatLiveness(store, options),
  };
}

export const RUN_RECORD_FETCH_TIMEOUT_MS = 30_000;

/**
 * byte for byte; a record with a change this host has not pushed also reads as
 * different, and the caller leaves the run for a later attempt. Only for
 * repositories whose run records live in the datastore
 */
export function runRecordCurrencyOver(
  config: DatastoreConfig,
  syncService: DatastoreSyncService | undefined,
  pathOf: (run: { workflowId: string; runId: string }) => string,
): RunRecordCurrency | undefined {
  if (!isCustomDatastoreConfig(config) || !config.cachePath) return undefined;
  if (!syncService?.fetchContent) return undefined;
  const cachePath = config.cachePath;
  const namespace = config.namespace;
  return async (run) => {
    const absPath = pathOf(run);
    const rel = relative(cachePath, absPath);
    if (escapesRoot(rel)) {
      throw markErrorPaths(
        new Error(`Run record ${absPath} is outside the datastore cache`),
        [absPath],
      );
    }
    const relPath = SEPARATOR === "/" ? rel : rel.split(SEPARATOR).join("/");
    const remote = await syncService.fetchContent!(relPath, {
      namespace,
      signal: AbortSignal.timeout(RUN_RECORD_FETCH_TIMEOUT_MS),
    });
    if (remote === null) return false;
    let local: Uint8Array;
    try {
      local = await Deno.readFile(absPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
    if (local.length !== remote.length) return false;
    for (let i = 0; i < local.length; i++) {
      if (local[i] !== remote[i]) return false;
    }
    return true;
  };
}

/**
 * a checkout writing through serve has no direct reach to the datastore's
 * control plane, nor does a directory that is no repository; both keep the
 * checkout's .swamp/_control
 */
export async function localServeControlPlane(
  repoDir: string,
): Promise<AtomicControlPlaneStore> {
  if (!await new RepoService(VERSION).isInitialized(RepoPath.create(repoDir))) {
    return new FileSystemControlPlaneStore(swampPath(repoDir));
  }
  const resolution = await resolveDatastoreForRepo(repoDir);
  if (resolution.engine === "v3" && resolution.serveUpstream === undefined) {
    const shared = v3ServeControlPlaneAt(await v3LocationOf(resolution));
    // import what the checkout's serve kept before team mode moves in, as
    // serve's boot does: a token command run before serve restarts must not
    // make a new token key that strands the checkout's tokens
    await importCheckoutControlPlane(
      new FileSystemControlPlaneStore(swampPath(resolution.repoDir)),
      shared,
    );
    return shared;
  }
  return new FileSystemControlPlaneStore(swampPath(resolution.repoDir));
}

/**
 * claims live in the store serve keeps its heartbeats in; a custom datastore
 * without a control-plane store has no claims, and a resume takes none
 */
export function resolveContinuationClaims(
  config: DatastoreConfig,
  repoDir: string,
  syncService?: DatastoreSyncService,
  options?: {
    v3?: V3DatastoreConfig;
  },
): ContinuationClaims | undefined {
  if (options?.v3 !== undefined) {
    return continuationClaimsOver(
      v3ServeControlPlaneAt(options.v3),
      localHolder(),
    );
  }
  if (!isCustomDatastoreConfig(config) || !isV2CustomDatastore(config)) {
    return continuationClaimsOver(
      new FileSystemControlPlaneStore(swampPath(repoDir)),
      localHolder(),
    );
  }
  if (
    !syncService?.capabilities?.().controlPlane ||
    !syncService.controlPlaneStore
  ) {
    return undefined;
  }
  const notAtomic =
    `the control-plane store of the "${config.type}" datastore cannot create a record atomically (putIfAbsent)`;
  const remote = lazyRemoteStore(syncService, config.namespace, notAtomic);
  return {
    ...continuationClaimsOver(remote.store, localHolder()),
    usable: async () => {
      try {
        await remote.open();
        return true;
      } catch (error) {
        if (error instanceof UserError && error.message === notAtomic) {
          return false;
        }
        throw error;
      }
    },
  };
}

/**
 * repositories that share a datastore but keep their runs to themselves cannot
 * see each other's runs, so none can tell a deleted run from another
 * repository's
 */
export function runsLiveInDatastore(resolver: DatastorePathResolver): boolean {
  return resolver.isDatastoreSubdir(SWAMP_SUBDIRS.workflowRuns) &&
    !resolver.isExcluded(SWAMP_SUBDIRS.workflowRuns);
}

/**
 * like signal waits, watermarks live with the datastore so every sharing
 * process sees them; a custom datastore without an atomic control-plane store
 * has none and retention still runs
 */
export function resolveRetentionWatermarks(
  config: DatastoreConfig,
  syncService?: DatastoreSyncService,
  options?: {
    namespaceBound?: boolean;
    v3?: V3DatastoreConfig;
  },
): RetentionWatermarkRepository | undefined {
  const bucket = options?.v3 === undefined
    ? undefined
    : v3BucketNamespacedStoreAt(options.v3);
  if (bucket !== undefined) {
    return new ControlPlaneRetentionWatermarkRepository(bucket);
  }
  if (!isCustomDatastoreConfig(config)) {
    return new ControlPlaneRetentionWatermarkRepository(
      new FileSystemControlPlaneStore(
        config.namespace ? join(config.path, config.namespace) : config.path,
      ),
    );
  }
  if (
    !syncService?.capabilities?.().controlPlane ||
    !syncService.controlPlaneStore
  ) {
    return undefined;
  }
  const remote = lazyRemoteStore(
    syncService,
    config.namespace && !options?.namespaceBound ? config.namespace : undefined,
    `the control-plane store of the "${config.type}" datastore cannot create a record atomically (putIfAbsent)`,
  );
  return new ControlPlaneRetentionWatermarkRepository(remote.store);
}

/**
 * other members forward the run records a serve-mode checkout reads, so a
 * record's fields are their report
 */
function markForwardedRunRecords(
  repoContext: Pick<RepositoryContext, "workflowRunRepo">,
  v3: V3DatastoreConfig | undefined,
): void {
  if (v3 !== undefined && serveUpstreamAt(v3.path) !== undefined) {
    repoContext.workflowRunRepo.recordsAreForwarded = true;
  }
}

/**
 * every run saved as ended closes its waits first, so no path that ends a run
 * leaves a wait accepting signals
 */
export function attachSignalWaits(
  repoContext: Pick<RepositoryContext, "signalWaits" | "workflowRunRepo">,
  support: SignalWaitSupport,
): void {
  repoContext.signalWaits = support;
  if (!support.supported) {
    repoContext.workflowRunRepo.beforeSave = undefined;
    return;
  }
  const closeWaits = closeWaitsOfEndedRun(support.store);
  repoContext.workflowRunRepo.beforeSave = async (run) => {
    // A run's outcome is never lost to its wait records: when they cannot
    // be reached the run is saved all the same, and the sweep closes its
    // waits later.
    try {
      await closeWaits(run);
    } catch (error) {
      getSwampLogger(["workflow", "signal-wait"]).warn(
        "Could not close the signal waits of run {runId}; they are closed by the next sweep: {error}",
        {
          runId: run.id,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  };
}

export function signalWaitsOf(
  repoContext: Pick<RepositoryContext, "signalWaits">,
): SignalWaitSupport {
  return repoContext.signalWaits ?? SIGNAL_WAITS_NOT_CONFIGURED;
}

/**
 * the pull can happen partway through a command; it brings remote changes in
 * without discarding unpushed writes, and a run being resumed or saved is held
 * in memory and written after
 */
function lazyRemoteStore(
  syncService: DatastoreSyncService,
  namespace: string | undefined,
  notAtomic: string,
): { store: AtomicControlPlaneStore; open: () => Promise<void> } {
  let opened: Promise<AtomicControlPlaneStore> | undefined;
  const open = (): Promise<AtomicControlPlaneStore> => {
    opened ??= (async () => {
      if (namespace) await syncService.pullChanged({ namespace });
      const store = syncService.controlPlaneStore!();
      if (!isAtomicControlPlaneStore(store)) throw new UserError(notAtomic);
      return store;
    })().catch((error) => {
      opened = undefined;
      throw error;
    });
    return opened;
  };
  return {
    open: async () => {
      await open();
    },
    store: {
      put: async (key, data) => await (await open()).put(key, data),
      putIfAbsent: async (key, data) =>
        await (await open()).putIfAbsent(key, data),
      get: async (key) => await (await open()).get(key),
      delete: async (key) => await (await open()).delete(key),
      list: async (prefix) => await (await open()).list(prefix),
    },
  };
}

export interface PerModelLockScan {
  held: number;
  heldForOtherRuns: ReadonlyArray<{ pid: number; lockPath: string }>;
  skippedLockIds: readonly string[];
  waitedLocks: ReadonlyArray<{ lockId: string; lockPath: string }>;
}

export type DrainWaits = Pick<DrainWaitStore, "publish" | "list" | "remove">;

export interface WaitForPerModelLocksOptions {
  progressWriter?: LockProgressWriter;
  findModelLocks?: () => Promise<PerModelLockScan>;
  lockHolderMarker?: LockHolderMarker;
  drainWaits?: DrainWaits;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  publishSkipping?: (lockIds: readonly string[]) => Promise<void>;
}

const DRAIN_POLL_INTERVAL_MS = 1_000;

/**
 * two drains each waiting on a lock the other holds until it exits would both
 * hit the lock timeout, so the later one throws LockWaitCycleError. Filesystem
 * datastores only: S3 locks cannot be scanned locally
 */
export async function waitForPerModelLocks(
  datastorePath: string,
  namespace?: string,
  options: WaitForPerModelLocksOptions = {},
): Promise<readonly string[]> {
  const write = options.progressWriter ?? defaultLockWriter;
  const lockHolderMarker = options.lockHolderMarker ?? processLockHolderMarker;
  const relationTo = lockHolderMarker.lockRelation();
  const inheritedLockIds = lockHolderMarker.inheritedLockIds();
  const pollIntervalMs = options.pollIntervalMs ?? DRAIN_POLL_INTERVAL_MS;

  const findModelLocks = options.findModelLocks ??
    (async (): Promise<PerModelLockScan> => {
      let held = 0;
      const heldForOtherRuns: Array<{ pid: number; lockPath: string }> = [];
      const skippedLockIds: string[] = [];
      const waitedLocks: Array<{ lockId: string; lockPath: string }> = [];
      try {
        for await (
          const entry of walk(datastorePath, {
            includeDirs: false,
            match: [/\.lock$/],
          })
        ) {
          const rel = relative(datastorePath, entry.path);
          if (!parseModelLockKey(stripNamespacePrefix(namespace, rel))) {
            continue;
          }
          try {
            const state = await readLockFileState(
              entry.path,
              DEFAULT_LOCK_TTL_MS,
            );
            if (state.kind === "absent") continue;
            if (state.kind === "unreadable") {
              // an unreadable lock file is a holder mid-write, so the lock is
              // held; it cannot say for whom, so it is never skipped as an
              // ancestor's
              if (state.fresh) held++;
              continue;
            }
            const info = state.info;
            // skip locks held for the run that started this one, handed down by
            // nonce or an ancestor swamp's on this host, so a shell step's
            // nested swamp command does not deadlock
            const relation = relationTo(info);
            const acquiredAt = new Date(info.acquiredAt).getTime();
            const live = Date.now() - acquiredAt <= info.ttlMs;
            if (relation === "ancestor") {
              // a lock skipped on the pid alone may be held for another run and
              // released while this drain waits, so it is not reported held
              // until this drain exits
              if (
                live && info.nonce !== undefined &&
                inheritedLockIds.has(info.nonce)
              ) {
                skippedLockIds.push(info.nonce);
              }
              continue;
            }
            if (live) {
              held++;
              if (info.nonce !== undefined) {
                waitedLocks.push({ lockId: info.nonce, lockPath: rel });
              }
              if (
                relation === "ancestor-other-run" && info.pid !== undefined
              ) {
                heldForOtherRuns.push({ pid: info.pid, lockPath: rel });
              }
            }
          } catch {
            // Skip lock files whose content is not a lock record
          }
        }
      } catch {
        // Datastore directory may not exist yet
      }
      return { held, heldForOtherRuns, skippedLockIds, waitedLocks };
    });

  // every change to the skipped set is published before the drain sleeps or
  // returns, and it ends only on a matching scan; holder and drain each write
  // then read, so one always sees the other
  let published: readonly string[] = [];
  const confirm = async (scan: PerModelLockScan): Promise<boolean> => {
    if (options.publishSkipping === undefined) return true;
    const now = new Set(scan.skippedLockIds.slice(0, MAX_LOCK_SKIPPING));
    if (
      now.size === published.length && published.every((id) => now.has(id))
    ) {
      return true;
    }
    published = [...now];
    await options.publishSkipping(published);
    return false;
  };

  const maxWaitMs = resolveLockTimeoutMs(options.maxWaitMs);
  const first = await findModelLocks();
  if (await confirm(first) && first.held === 0) {
    return first.skippedLockIds;
  }
  let announced = false;
  const announce = (scan: PerModelLockScan) => {
    if (announced || scan.held === 0) return;
    announced = true;
    write(
      yellow(`Waiting for ${scan.held} per-model lock(s) to be released...`),
    );
  };
  announce(first);
  const waitStart = Date.now();
  const drainWait = new PublishedDrainWait(
    options.drainWaits ?? new DrainWaitStore(datastorePath, namespace),
    waitStart,
  );
  let last = first;
  let rescans = 0;
  try {
    await drainWait.check(first);
    while (true) {
      // the first list published is confirmed at once; after that every scan is
      // a poll apart, so a skipped set that keeps changing cannot spin the
      // drain
      if (last.held > 0 || rescans > 0) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
      rescans++;
      const remaining = await findModelLocks();
      const confirmed = await confirm(remaining);
      last = remaining;
      if (remaining.held === 0 && confirmed) break;
      announce(remaining);
      const elapsed = Date.now() - waitStart;
      if (elapsed >= maxWaitMs) {
        throw new LockTimeoutError(
          "per-model locks",
          null,
          elapsed,
          remaining.heldForOtherRuns.length > 0
            ? { message: heldForOtherRunsMessage(remaining, elapsed) }
            : undefined,
        );
      }
      await drainWait.check(remaining);
    }
  } finally {
    await drainWait.withdraw();
  }
  if (announced) write(dim("Per-model locks released"));
  return last.skippedLockIds;
}

/**
 * marker I/O that fails is logged and otherwise ignored: the drain then just
 * waits
 */
class PublishedDrainWait {
  readonly #id = crypto.randomUUID();
  readonly #host = hostname();
  #published = false;
  #suspect: { id: string; updatedAtMs: number } | undefined;

  constructor(
    private readonly waits: DrainWaits,
    private readonly startedAtMs: number,
  ) {}

  /**
   * throws LockWaitCycleError only once the other drain is seen on two checks
   * in a row with a refreshed marker: one sighting is not enough, since a
   * marker can be up to a poll old
   */
  async check(scan: PerModelLockScan): Promise<void> {
    if (scan.skippedLockIds.length === 0 || scan.waitedLocks.length === 0) {
      this.#suspect = undefined;
      await this.withdraw();
      return;
    }
    const now = Date.now();
    const self: DrainWait = {
      id: this.#id,
      pid: Deno.pid,
      hostname: this.#host,
      startedAtMs: this.startedAtMs,
      updatedAtMs: now,
      ttlMs: DRAIN_WAIT_TTL_MS,
      skipping: scan.skippedLockIds.slice(0, MAX_DRAIN_WAIT_LOCKS),
      waitingOn: scan.waitedLocks.slice(0, MAX_DRAIN_WAIT_LOCKS)
        .map((lock) => lock.lockId),
    };
    let opponent: DrainWait | undefined;
    try {
      this.#published = true;
      await this.waits.publish(self);
      opponent = drainToYieldTo(self, await this.waits.list(now), now);
    } catch (error) {
      getSwampLogger(["datastore", "lock"])
        .debug`Drain-wait marker unavailable: ${error}`;
      this.#suspect = undefined;
      return;
    }
    if (opponent === undefined) {
      this.#suspect = undefined;
      return;
    }
    const confirmed = this.#suspect?.id === opponent.id &&
      opponent.updatedAtMs > this.#suspect.updatedAtMs;
    if (!confirmed) {
      if (this.#suspect?.id !== opponent.id) {
        this.#suspect = { id: opponent.id, updatedAtMs: opponent.updatedAtMs };
      }
      return;
    }
    const skippedByOpponent = new Set(opponent.skipping);
    throw new LockWaitCycleError({
      opponentPid: opponent.pid,
      waitedMs: now - this.startedAtMs,
      waitingOnLockPaths: scan.waitedLocks
        .filter((lock) => skippedByOpponent.has(lock.lockId))
        .map((lock) => lock.lockPath),
    });
  }

  async withdraw(): Promise<void> {
    if (!this.#published) {
      return;
    }
    this.#published = false;
    try {
      await this.waits.remove(this.#id);
    } catch (error) {
      getSwampLogger(["datastore", "lock"])
        .debug`Could not remove drain-wait marker: ${error}`;
    }
  }
}

function heldForOtherRunsMessage(
  scan: PerModelLockScan,
  elapsed: number,
): string {
  const pids = [...new Set(scan.heldForOtherRuns.map((lock) => lock.pid))];
  const paths = scan.heldForOtherRuns.map((lock) => lock.lockPath).join(", ");
  return `Lock "per-model locks" — timed out after ${elapsed}ms waiting on ` +
    `${scan.held} per-model lock(s). ${scan.heldForOtherRuns.length} of ` +
    `them (${paths}) are held by swamp pid ${pids.join(", ")}, above ` +
    `this command, for another of its runs or steps, such as a ` +
    `parallel workflow step or another swamp serve run. That run keeps its ` +
    `lock until it finishes, so parallel runs that each start a nested ` +
    `structural command (for example swamp data gc) wait on each other. ` +
    `Run those commands one at a time, or in a workflow step of their own.`;
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
  /** the command's own lease at serve, which a commit ending the hold may end */
  releasableLease: () => string | undefined;
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
  release: string | undefined,
): Promise<void> {
  let outcome: Awaited<ReturnType<typeof checkpointOpenUnitOfWork>>;
  try {
    outcome = await checkpointOpenUnitOfWork(
      repoContext,
      release === undefined ? undefined : { release },
    );
  } catch (error) {
    getSwampLogger(["cli", "lock"])
      .warn`Could not commit this step's writes before releasing its lock at serve; the run's end commit tries again: ${error}`;
    return;
  }
  if (outcome === "refused") {
    throw new CommitLeaseLostError(
      "Serve refused this step's writes while it held the behavior's lock: " +
        "the lease may have lapsed. See 'swamp datastore lock status'",
    );
  }
}

export function cancelOnLeaseLost(
  leaseLost: AbortSignal | undefined,
  controller: AbortController,
): void {
  if (leaseLost === undefined) return;
  if (leaseLost.aborted) {
    controller.abort(leaseLost.reason);
    return;
  }
  leaseLost.addEventListener(
    "abort",
    () => controller.abort(leaseLost.reason),
    { once: true },
  );
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
  /** a cancelled run still publishes what it produced */
  ignoresStop?: boolean;
  /** stops every lock wait; nothing taken so far stays held */
  signal?: AbortSignal;
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
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
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
          await pollDelay(1_000, signal);
          signal?.throwIfAborted();
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
        ignoresStop: true,
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
      options?.signal,
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
              ...(options?.ignoresStop === true ? { ignoresStop: true } : {}),
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
        signal: options?.signal,
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
              await pollDelay(1_000, options?.signal);
              options?.signal?.throwIfAborted();
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
  // the one lease at serve a command holds here, which its last commit ends
  const releasableLease = (): string | undefined => {
    const leases = heldLocks.flatMap((lock) =>
      lock instanceof ServeLock && lock.lease !== undefined
        ? [lock.lease.leaseId]
        : []
    );
    return leases.length === 1 ? leases[0] : undefined;
  };
  const flush = async (written?: readonly WrittenVersion[]) => {
    try {
      if (atServe && options?.repoContext !== undefined) {
        await checkpointStepUnderLease(
          options.repoContext,
          releasableLease(),
        );
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
    releasableLease,
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

export interface VaultSyncResult {
  flush: () => Promise<void>;
}

/**
 * vault secrets stay in always-local .swamp/secrets and vault configs sync
 * through pushManagedConfigChanges and the read-only pull, so this hook covers
 * neither and its flush is a no-op
 */
export function acquireVaultSync(
  _config: DatastoreConfig,
  _syncService?: DatastoreSyncService,
  _repoDir?: string,
): Promise<VaultSyncResult> {
  return Promise.resolve({ flush: () => Promise.resolve() });
}

export { createDatastoreLock, datastoreGlobalLockOptions };
