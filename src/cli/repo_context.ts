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
 * CLI adapter for validating repository initialization.
 *
 * This module bridges CLI commands with the domain's RepoService by:
 * - Checking if a directory is an initialized swamp repository
 * - Throwing clear errors when not initialized
 */

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
import { resolveDatastoreConfig } from "./resolve_datastore.ts";
import { RENAMED_DATASTORE_TYPES } from "../domain/datastore/renamed_datastore_types.ts";
import {
  extensionCandidateNames,
  type ExtensionLookupPort,
} from "../domain/extensions/extension_auto_resolver.ts";
import { datastoreExtensionCandidates } from "../domain/datastore/datastore_extension_candidates.ts";
import { DefaultDatastorePathResolver } from "../infrastructure/persistence/default_datastore_path_resolver.ts";
import type { DatastorePathResolver } from "../domain/datastore/datastore_path_resolver.ts";
import { ensureDir, walk } from "@std/fs";
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
  isCustomDatastoreConfig,
  resolveLockTimeoutMs,
  resolveSyncTimeoutMs,
} from "../domain/datastore/datastore_config.ts";
import {
  isShareableDatastore,
  slowLockAdvice,
} from "../domain/datastore/slow_lock_advice.ts";
import type { DatastoreProvider } from "../domain/datastore/datastore_provider.ts";
import {
  HydrateContractViolationError,
  type LostModelLock,
  ModelLockLostError,
  UnpublishedDataVersionError,
} from "../domain/datastore/datastore_sync_service.ts";
import type {
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
import { runInRootUnitOfWork } from "../infrastructure/persistence/repo_unit_of_work.ts";
import { atomicWriteFile } from "../infrastructure/persistence/atomic_write.ts";
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

// Lock and sync progress is commentary, so `-q` silences it. Set once per
// invocation from the CLI's global action (swamp-club#2257).
let lockProgressQuiet = false;

/** Silence lock-wait and datastore sync progress for this invocation. */
export function setLockProgressQuiet(quiet: boolean): void {
  lockProgressQuiet = quiet;
}

const writeStderrLine = (line: string): void => console.error(line);

/**
 * Has a v3 checkout's recovery of an interrupted writer say on stderr that
 * it is running, as lock and sync progress does (swamp-club#3893). Set once
 * per invocation from the CLI's global action.
 */
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
    if (lockProgressQuiet) return;
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
  holdV3Writer,
  v3BucketNamespacedStoreAt,
  type V3DatastoreConfig,
  v3DatastoreConfigOf,
  v3RepositoryFactoryConfig,
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
import { resolveGitMainWorktreeRoot } from "../infrastructure/persistence/git_worktree.ts";
import type { ExtensionWorkflowRepository } from "../infrastructure/persistence/extension_workflow_repository.ts";

/**
 * Resolves source workflow directories from `.swamp-sources.yaml`.
 * Results are cached per repoDir to avoid re-reading and re-expanding on
 * every call (multiple repo context functions call this per command).
 * Returns an empty array if no sources are configured or file doesn't exist.
 */
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
  const sourceBaseDir = await resolveGitMainWorktreeRoot(repoDir);
  const expanded = await expandSourcePaths(
    sourcesConfig,
    repoDir,
    sourceBaseDir,
  );
  const { resolved } = await resolveSourceExtensionDirs(expanded);
  const dirs = collectDirsForKind(resolved, "workflows");
  sourceWorkflowDirCache.set(repoDir, dirs);
  return dirs;
}

/**
 * Re-enumerates the source and pulled-extension workflow directories and
 * points the extension workflow repository at them. The repository context
 * enumerates these once, when it is created; callers that change what is on
 * disk afterwards (a managed-config pull, a reload) call this to catch up.
 *
 * @returns The number of pulled-extension workflow directories found
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

/**
 * A `LibSwampContext` for a CLI command whose write use cases go through
 * `repoContext`'s repositories. Each use case's unit of work is bound to
 * `repoContext.markDirty` itself, so the repositories stage into it (datastore
 * rework Phase 2, swamp-club#3025). With no hook (filesystem datastores,
 * read-only contexts) it behaves as `createLibSwampContext`.
 */
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
 * Bridges a `DatastoreSyncService` into a `MarkDirtyHook` that repositories
 * can call without knowing the cache root. Repositories pass the absolute
 * path of the about-to-be-written file (or `undefined` for bulk mutations);
 * the hook computes the cache-relative form and forwards it to the sync
 * service via `DatastoreSyncOptions.relPath`.
 *
 * Path conversion: `relative(cacheRoot, absPath)` then forward-slash
 * normalize. Forward-slash on the wire is the cross-platform key
 * convention (matching `.datastore-index.json`); extensions consuming
 * `relPath` for disk access on Windows convert back to native separators.
 *
 * When the path is outside cacheRoot (e.g. repo-local `.swamp/outputs/`
 * vs a remote cache at `~/.swamp/repos/<id>/`), the relative result starts
 * with `..`. In that case we fall back to `relative(repoSwampDir, absPath)`
 * — both trees share the same internal layout, so either root produces a
 * usable cache-relative key.
 *
 * A path outside both roots (repo-local `models/`, `workflows/` or `vaults/`
 * without managedConfig) is never synced, so the hook sends nothing. The
 * S3 and GCS extensions treat an escaping relPath as bulk invalidation, so
 * forwarding it would turn the next push into a walk of the whole cache.
 * A cross-drive `relative()` result on Windows is absolute, not `..`.
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

/**
 * The cache-relative, forward-slash path {@link buildMarkDirtyHook} marks for
 * `absPath`, or undefined for a path outside both roots, which it never
 * marks. Exported so tests can map staged changes to the marks they cause.
 */
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

/**
 * The repository's foreign content fetcher over a sync service, or undefined
 * when there is no sync service or it cannot read another namespace.
 */
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
    // Outside the cache the datastore writes somewhere other than absPath,
    // so only a path inside it can hold the datastore to its claim.
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
 * Whether a `relative(root, path)` result points outside `root`: a `..`
 * segment first, or an absolute path (cross-drive on Windows). A first
 * segment that merely starts with two dots (`..hidden`) is inside the root.
 */
function escapesRoot(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${SEPARATOR}`) || isAbsolute(rel);
}

/**
 * Options for requireInitializedRepo.
 */
export interface RequireRepoOptions {
  repoDir: string;
  outputMode: OutputMode;
  /**
   * On a v3 datastore, take the writer lease again once another writer has
   * taken it over and finished, rather than refusing every later commit.
   * Serve's lifetime hold sets it; a one-shot command fails as a whole
   * instead (swamp-club#3359).
   */
  retakeLostV3Lease?: boolean;
  /**
   * Give up after this long, instead of the lock timeout, when the datastore
   * lock or a per-model lock another process holds is not free. The
   * end-of-command retention pass sets it so a busy repository skips the
   * pass rather than holding up the command (swamp-club#3473).
   */
  lockWaitMs?: number;
  /**
   * Skip the coordinator's implicit pull-at-startup and push-at-flush.
   * The lock is still acquired (so concurrent writers are blocked), but
   * no sync service is registered with the coordinator. Used by the
   * `swamp datastore sync` command, which owns its own pull/push and
   * must not race with the coordinator's implicit phase — without this
   * flag the implicit pull silently moves files and the explicit pull
   * fast-paths to 0, causing `filesPulled: 0` to be reported even when
   * data was hydrated. See lab #220.
   */
  skipImplicitSync?: boolean;
  /**
   * Pull the config tier from the remote datastore before reading.
   * Only effective under managedConfig with a custom datastore — a no-op
   * for filesystem datastores. Used by read-only commands that need
   * fresh remote state (e.g. `vault get --pull` from a fresh container).
   */
  pull?: boolean;
}

/** Options for {@link ensureManagedConfigBase}. */
export interface EnsureManagedConfigBaseOptions {
  /**
   * When false, resolve with installed datastore extensions only: a missing
   * datastore extension is never auto-installed. Defaults to true.
   */
  autoResolve?: boolean;
}

/**
 * Pre-populates the module-level managed config registry by resolving the
 * datastore config. Call this before {@link resolveManagedConfigPaths} in
 * commands that use {@link requireRepoMarker} (lightweight, no datastore
 * resolution) so resolveManagedConfigPaths resolves the correct
 * cache-relative base path for custom datastores (S3, GCS) when no
 * explicit `configBasePath` argument is provided.
 *
 * Commands that go through {@link requireInitializedRepo} /
 * {@link requireInitializedRepoReadOnly} / {@link requireInitializedRepoUnlocked}
 * already pass `configBasePath` to resolveManagedConfigPaths and do NOT need
 * this call.
 *
 * When the datastore cannot be resolved (its extension is not installed or
 * does not load), nothing is registered here: resolveManagedConfigPaths then
 * records the in-repo `.swamp/config` fallback as unresolved, and write
 * commands refuse it (see {@link assertManagedConfigWritable}). The datastore
 * type registry's loaded flag is reset so a later attempt rescans for the
 * extension. Transient `lock_timeout` errors are rethrown rather than
 * reported as unresolved.
 *
 * @param resolverOverride Test seam — inject a mock resolver to avoid loading
 *   real datastore extensions in tests.
 * @returns Whether the base was resolved (always false for repos without
 *   managedConfig).
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

/** The most recent managed config resolution failure per repo, for errors. */
const lastResolutionFailure = new Map<string, string>();

/**
 * Resolves the lockfile path based on whether managed config is enabled.
 * When managedConfig is true it points into the managed config base (the
 * datastore config tier); when false it is `<modelsDir>/upstream_extensions.json`.
 *
 * The marker flag (`managedConfig: true` in `.swamp.yaml`) is the sole
 * authority for activation. When no explicit `configBasePath` is provided,
 * the module-level registry (populated by {@link ensureManagedConfigBase})
 * supplies the correct base for custom datastores (S3, GCS) whose config
 * tier lives at the cache path rather than repo-local `.swamp/config/`.
 * Without a registered base the in-repo `.swamp/config` fallback is used and
 * recorded as unresolved; it never replaces a resolved base.
 *
 * Pulled extension sources always live under the in-repo pulled root
 * (`resolvePulledExtensionsRoot`), whatever the config base.
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
 * Thrown when an extension command would write the managed extension
 * lockfile but the managed config base could not be resolved, so the only
 * lockfile available is the in-repo `.swamp/config` guess. Writing there
 * would never reach the datastore's lockfile (swamp-club#2483).
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

/**
 * Refuses a managed extension lockfile write when the managed config base
 * is only the in-repo guess. Applies to managedConfig repos on an
 * extension-backed datastore; filesystem datastores always resolve.
 *
 * @throws ManagedConfigUnresolvedError when the base is unresolved.
 */
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

/** Where a managed extension lockfile write should go. */
export interface ManagedLockfileWrite {
  lockfilePath: string;
  /**
   * Whether to publish the lockfile to the datastore afterwards. False when
   * the datastore-extension exemption records into the in-repo lockfile
   * because the base is unresolved; nothing in the datastore cache changed.
   */
  publish: boolean;
}

/**
 * Resolves the lockfile an extension write command should change, applying
 * the guard against writing to a guessed managed config base
 * (swamp-club#2483).
 *
 * The base is resolved as other commands resolve it, auto-installing a
 * missing datastore extension, so a fresh checkout's writes work as before.
 * When the base is resolved (or the repo does not need it), the resolved
 * lockfile is returned. When it is still unresolved on an extension-backed
 * datastore (the extension could not be installed or does not load), the
 * write is allowed only if every target is the datastore extension itself
 * (the #445 recovery path): it then records into the in-repo lockfile
 * without publishing. Otherwise {@link ManagedConfigUnresolvedError} is
 * thrown.
 *
 * @param options.exemptTargets Extension names the command writes; pass
 *   them only for commands that may repair the datastore extension
 *   (`extension pull`, `extension update <name>`).
 * @param options.extensionLookup Registry lookup used to recognise datastore
 *   extensions whose name is not a prefix of the datastore type.
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
    // Static candidates first: the usual target (`@swamp/s3-datastore`)
    // needs no registry round trip, which matters on an offline machine.
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
 * Keeps the resolution failure short for the guard's message. A missing
 * datastore extension surfaces from resolution as "Unknown datastore type"
 * (or, for the legacy `s3` type, "requires the ... extension. Install it
 * with: swamp extension pull ..."); both are reported as "its datastore
 * extension is not installed and could not be installed automatically", so
 * the error's own remedy (pull the extension) is the only one.
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

/**
 * Result of successful repo validation containing the validated directory
 * and repository context.
 */
export interface RepoValidationContext {
  repoDir: string;
  marker: RepoMarkerData | null;
  repoContext: RepositoryContext;
  datastoreResolver: DatastorePathResolver;
  lockfilePath: string;
  managedConfig?: boolean;
  /** Resolved vault config directory — the datastore config tier under managedConfig, otherwise `<repoDir>/vaults`. */
  vaultsDir: string;
}

/**
 * Lightweight repo + datastore resolution without acquiring the datastore lock.
 *
 * Used by breakglass commands (lock status, lock release) that need the
 * datastore config to inspect/release a lock but must not acquire it.
 */
export interface DatastoreResolutionResult {
  repoDir: string;
  datastoreConfig: DatastoreConfig;
  marker: RepoMarkerData | null;
  /** The engine the datastore's format marker chose (swamp-club#3279). */
  engine: DatastoreEngine;
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

  const datastoreConfig = await withSpan(
    "swamp.repo.datastore.config",
    {},
    () => resolveDatastoreConfig(marker, undefined, repoPath.value),
  );

  // Before any caller locks, pulls, pushes or writes: refuse a datastore
  // marked with a format this binary cannot read (swamp-club#3189).
  const engine = await withSpan(
    "swamp.repo.datastore.format",
    {},
    () => ensureSupportedDatastoreFormat(repoPath.value, datastoreConfig),
  );
  // A checkout that joins a v3 datastore through .swamp.yaml while its
  // .swamp holds records is refused before anything leases, catches up or
  // writes, as setup refuses it (swamp-club#3690).
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
 * The engine of the repo's datastore, decided without checking its format
 * and without reading anything remote: v3 only for a filesystem datastore
 * whose marker on disk says so. For a command that must choose how to open
 * the repo before it opens it (swamp-club#3359). Anything it cannot read
 * answers v2, so the open that follows reports it as it always has.
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

/**
 * Result of lightweight repo marker validation.
 * Contains just the repo directory and marker — no datastore config,
 * lock, or sync. Used by extension commands that manage local files
 * and don't need the datastore.
 */
export interface RepoMarkerResult {
  repoDir: string;
  marker: RepoMarkerData | null;
}

/**
 * Validates that a directory is an initialized swamp repository and reads
 * the repo marker, without resolving the datastore config, acquiring locks,
 * or registering sync.
 *
 * Use this for extension management commands (pull, update, rm, search)
 * that operate on local files in pulled-extensions/ and don't interact
 * with the datastore.
 *
 * @param repoDir - The repository directory to validate
 * @returns The validated repo directory and marker
 * @throws UserError if not initialized
 */
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
 * Validates that a directory is an initialized swamp repository without
 * acquiring the datastore lock or performing sync operations.
 *
 * Use this for read-only commands (search, get, list, validate, etc.)
 * that do not modify the datastore. This allows read-only operations to
 * run concurrently with write operations like workflow runs.
 *
 * For remote datastores, this reads from the local cache without pulling
 * latest. The cache reflects whatever was last synced by a write command.
 * For filesystem datastores, reads see writes immediately.
 *
 * On a filesystem datastore the context carries the datastore's wait
 * records, for reading. On a custom datastore it carries none: opening that
 * store pulls the namespace, which this path never does.
 *
 * @param options - The repo directory and output mode
 * @param factoryConfig - Optional factory configuration overrides
 * @returns The validated repo context
 * @throws UserError if not initialized
 */
export async function requireInitializedRepoReadOnly(
  options: RequireRepoOptions,
  factoryConfig?: Partial<Omit<RepositoryFactoryConfig, "repoDir">>,
): Promise<RepoValidationContext> {
  const { repoDir, datastoreConfig, marker, engine } = await withSpan(
    "swamp.repo.datastore.resolve",
    {},
    () => resolveDatastoreForRepo(options.repoDir),
  );
  // A v3 datastore's location: the filesystem datastore, or a bucket
  // datastore's local root (swamp-club#3534).
  const v3 = engine === "v3"
    ? await withSpan(
      "swamp.datastore.v3.bind",
      {},
      () => v3DatastoreConfigOf(repoDir, datastoreConfig),
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

  // Sync service used solely for on-demand content hydration (no lock, no
  // pull/push lifecycle). Only created when the extension advertises
  // lazyHydration and the config enables it.
  let hydrateFileHook: HydrateFileHook | undefined;
  let readOnlySyncService:
    | ReturnType<
      NonNullable<DatastoreProvider["createSyncService"]>
    >
    | undefined;

  // Verify datastore is accessible. A v3 bucket datastore syncs nothing
  // (swamp-club#3534).
  if (isCustomDatastoreConfig(datastoreConfig) && v3 === undefined) {
    // Ensure cache/datastore dir exists — no health check or lock on read-only path
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
    // No lock acquisition — read-only path
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

  // Resolve source workflow directories from .swamp-sources.yaml
  const sourceWorkflowDirs = await getSourceWorkflowDirs(repoPath.value);

  // Create repository context with the validated directory and datastore resolver
  // A v3 datastore's context commits through the commit log and reads the
  // read model's catalog (swamp-club#3279).
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

  // A read shows what a wait record says of a step, such as the receipt of
  // a signal no resume has applied yet (swamp-club#3110). Only a filesystem
  // or v3 datastore's records are read here: a v2 custom datastore's store
  // pulls its namespace when it opens, and this path neither syncs nor holds
  // the lock. The store is given without the save hook `attachSignalWaits`
  // installs, so the context writes no wait record.
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
 * Commits the repo's existing definitions, workflows and vault configs into
 * a v3 datastore's config tier when managedConfig is on and the commit log
 * has never held them (swamp-club#3300): managedConfig set by hand in
 * `.swamp.yaml` keeps the config the repo already has, as `swamp datastore
 * config migrate` does. Once adopted, a name has commits and is never
 * adopted again. A refusal (another checkout committed a name first) is a
 * warning: the command goes on, and the next one adopts nothing for those
 * names.
 */
async function adoptManagedConfigOnV3(
  repoContext: RepositoryContext,
  repoDir: string,
  config: V3DatastoreConfig,
  configBase: string,
  marker: RepoMarkerData | null,
): Promise<void> {
  const logger = getSwampLogger(["cli", "managed-config"]);
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
    // Reported with the adoption that left them out, not on every command.
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

/**
 * Warns a read-only command that managedConfig hides repo config the v3
 * commit log has never held: it cannot commit, so it says what will
 * (swamp-club#3300). It only warns, so nothing it meets fails the command.
 */
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

/** The repo's own extension lockfile, where it lives without managedConfig. */
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

/**
 * Validates that a directory is an initialized swamp repository.
 *
 * Acquires the datastore lock and performs sync operations (pull on start,
 * push on end). Use this for commands that modify the datastore.
 *
 * For read-only commands, use requireInitializedRepoReadOnly() instead
 * to avoid blocking on the datastore lock.
 *
 * @param options - The repo directory and output mode
 * @param factoryConfig - Optional factory configuration overrides
 * @returns The validated repo context
 * @throws UserError if not initialized
 */
export function requireInitializedRepo(
  options: RequireRepoOptions,
  factoryConfig?: Partial<Omit<RepositoryFactoryConfig, "repoDir">>,
): Promise<RepoValidationContext> {
  return withSpan("swamp.repo.init", {}, async () => {
    const { repoDir, datastoreConfig, marker, engine } =
      await resolveDatastoreForRepo(
        options.repoDir,
      );
    // Teardown may run a retention pass on a repository opened to write
    // (swamp-club#3473).
    noteRetentionCandidate(repoDir);
    // A v3 datastore takes one writing process at a time; join this
    // process's hold before any other lock (swamp-club#3279). A bucket
    // datastore's is at its local root (swamp-club#3534).
    const v3 = engine === "v3"
      ? await v3DatastoreConfigOf(repoDir, datastoreConfig)
      : undefined;
    if (v3 !== undefined) {
      await holdV3Writer(v3, repoDir);
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

    // Track whether a remote sync happened so we can invalidate the catalog
    let needsCatalogInvalidation = false;

    // Sync service is shared between the coordinator (pull/push) and the
    // repositories (markDirty on cache writes). Hoisted so both wirings
    // reference the same instance.
    let syncService:
      | ReturnType<
        NonNullable<DatastoreProvider["createSyncService"]>
      >
      | undefined;

    // Verify datastore is accessible. A v3 bucket datastore syncs nothing:
    // it locks and commits as a filesystem v3 datastore does, at its local
    // root (swamp-club#3534).
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

      // If the custom provider supports sync, register sync service too
      syncService = lockConfig.cachePath
        ? provider.createSyncService?.(
          repoPath.value,
          lockConfig.cachePath,
        )
        : undefined;

      if (lockConfig.cachePath) {
        await ensureDir(lockConfig.cachePath);
      }

      // See `RequireRepoOptions.skipImplicitSync` JSDoc. When set, the
      // sync service is not registered with the coordinator (no implicit
      // pull/push); the repository factory still receives it for
      // markDirty hooks, harmlessly so for explicit-sync callers that
      // don't write through repositories.
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
      // Invalidate catalog after pull so next query backfills from fresh data
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

      // Symmetric drain — see design/enablers/datastores.md "Lock Lifecycle".
      //
      // First drain: wait for any per-model locks visible at command start
      // to be released. A writer that has *already* acquired a per-model
      // lock and passed its TOCTOU recheck (acquireModelLocks, this file)
      // is committed to writing data; we must let it finish.
      await waitForPerModelLocks(
        lockConfig.path,
        lockConfig.namespace,
        { maxWaitMs: options.lockWaitMs },
      );

      // Acquire the global lock. From here on, any writer that inspects
      // the global lock will back off — but a writer that slipped past the
      // first drain may have acquired a per-model lock between the drain
      // ending and this acquisition, so its in-flight write would still
      // race our structural work.
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

      // Second drain: with the global lock now held, wait for any such
      // straggling per-model locks to release. Writers in the middle of
      // their own TOCTOU recheck will see the global lock and abandon
      // their per-model lock; writers already past the recheck and into
      // the data write must finish before we touch the filesystem. This
      // closes the symmetric TOCTOU window — do not remove without
      // updating the lock-lifecycle contract documented in
      // design/enablers/datastores.md.
      //
      // The locks this drain skips are listed in the global lock before it
      // ends, so a holder taking one back from a hop that has ended waits
      // for this command instead of writing under it.
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

    // Resolve source workflow directories from .swamp-sources.yaml
    const sourceWorkflowDirs = await getSourceWorkflowDirs(repoPath.value);

    // Create repository context with the validated directory and datastore resolver
    // A v3 datastore's context commits through the commit log and reads the
    // read model's catalog (swamp-club#3279).
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
    );

    // If a remote sync pulled fresh data, invalidate the catalog so the
    // next query backfills from the freshly-pulled local cache.
    if (needsCatalogInvalidation) {
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

/**
 * Validates that a directory is an initialized swamp repository without
 * acquiring any lock. Returns the repo context plus the datastore config
 * so callers can acquire per-model locks after resolving which model(s)
 * they target.
 *
 * Use this for model-scoped commands (model method run, workflow run)
 * that acquire per-model locks AFTER resolving which model they target.
 *
 * @param options - The repo directory and output mode
 * @param factoryConfig - Optional factory configuration overrides
 * @returns The validated repo context and datastore config
 * @throws UserError if not initialized
 */
export async function requireInitializedRepoUnlocked(
  options: RequireRepoOptions,
  factoryConfig?: Partial<Omit<RepositoryFactoryConfig, "repoDir">>,
): Promise<
  RepoValidationContext & {
    datastoreConfig: DatastoreConfig;
    /**
     * Single sync service instance shared by this repo context's markDirty
     * hook and any subsequent `acquireModelLocks` pull/push call. Undefined
     * for filesystem datastores or custom datastores without a cache. Passed
     * into `acquireModelLocks` so cache writes and the fast-path watermark
     * read go through the same instance — implementations that cache the
     * sidecar flag in memory stay coherent. See `design/enablers/datastores.md`.
     */
    syncService?: DatastoreSyncService;
  }
> {
  const { repoDir, datastoreConfig, marker, engine } =
    await resolveDatastoreForRepo(
      options.repoDir,
    );
  // Teardown may run a retention pass on a repository opened to write
  // (swamp-club#3473).
  noteRetentionCandidate(repoDir);
  // A v3 datastore takes one writing process at a time; join this process's
  // hold before any model lock (swamp-club#3279). A bucket datastore's is
  // at its local root (swamp-club#3534).
  const v3 = engine === "v3"
    ? await v3DatastoreConfigOf(repoDir, datastoreConfig)
    : undefined;
  if (v3 !== undefined) {
    await holdV3Writer(v3, repoDir, {
      ...(options.retakeLostV3Lease === true ? { retakeLost: true } : {}),
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

  let syncService: DatastoreSyncService | undefined;

  // Verify datastore is accessible (same checks as requireInitializedRepo).
  // A v3 bucket datastore syncs nothing (swamp-club#3534).
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

  // Resolve source workflow directories from .swamp-sources.yaml
  const sourceWorkflowDirs = await getSourceWorkflowDirs(repoPath.value);

  // Create repository context with the validated directory and datastore resolver
  // A v3 datastore's context commits through the commit log and reads the
  // read model's catalog (swamp-club#3279).
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
  };
}

/**
 * Initial retry interval for per-model locks.
 *
 * A per-model lock is released as soon as its method run finishes, so
 * `FileLock`'s 1s default meant a waiter slept through a release that
 * happened milliseconds later. Backoff doubles from here up to
 * {@link MODEL_LOCK_MAX_BACKOFF_MS}.
 */
export const MODEL_LOCK_RETRY_INTERVAL_MS = 25;

/**
 * Ceiling for the per-model lock's doubling backoff.
 *
 * A workflow step holds its model's lock for the whole method run, so
 * concurrent steps against one instance (e.g. `forEach` iterations) queue on
 * it. Under `FileLock`'s 8s default the tail of that queue slept for seconds
 * after each release (swamp-club#2870); this cap keeps every waiter within a
 * quarter second of the holder letting go.
 */
export const MODEL_LOCK_MAX_BACKOFF_MS = 250;

/**
 * Creates a per-model distributed lock.
 *
 * Lock key: `data/{modelType}/{modelId}/.lock`
 */
export async function createModelLock(
  datastoreConfig: DatastoreConfig,
  modelType: string,
  modelId: string,
): Promise<DistributedLock> {
  // A v3 bucket datastore locks as a filesystem one (swamp-club#3534).
  const config = lockingConfigOf(datastoreConfig);
  const lockKey = modelLockKey(config.namespace, modelType, modelId);
  const maxWaitMs = resolveLockTimeoutMs();
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

/**
 * Creates the distributed lock behind a workflow run's claim.
 *
 * A claim is held for one load, decision and save of the run record, so it
 * uses the per-model lock's short retry settings. A resume's take-over also
 * restores the run's sensitive values under it, which can read a vault.
 */
export async function createWorkflowRunLock(
  datastoreConfig: DatastoreConfig,
  runId: string,
): Promise<DistributedLock> {
  // The id becomes part of the lock's path. A run id is always a UUID.
  if (!isUuid(runId)) {
    throw new UserError(`Not a workflow run id: ${runId}`);
  }
  // A v3 bucket datastore locks as a filesystem one (swamp-club#3534).
  const config = lockingConfigOf(datastoreConfig);
  const lockKey = workflowRunLockKey(config.namespace, runId);
  const maxWaitMs = resolveLockTimeoutMs();
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

/**
 * Claims on the repository's workflow runs, each backed by a datastore lock,
 * so they exclude every swamp process that writes the same datastore.
 */
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
 * Whether signal waits can be used on this datastore, with the store for
 * their records (swamp-club#3093). The records must be visible to every
 * process that can settle a wait, so they live with the datastore, never
 * under the repository:
 *
 * - A filesystem datastore keeps them under its own path, below the
 *   namespace when one is set, so every repository on that datastore sees
 *   them.
 * - A custom datastore keeps them in its extension's control-plane store,
 *   which must create a record atomically (`putIfAbsent`).
 * - Any other datastore does not support waits: a store local to this
 *   machine would accept a signal the run's own host never sees.
 */
export function resolveSignalWaitSupport(
  config: DatastoreConfig,
  syncService?: DatastoreSyncService,
  options?: {
    /**
     * The sync service is already bound to the datastore's namespace, as in
     * `swamp serve` after boot, so the store is used as it is.
     */
    namespaceBound?: boolean;
    /**
     * Run records are stored in the datastore itself, beside the wait
     * records (see {@link runsLiveInDatastore}). Only a filesystem
     * datastore of which this is true lets the sweep judge a wait by its
     * run record.
     */
    runsInDatastore?: boolean;
    /**
     * The datastore's v3 location, when it is a v3 one: a bucket
     * datastore's wait records live in its datastore-wide control plane,
     * under its namespace's reserved prefix (swamp-club#3534).
     */
    v3?: V3DatastoreConfig;
  },
): SignalWaitSupport {
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
  // The extension's store is not created here. The S3 and GCS extensions
  // bind their namespace for good on the first sync or control-plane call,
  // and older versions fix the store's list prefix when it is created, so
  // a store made before a namespaced pull would look under the wrong
  // prefix. Every command builds a repository context; only one that uses
  // a wait opens the store.
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

/**
 * The continuation claims of a control-plane store, for one holder. What is
 * known of another holder comes from the serve heartbeats in the same store.
 */
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

/** How long one read of a run record from the remote datastore may take. */
export const RUN_RECORD_FETCH_TIMEOUT_MS = 30_000;

/**
 * Compares this host's record of a run with the one its synced datastore
 * holds, byte for byte (swamp-club#3108). Undefined on a filesystem
 * datastore, where both are one file, and for a sync service that cannot
 * read a remote file without replacing the cached one (`fetchContent`).
 * Only for a repository whose run records are stored in the datastore
 * ({@link runsLiveInDatastore}): one that keeps them to itself has no remote
 * copy to compare with.
 *
 * A record with a change this host has not pushed yet also reads as
 * different; the caller leaves the run for a later attempt.
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
 * The continuation claims a local command takes when it resumes a run
 * (swamp-club#3108), in the store `swamp serve` keeps its heartbeats in:
 *
 * - A filesystem datastore keeps them under the repository, as serve does
 *   when its datastore has no control-plane store of its own.
 * - A custom datastore keeps them in its extension's control-plane store.
 *   Without one there are no claims, and a resume takes none.
 */
export function resolveContinuationClaims(
  config: DatastoreConfig,
  repoDir: string,
  syncService?: DatastoreSyncService,
): ContinuationClaims | undefined {
  // A v3 bucket datastore keeps them under the repository as a filesystem
  // one does: serve's heartbeats are there too (swamp-club#3534).
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
 * Whether workflow run records are stored in the datastore, where wait
 * records are, and not kept in the repository by the datastore's
 * `directories` or `exclude` settings. Repositories that share a datastore
 * but keep their runs to themselves cannot see each other's runs, so none
 * of them can tell a deleted run from another repository's.
 */
export function runsLiveInDatastore(resolver: DatastorePathResolver): boolean {
  return resolver.isDatastoreSubdir(SWAMP_SUBDIRS.workflowRuns) &&
    !resolver.isExcluded(SWAMP_SUBDIRS.workflowRuns);
}

/**
 * The retention watermarks of a datastore (swamp-club#3473). Like signal
 * waits they live with the datastore, never under the repository, so every
 * process sharing it sees the same records:
 *
 * - A filesystem datastore keeps them under its own path, below the
 *   namespace when one is set.
 * - A custom datastore keeps them in its extension's control-plane store,
 *   opened on first use after a namespaced pull.
 * - A custom datastore without an atomic control-plane store has none:
 *   retention still runs, and lookups give the plain not-found answer.
 */
export function resolveRetentionWatermarks(
  config: DatastoreConfig,
  syncService?: DatastoreSyncService,
  options?: {
    namespaceBound?: boolean;
    /**
     * The datastore's v3 location, when it is a v3 one: a bucket
     * datastore's watermarks live in its datastore-wide control plane,
     * under its namespace's reserved prefix (swamp-club#3534).
     */
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
 * Gives a repository context its wait support. With a store, every run its
 * repository saves as ended closes its waits first, so no path that ends a
 * run leaves a wait accepting signals.
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

/** The wait support a repository context carries, or none configured. */
export function signalWaitsOf(
  repoContext: Pick<RepositoryContext, "signalWaits">,
): SignalWaitSupport {
  return repoContext.signalWaits ?? SIGNAL_WAITS_NOT_CONFIGURED;
}

/**
 * The control-plane store of a custom datastore, opened on first use: the
 * sync service is bound to `namespace` by a pull when one is given (the
 * only call that binds, as in `initializeControlPlaneVaultForCli`), and
 * only then is the store created. `open` rejects with `notAtomic` when the
 * store lacks `putIfAbsent`. A failed open is tried again by the next call.
 *
 * The pull can therefore happen partway through a command, as the pulls of
 * `acquireModelLocks` do. It brings remote changes into the cache and does
 * not discard this command's own unpushed writes, and a run being resumed
 * or saved is held in memory and written after.
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

/**
 * One scan of the per-model locks a structural command's drain waits on.
 */
export interface PerModelLockScan {
  /** Live (non-stale) locks the drain waits on. */
  held: number;
  /**
   * Those of `held` that a swamp above this one holds for another of its
   * runs or steps, by lock file path relative to the datastore. They are
   * released only when that run finishes (design/enablers/datastores.md,
   * "Parent-Process Lock Awareness").
   */
  heldForOtherRuns: ReadonlyArray<{ pid: number; lockPath: string }>;
  /**
   * The nonces of the live locks the scan skipped because a swamp above
   * this one named them as held for the run that started it. Locks skipped
   * on the pid alone are left out.
   */
  skippedLockIds: readonly string[];
  /** Those of `held` whose lock file records a nonce. */
  waitedLocks: ReadonlyArray<{ lockId: string; lockPath: string }>;
}

/**
 * The drain-wait markers a drain publishes and reads; `DrainWaitStore` in
 * production.
 */
export type DrainWaits = Pick<DrainWaitStore, "publish" | "list" | "remove">;

/** Optional behaviour for {@link waitForPerModelLocks}. */
export interface WaitForPerModelLocksOptions {
  /** Where progress lines go. Defaults to the system-labelled stderr line. */
  progressWriter?: LockProgressWriter;
  /** Test seam: replaces the scan of the datastore's lock files. */
  findModelLocks?: () => Promise<PerModelLockScan>;
  /** Test seam: the marker that says which locks this process inherited. */
  lockHolderMarker?: LockHolderMarker;
  /** Test seam: the drain-wait markers of the datastore. */
  drainWaits?: DrainWaits;
  /** Test seam: how long to pause between scans. */
  pollIntervalMs?: number;
  /** How long to wait before giving up; defaults to the lock timeout. */
  maxWaitMs?: number;
  /**
   * Records the nonces of the locks the drain skips; the drain under the
   * global lock passes that lock's `publishSkipping`. The drain then ends
   * only on a scan that matches the list already recorded.
   */
  publishSkipping?: (lockIds: readonly string[]) => Promise<void>;
}

const DRAIN_POLL_INTERVAL_MS = 1_000;

/**
 * Waits for any held per-model locks to be released.
 *
 * Called twice during structural command setup (`requireInitializedRepo`):
 * once before acquiring the global lock to drain in-flight writers, and
 * once after to catch writers that slipped past the first drain. See
 * design/enablers/datastores.md "Lock Lifecycle" for the full contract.
 *
 * Only works for filesystem datastores — S3 datastores use distributed
 * locks that cannot be scanned locally.
 *
 * While it waits, the drain publishes a drain-wait marker and reads the
 * other drains' markers. Two drains that each wait on a lock held until the
 * other exits would both run into the lock timeout, so the later one throws
 * a `LockWaitCycleError` instead (design/enablers/datastores.md,
 * "Parent-Process Lock Awareness").
 *
 * Returns the nonces of the locks its last scan skipped.
 *
 * The test seams in `options` are for tests only — production callers pass
 * at most `progressWriter` and `publishSkipping`. Not exported from any
 * barrel.
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
              // A holder is mid-write (create, or a heartbeat rewrite), so
              // the lock is held; it cannot say for whom, so it is never
              // skipped as an ancestor's (swamp-club#3148).
              if (state.fresh) held++;
              continue;
            }
            const info = state.info;
            // Skip locks held for the run that started this one: those
            // handed down by nonce, or an ancestor swamp's on this host
            // (prevents deadlock when a workflow shell step spawns a nested
            // swamp command).
            const relation = relationTo(info);
            // Only count non-stale locks
            const acquiredAt = new Date(info.acquiredAt).getTime();
            const live = Date.now() - acquiredAt <= info.ttlMs;
            if (relation === "ancestor") {
              // A lock skipped on the pid alone may be held for another run
              // and released while this drain still waits, so it is not
              // reported as held until this drain exits.
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

  // With a publisher (the drain under the global lock), every change to the
  // skipped set is published before the drain sleeps or returns, and the
  // drain ends only on a scan that matches what is already published. A
  // holder re-keys its lock and then reads the list; this publishes the
  // list and then reads the lock, so one of them always sees the other. A
  // lock found re-keyed leaves the list before the drain waits on it, so
  // the drain and the holder's reclaim never wait on each other.
  let published: readonly string[] = [];
  const confirm = async (scan: PerModelLockScan): Promise<boolean> => {
    if (options.publishSkipping === undefined) return true;
    // Capped as the lock file caps it, so a longer list still confirms.
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
      // The first list published is confirmed at once; after that every
      // scan is a poll apart, so a skipped set that keeps changing cannot
      // spin the drain.
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
 * One drain's own drain-wait marker, and its watch for a drain it must give
 * way to. Marker I/O that fails is logged and otherwise ignored: the drain
 * then just waits, as it did before markers existed.
 */
class PublishedDrainWait {
  readonly #id = crypto.randomUUID();
  readonly #host = hostname();
  #published = false;
  /** The drain to yield to as of the last check, and its marker's age. */
  #suspect: { id: string; updatedAtMs: number } | undefined;

  constructor(
    private readonly waits: DrainWaits,
    private readonly startedAtMs: number,
  ) {}

  /**
   * Publishes this drain's wait for `scan`, then throws
   * `LockWaitCycleError` once another drain it must give way to has been
   * seen on two checks in a row and has refreshed its marker in between.
   * One sighting is not enough: a marker can be up to a poll old, and its
   * drain may already be moving on.
   */
  async check(scan: PerModelLockScan): Promise<void> {
    // A drain that skips nothing, or waits on nothing it can name, is in no
    // other drain's way and publishes nothing.
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

  /** Removes this drain's marker, if it published one. */
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

/**
 * The timeout message for a drain still waiting on locks a swamp above it
 * holds for another of its runs, which a nested structural command cannot
 * outwait when that run is itself waiting on a nested structural command.
 */
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

/**
 * Acquires per-model locks in sorted order (deadlock prevention).
 *
 * Checks for the global `.datastore.lock` before acquiring per-model locks.
 * If a structural command holds the global lock, per-model acquisition
 * waits for it to release (reuses existing stale detection).
 *
 * For custom datastores with sync support, pulls model-scoped files after
 * acquiring per-model locks, and the returned flush function pushes changed
 * files under a brief global lock.
 *
 * Registers each lock with the coordinator so SIGINT cleanup works.
 *
 * @returns A flush function that releases all acquired per-model locks
 *          (and pushes changes for sync-capable datastores).
 */
export interface ModelLockResult {
  /**
   * {@link push}, then {@link release} even when the push fails. Its one
   * remaining caller is the per-step model lock in a workflow run
   * (`StepLockResult.flush`, run by `DefaultStepExecutor`): the step's lock
   * owns its push and release, and Phase 3 replaces model locks with leases
   * (swamp-club#3055). Everything else pushes through a root unit of work
   * with {@link push} and calls {@link release} after the root ends.
   */
  flush: (written?: readonly WrittenVersion[]) => Promise<void>;
  /**
   * Pushes changed files for sync-capable datastores (single- or two-phase),
   * without releasing the locks. A command that runs in a root unit of work
   * passes this as the root's flush and calls {@link release} after the root
   * has ended (swamp-club#3033).
   */
  push: () => Promise<void>;
  /**
   * {@link push}, given the data versions the work under these locks wrote:
   * it publishes each one and checks the remote holds it, retrying a
   * bounded number of times; see {@link AcquireModelLocksOptions.dataRepo}
   * (swamp-club#3146). A root calls its flush with its outcome, so pass
   * this to a root through a closure.
   */
  pushWritten: (written: readonly WrittenVersion[]) => Promise<void>;
  /** Releases every per-model lock these locks took. */
  release: () => Promise<void>;
  /**
   * True if a remote datastore pull during lock acquisition may have changed
   * the local cache, so callers must invalidate the catalog. False when every
   * pull reported 0 files: skipping the invalidation spares a full catalog
   * backfill while the lock is held (swamp-club#2553).
   */
  synced: boolean;
  /**
   * The nonces of the filesystem lock files these locks wrote. Run the work
   * done under the locks inside `processLockHolderMarker.runHolding` with
   * them, so a swamp it starts skips these locks and no others
   * (design/enablers/datastores.md, "Parent-Process Lock Awareness"). Empty
   * for custom datastore locks, which the drain never scans.
   *
   * A snapshot taken when the locks were acquired: a re-key changes the
   * nonces, so never hand this list to a child. Use {@link lentLocks}.
   */
  heldLockIds: readonly string[];
  /**
   * The same locks as a scope lends them: their nonces read live, and the
   * reclaim that ends a hand-off ({@link reclaimModelLocks}). Pass these to
   * the scope in place of {@link heldLockIds}, so a swamp left over from a
   * hop that has ended stops skipping them.
   */
  lentLocks: LentLocks;
}

/** Test seams and settings for {@link reclaimModelLocks}. */
export interface ReclaimModelLocksOptions {
  /** How long to wait on a structural command; the lock timeout by default. */
  timeoutMs?: number;
  /** How often to re-read the global lock while waiting. */
  pollMs?: number;
  progressWriter?: LockProgressWriter;
  /** The global lock's name in a {@link LockTimeoutError}. */
  displayKey?: string;
  /** Test seam: whether a process on this host has exited. */
  isProcessDead?: (pid: number) => boolean;
  /**
   * The signal of the run whose locks these are. Once it aborts, a
   * structural command known to be still at work is no longer waited on.
   */
  signal?: AbortSignal;
}

/** Waits `ms`, or until `signal` aborts. */
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
 * Takes per-model locks back from a hop that has ended
 * (design/enablers/datastores.md, "Parent-Process Lock Awareness").
 *
 * Re-keys each lock, so a nested swamp the hop left running no longer
 * matches it and waits like any other. A structural command that skipped
 * one of them before the re-key may still be working: it lists the nonces
 * it skipped in its global lock, so while that list names a retired nonce
 * this waits, re-reading the list on every poll. The command withdraws a
 * nonce it finds re-keyed before it waits on that lock, so the two never
 * wait on each other.
 *
 * Pass `options.signal` for a run whose hop was cancelled: it has nothing
 * to write, so it does not wait. The locks are re-keyed as always, and the
 * wait ends as soon as the signal aborts.
 *
 * @throws {LockTimeoutError} when the structural command is still working
 * under a retired nonce at the timeout. The caller must then write nothing.
 * @throws {DOMException} `AbortError` when it is still working and the
 * signal has aborted. The caller must then write nothing.
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
      // A structural command killed with its hop (a shell step's timeout
      // takes the whole process tree) leaves its lock behind until the ttl.
      if (info.hostname === hostname() && processDead(info.pid)) break;
      // A lock file caught mid-write is reported as held with no nonce and
      // no list (swamp-club#3148); read it again rather than take a working
      // structural command for one that skipped nothing.
      const unreadable = info.nonce === undefined && info.pid === 0;
      const skipping = lockSkipping(info);
      if (!unreadable && !retired.some((nonce) => skipping.has(nonce))) break;
      // A lock file caught mid-write shows no command at work, so it is read
      // again even after a cancel.
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
 * Runs a datastore sync call; see {@link AcquireModelLocksOptions}. `kind`
 * says whether the call pulls (the step-start pull), pushes (the flush), or
 * pushes alone: the last publish attempt of a push whose earlier attempts
 * other syncs undid, which must not run alongside any other sync
 * (swamp-club#3146).
 */
export type SyncCallWrapper = <T>(
  fn: () => Promise<T>,
  kind: "pull" | "push" | "push-alone",
) => Promise<T>;

/** Optional behaviour for {@link acquireModelLocks}. */
export interface AcquireModelLocksOptions {
  /**
   * Wraps the step-start pull and the push inside `flush`, and nothing else —
   * never the lock waits or the lock release — so a caller never holds what
   * the wrapper acquires while waiting on a model lock. Serve passes its
   * shared sync gate here so run syncs exclude its poller pulls.
   */
  wrapSync?: SyncCallWrapper;
  /**
   * The repository context the locked models' data is written through.
   * With it, a push given the versions its work wrote makes sure the remote
   * holds them (swamp-club#3146): another sync in this process can undo a
   * push, by clearing the extension's dirty marks before the push walked
   * them or by pulling an older latest marker over the local one. Before
   * each push it moves each version's latest marker forward again and
   * stages the version and the marker after the write; after it, it reads
   * both back from the remote and repeats while either is missing or behind.
   */
  repoContext?: Pick<
    RepositoryContext,
    "markDirty" | "commitLog" | "unifiedDataRepo"
  >;
}

/** Pushes made to publish a step's written versions before giving up. */
export const PUBLISH_ATTEMPTS = 3;

/** How long one read of a published file from the remote datastore may take. */
export const PUBLISH_CHECK_FETCH_TIMEOUT_MS = 30_000;

/** The cache-relative, forward-slash path of `absPath`, or undefined outside it. */
function cacheRelativePath(
  cachePath: string,
  absPath: string,
): string | undefined {
  const rel = relative(cachePath, absPath);
  if (escapesRoot(rel)) return undefined;
  return SEPARATOR === "/" ? rel : rel.split(SEPARATOR).join("/");
}

/** One written version and the cache paths that publish it. */
interface PublishTarget {
  readonly written: WrittenVersion;
  readonly metadataRel: string;
  readonly latestRel: string;
}

/**
 * Moves each data name's latest marker forward to the highest version in
 * `written` that is still on disk, and stages that version's directory and
 * the marker again, after the write, for the next push. A name whose
 * versions are all gone (deleted, garbage collected or rolled back on
 * purpose) is left alone. Returns what to check on the remote afterwards.
 *
 * The staging runs in a root unit of work with no push: inside a command's
 * root it rolls up into that root, and after the root has ended (a method
 * run's push is its root's flush) it reaches the mark hook on its own.
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

/**
 * How long restoring the datastore's copy of a refused run's versions may
 * take in all, so an unreachable datastore never holds up the refusal.
 */
export const DISCARD_RESTORE_TIMEOUT_MS = 10_000;

/**
 * Discards the data versions a push refused because a model lock was lost
 * (swamp-club#3485), so they reach no clone whether or not the refresh pull
 * after the refusal can run.
 *
 * Each version is deleted through the repository, which moves its name's
 * latest marker back and stages the removal. A removed file stays marked
 * dirty, and the extensions push a marked file that is gone locally as a
 * delete of the remote copy: after a breakglass, the new holder's version
 * of the same number. So each removed file, and the latest marker, is then
 * put back as the datastore holds it, read with `fetchContent`; a file the
 * datastore lacks stays removed. The first read that fails ends the
 * restore. Best effort: the refusal stands whatever this does.
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
): Promise<void> {
  const logger = getSwampLogger(["datastore", "lock"]);
  const repo = repoContext.unifiedDataRepo;
  const removed = new Set<string>();
  try {
    await runInRootUnitOfWork(repoContext, { flush: undefined }, async () => {
      for (const w of refused) {
        const type = ModelType.create(w.modelType);
        const versionDir = repo.getPath(type, w.modelId, w.dataName, w.version);
        try {
          for await (const entry of walk(versionDir, { includeDirs: false })) {
            const rel = cacheRelativePath(cachePath, entry.path);
            if (rel !== undefined) removed.add(rel);
          }
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        const latestRel = cacheRelativePath(
          cachePath,
          join(repo.getDataNameDir(type, w.modelId, w.dataName), "latest"),
        );
        if (latestRel !== undefined) removed.add(latestRel);
        await repo.delete(type, w.modelId, w.dataName, w.version);
      }
    });
  } catch (error) {
    logger.debug`Discarding the refused data versions failed: ${error}`;
  }
  if (!syncService.fetchContent || removed.size === 0) return;
  const signal = AbortSignal.timeout(DISCARD_RESTORE_TIMEOUT_MS);
  const pending = [...removed];
  for (const [i, rel] of pending.entries()) {
    try {
      const bytes = await syncService.fetchContent(rel, { namespace, signal });
      if (bytes === null) continue;
      const absPath = join(cachePath, ...rel.split("/"));
      await ensureDir(dirname(absPath));
      await atomicWriteFile(absPath, bytes);
    } catch (error) {
      logger.debug`Restoring ${
        pending.length - i
      } file(s) from the datastore after a refused push failed at ${rel}: ${error}`;
      return;
    }
  }
}

/** Remote reads a publish check runs at once. */
const PUBLISH_CHECK_CONCURRENCY = 8;

/**
 * The targets the remote datastore does not hold yet, or undefined when a
 * read failed: a push that cannot be checked counts as unverified, not as
 * lost, so an unreachable remote never fails work whose push succeeded.
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
 * Reads a per-model lock just after it was acquired, as the reading its
 * push checks against (swamp-club#3373). A lock that reads nothing, is
 * still being written, or cannot be read gives undefined: its push is not
 * checked, as before, rather than refused for a backend that cannot report.
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
 * Best-effort delete of a stale global lock whose `info` was just observed.
 *
 * Without this, the wait loops in `acquireModelLocks` only `break` past a
 * stale lock — the file remains on disk/in S3 and the post-acquire TOCTOU
 * re-check immediately re-detects it, triggering an infinite recursive
 * retry. Using the existing `forceRelease(expectedNonce)` breakglass
 * primitive (defined on `DistributedLock` for exactly this purpose)
 * actually clears the stale state so subsequent inspects return null.
 *
 * Failure modes are benign and intentionally swallowed:
 *   - `info.nonce` missing (older lock format) — skip; the surrounding
 *     wait-loop timeout still bounds the wait.
 *   - `forceRelease` returns false (nonce changed: the holder
 *     legitimately re-acquired or another process force-released first)
 *     — the next inspect will see the new state and we re-loop.
 *   - Backend transient error — same recovery; one extra loop iteration.
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

export async function acquireModelLocks(
  config: DatastoreConfig,
  models: Array<{ modelType: string; modelId: string }>,
  repoDir?: string,
  /**
   * Sync service to use for pull/push. Normally supplied by the caller
   * (e.g. via `requireInitializedRepoUnlocked` or the serve context) so the
   * same instance handles both the markDirty hook on cache writes and the
   * fast-path watermark read here — implementations that cache the sidecar
   * flag in memory stay coherent across the two call sites. Omit to let
   * this function create one; doing so is only safe when no separate
   * repo-context markDirty hook will race this instance.
   */
  syncService?: DatastoreSyncService,
  /**
   * CatalogStore for writing catalog exports after push. Passed from the
   * repo context so we reuse the existing SQLite handle instead of opening
   * a second one (avoids locking contention on _catalog.db).
   */
  catalogStore?: CatalogStore,
  progressWriter?: LockProgressWriter,
  options?: AcquireModelLocksOptions,
): Promise<ModelLockResult> {
  const write = progressWriter ?? defaultLockWriter;
  const logger = getSwampLogger(["datastore", "lock"]);
  const wrapSync: SyncCallWrapper = options?.wrapSync ?? ((fn) => fn());
  let synced = false;

  // Free when the config came through resolveDatastoreForRepo; checks a
  // config resolved any other way before the first lock (swamp-club#3189).
  await ensureSupportedDatastoreFormat(repoDir ?? ".", config);

  // For custom datastores, resolve the provider once and reuse it everywhere
  let customProvider: DatastoreProvider | undefined;
  let customSyncService = syncService;
  // A v3 bucket datastore takes file locks and syncs nothing (swamp-club#3534).
  if (isCustomDatastoreConfig(config) && isV2CustomDatastore(config)) {
    customProvider = await resolveCustomProvider(config);
    if (!customSyncService && config.cachePath) {
      customSyncService = customProvider.createSyncService?.(
        repoDir ?? ".",
        config.cachePath,
      );
    }
  }

  // Wait for global lock to be released (if held by a structural command).
  // Use the cached provider for custom types so all locks share the same instance.
  // The inspected key MUST match the namespaced key the structural command
  // acquires (datastoreGlobalLockOptions), or the symmetric drain silently
  // coordinates against the wrong lock. createDatastoreLock applies the same
  // options for the filesystem branch.
  const globalLock = customProvider && isCustomDatastoreConfig(config)
    ? customProvider.createLock(
      config.datastorePath,
      {
        ...datastoreGlobalLockOptions(config),
        maxWaitMs: resolveLockTimeoutMs(),
      },
    )
    : await createDatastoreLock(config);
  const globalInfo = await globalLock.inspect();
  if (globalInfo) {
    write(
      yellow(
        `Global lock held by ${globalInfo.holder} — waiting for structural command to finish...`,
      ),
    );
    // Poll until the global lock is released or expires (stale lock).
    // Timeout after 2x TTL to prevent indefinite hangs if staleness
    // detection fails (e.g. clock skew, S3 consistency issues).
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
          // Check if the lock has exceeded its TTL (stale/crashed process)
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
          // Hard timeout to prevent indefinite hangs
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
      dim("Global lock released, proceeding with per-model locks"),
    );
  }

  // Sort models for deterministic lock ordering (deadlock prevention)
  const sorted = [...models].sort((a, b) => {
    const keyA = `${a.modelType}/${a.modelId}`;
    const keyB = `${b.modelType}/${b.modelId}`;
    return keyA.localeCompare(keyB);
  });

  // Deduplicate
  const seen = new Set<string>();
  const unique = sorted.filter((m) => {
    const key = `${m.modelType}/${m.modelId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const lockKeys: string[] = [];
  const heldLocks: DistributedLock[] = [];
  /**
   * Per {@link heldLocks} index: the model it locks, and the lock as read
   * just after it was acquired, which the push checks it against. Undefined
   * when the lock read nothing or could not be read then.
   */
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

  // Pulls one model's data, scoped to it when the extension can.
  const pullModel = (
    syncService: DatastoreSyncService,
    modelType: string,
    modelId: string,
  ) => {
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
  };

  // All or nothing: a call that returns no lock result holds no locks.
  // Without this unwind a throw below leaves every lock taken so far held
  // until the process exits (swamp-club#2901).
  try {
    for (const { modelType, modelId } of unique) {
      const lockFileKey = modelLockKey(config.namespace, modelType, modelId);
      // Use cached provider for custom types to avoid repeated registry lookups
      const lock = customProvider && isCustomDatastoreConfig(config)
        ? customProvider.createLock(config.datastorePath, {
          lockKey: lockFileKey,
          maxWaitMs: resolveLockTimeoutMs(),
        })
        : await createModelLock(config, modelType, modelId);
      // Unique coordinator key so parallel steps on the same model get
      // separate entries — prevents the second registration from
      // overwriting the first (which would orphan the first lock).
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

      // Re-check global lock after acquiring each per-model lock to close TOCTOU race.
      // If a structural command acquired the global lock between our initial check
      // and this per-model acquisition, release everything and wait.
      const postAcquireGlobalInfo = await globalLock.inspect();
      if (postAcquireGlobalInfo) {
        write(
          dim(
            `Global lock acquired by ${postAcquireGlobalInfo.holder} during per-model lock acquisition — releasing and retrying`,
          ),
        );
        // Release all per-model locks acquired so far
        await release();
        lockKeys.length = 0;
        heldLocks.length = 0;
        heldLockModels.length = 0;
        heldLockTaken.length = 0;

        // Wait for global lock to be released (with timeout)
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

        // Restart the entire per-model lock acquisition from scratch —
        // propagate the shared sync service so the retry keeps single-instance
        // semantics. Pulls made before the restart already wrote to the local
        // cache, and the retry's pulls of the same models report 0, so carry
        // `synced` forward or the caller would skip catalog invalidation.
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

      // For custom sync-capable datastores: pull after acquiring per-model lock
      if (customSyncService) {
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
    throw error;
  }

  // Older nested swamps read only the holder; set once, never cleared, so
  // concurrent lock holders in this process cannot clear it under each other.
  processLockHolderMarker.markHoldingLocks();

  // A breakglass (`swamp datastore lock release --force`) lets another clone
  // take a model's lock while this run still works under it. Both clones
  // allocate data versions from their own caches, so the other run may have
  // written and pushed the same version, and this push would overwrite it.
  // Refuse to push unless every per-model lock still names the holder it
  // named when taken (swamp-club#3373). The check and the upload are not
  // atomic; Phase 5's model leases close that window. `refused` are the data
  // versions the push would publish; a refusal discards them.
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
    // The refused versions stay marked dirty in the cache, and a later push
    // (a workflow's end-of-run push, serve's sync, a `datastore sync`) would
    // upload them, over the other run's after a breakglass. Discard them
    // first, so that holds even when the datastore cannot be reached
    // (swamp-club#3485), then pull the lost models so the cache holds the
    // datastore's copy. Best effort: the refusal stands whatever either does.
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

  // `beforePush` runs inside the same wrapped call as the push, so in serve
  // no run pull can land between it and the upload (swamp-club#3146).
  // `versions` are the data versions this push publishes.
  const pushOnce = async (
    beforePush?: () => Promise<void>,
    kind: "push" | "push-alone" = "push",
    versions: readonly WrittenVersion[] = [],
  ) => {
    // For custom sync-capable datastores: push changes to remote
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
        // Two-phase push: file uploads outside global lock, index
        // merge under global lock. Narrows the critical section from
        // "entire sync" to "index read-modify-write" only.
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
        // Single-phase fallback: everything under global lock
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
  const push = async (written?: readonly WrittenVersion[]) => {
    const publishContext = options?.repoContext;
    // Only versions of models these locks hold: no other writer can own a
    // newer marker for them while the push runs.
    const ours = (written ?? []).filter((w) =>
      lockedModels.has(JSON.stringify([w.modelType, w.modelId]))
    );
    if (
      ours.length === 0 || publishContext === undefined ||
      // A v3 context commits through its commit log, not this push.
      publishContext.commitLog !== undefined ||
      !customSyncService ||
      !isCustomDatastoreConfig(config) || !config.cachePath
    ) {
      await pushOnce();
      return;
    }
    const syncService = customSyncService;
    const cachePath = config.cachePath;
    let pending: readonly WrittenVersion[] = ours;
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
      if (!syncService.fetchContent || targets.length === 0) return;
      const behind = await unpublishedTargets(
        targets,
        syncService.fetchContent.bind(syncService),
        config.namespace,
      );
      if (behind === undefined || behind.length === 0) return;
      pending = behind.map((t) => t.written);
      logger
        .debug`Datastore lacks ${pending.length} written version(s) after push ${attempt}; publishing again`;
    }
    throw new UnpublishedDataVersionError(pending, PUBLISH_ATTEMPTS);
  };

  const flush = async (written?: readonly WrittenVersion[]) => {
    try {
      await push(written);
    } finally {
      // Always release per-model locks, even if push fails
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
  };
}

/**
 * Runs `fn`, the method run done under the per-model locks `lockResult`
 * took (or under none, when it is undefined), so a swamp it starts skips
 * those locks and still waits on the ones this process holds for other
 * runs (design/enablers/datastores.md, "Parent-Process Lock Awareness").
 * Wrap the whole consumption of a method run's event stream: an async
 * generator's body runs in the context of whoever iterates it.
 */
export function runUnderModelLocks<T>(
  lockResult: Pick<ModelLockResult, "lentLocks"> | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return processLockHolderMarker.runHolding(lockResult?.lentLocks ?? [], fn);
}

/**
 * Single-phase push: catalog export outside the lock, pushChanged under it.
 *
 * Writes the catalog export before acquiring the global lock, then acquires
 * the lock and calls `pushChanged`. The export is a full snapshot of the
 * local catalog — safe to write outside the lock because a later concurrent
 * writer simply overwrites with a more complete snapshot (same reasoning as
 * the two-phase path).
 *
 * Used when the extension does not advertise `twoPhaseSync`.
 */
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

  // Write catalog export before acquiring the global lock so the
  // synchronous SQLite read + JSON serialization doesn't hold the lock
  // and block concurrent writers. Safe for the same reason as two-phase:
  // the export is a full snapshot that a later writer simply overwrites.
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

/**
 * Two-phase push: file I/O outside the lock, index merge under the lock.
 *
 * 1. `preparePush` — uploads changed files to the remote (expensive,
 *    runs under per-model locks only, no global lock)
 * 2. Acquire global lock
 * 3. Write catalog export
 * 4. `commitPush` — merges the manifest into the remote index (fast)
 * 5. Release global lock
 *
 * This narrows the critical section from "entire sync" to "index
 * read-modify-write" only. Concurrent writers to different models
 * overlap on step 1 and serialize only on steps 2–5.
 */
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
  // Write catalog export before preparePush so it's included in the
  // upload phase. The export is a full snapshot of the local catalog —
  // safe to write outside the lock because a later concurrent writer
  // simply overwrites with a more complete snapshot.
  await writeCatalogExportIfNeeded(
    syncService,
    config,
    namespace,
    catalogStore,
    progressWriter,
  );

  // Phase 1: upload files outside the global lock
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

  // Phase 2: index merge under global lock
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

/**
 * Writes `.catalog-export.json` for the namespace if applicable.
 * Shared by both single-phase and two-phase push paths.
 */
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
 * Lifecycle hook for vault commands.
 *
 * Vault **secrets** (encrypted blobs) live in `.swamp/secrets/` which is
 * always-local (ALWAYS_LOCAL_SUBDIRS) — they never enter the datastore.
 * Vault **configs** (YAML definitions in `vaults/`) do live in the
 * datastore's config tier when managedConfig is active, but config-tier
 * sync is handled separately by `pushManagedConfigChanges` (writes) and
 * `requireInitializedRepoReadOnly` with `pull: true` (reads). This hook
 * covers neither, so the returned flush is a no-op.
 */
export function acquireVaultSync(
  _config: DatastoreConfig,
  _syncService?: DatastoreSyncService,
  _repoDir?: string,
): Promise<VaultSyncResult> {
  return Promise.resolve({ flush: () => Promise.resolve() });
}

export { createDatastoreLock, datastoreGlobalLockOptions };
