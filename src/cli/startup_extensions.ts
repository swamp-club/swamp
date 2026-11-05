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

import { isAbsolute, join, resolve } from "@std/path";
import {
  isManagedConfigBaseResolved,
  managedConfigLockfilePath,
  resolveManagedConfigOnce,
  swampPath,
} from "../infrastructure/persistence/paths.ts";
import {
  type InstalledEntries,
  isAbsentFromDisk,
  pathsToRemoveForReinstall,
  readInstalledEntries,
  transitionalInstalledNames,
  transitionalLocalLockfilePath,
} from "../infrastructure/persistence/installed_entries.ts";
import {
  type DatastoreEnvReader,
  isExtensionBackedDatastore,
} from "../infrastructure/persistence/managed_config_lockfile.ts";

import { errorPaths, markErrorPaths, UserError } from "../domain/errors.ts";
import { getLogger } from "@logtape/logtape";
import {
  markModelWording,
  wordedText,
  wordedUserError,
} from "../domain/behavior_wording.ts";
import {
  choosePulledDatastoreDirsOnDisk,
  enumeratePulledExtensionDirs,
} from "../libswamp/extensions/enumerate_pulled.ts";

import { rebaseOntoRepoDir } from "./context.ts";

import { isTransientError } from "../infrastructure/persistence/io_errors.ts";

import { ExtensionCatalogStore } from "../infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../infrastructure/persistence/extension_repository.ts";
import { readLocalManifestIdentity } from "../infrastructure/persistence/local_manifest_reader.ts";
import { LockfileRepository } from "../infrastructure/persistence/lockfile_repository.ts";
import { ExtensionLoader } from "../domain/extensions/extension_loader.ts";
import { createLocalModelRefresher } from "../domain/extensions/local_model_refresh.ts";
import { modelKindAdapter } from "../domain/extensions/model_kind_adapter.ts";
import { vaultKindAdapter } from "../domain/extensions/vault_kind_adapter.ts";
import { datastoreKindAdapter } from "../domain/extensions/datastore_kind_adapter.ts";
import { reportKindAdapter } from "../domain/extensions/report_kind_adapter.ts";
import { webhookKindAdapter } from "../domain/extensions/webhook_kind_adapter.ts";
import { modelRegistry } from "../domain/models/model.ts";
import { vaultTypeRegistry } from "../domain/vaults/vault_type_registry.ts";

import { datastoreTypeRegistry } from "../domain/datastore/datastore_type_registry.ts";
import { reportRegistry } from "../domain/reports/report_registry.ts";
import { webhookTypeRegistry } from "../domain/webhooks/webhook_type_registry.ts";

import "../domain/datastore/datastore_types.ts";
import "../domain/reports/builtin/mod.ts";
import { EmbeddedDenoRuntime } from "../infrastructure/runtime/embedded_deno_runtime.ts";
import { createDenoInfoModuleGraphReader } from "../infrastructure/runtime/deno_info_module_graph_reader.ts";
import { homeDirectoryIsSet } from "../infrastructure/persistence/paths.ts";

import { ReconcileFromDiskService } from "../libswamp/extensions/reconcile_from_disk_service.ts";
import { ProcessBundleProber } from "../infrastructure/runtime/process_bundle_prober.ts";
import type {
  RepoMarkerData,
} from "../infrastructure/persistence/repo_marker_repository.ts";

import { detectSupersededSkills } from "../domain/repo/repo_service.ts";
import { resolveSupersededSkillDirs } from "../domain/repo/superseded_skills.ts";

import { isBundleArtifactPath } from "./auto_resolver_adapters.ts";

import type { CommandInvocationData } from "../domain/telemetry/command_invocation.ts";

import type { DatastorePathResolver } from "../domain/datastore/datastore_path_resolver.ts";
import { DefaultDatastorePathResolver } from "../infrastructure/persistence/default_datastore_path_resolver.ts";
import { resolveDatastoreConfig } from "./resolve_datastore.ts";

import {
  collectDirsForKind,
  flattenSourceKindDirs,
} from "../infrastructure/persistence/swamp_sources_repository.ts";

import type {
  ExtensionKind,
  ResolvedSourceDirs,
} from "../domain/repo/swamp_sources.ts";
import { discoverManifestCrossKindDirs } from "../domain/extensions/manifest_cross_kind_discovery.ts";
import "../domain/models/models.ts";
import {
  existingBehaviorsDir,
  resolveBehaviorsDir,
  resolveModelsDir,
} from "./resolve_models_dir.ts";

import {
  ensureManagedConfigBase,
  resolveManagedConfigPaths,
  serveUpstreamConfigOptions,
  serveUpstreamOf,
} from "./repo_context.ts";

import { resolveVaultsDir } from "./resolve_vaults_dir.ts";
import { resolveDatastoresDir } from "./resolve_datastores_dir.ts";
import { resolveReportsDir } from "./resolve_reports_dir.ts";
import { resolveWebhooksDir } from "./resolve_webhooks_dir.ts";

const logger = getLogger(["swamp", "cli"]);

/**
 * does not control when extensions load (each command's registry.ensureLoaded()
 * does), only whether the loader functions are configured on the registries
 */
export interface StartupExtensionOptions {
  repoDir: string;
  marker: RepoMarkerData | null;
  resolvedSources: ResolvedSourceDirs[];
  deferredWarnings: DeferredWarning[];
  quiet?: boolean;
  extensionsDir?: string;
  thinClient?: boolean;
  /**
   * the command leaves the repo untouched unless it loads extensions: the
   * catalog opens on first use, and managed config resolution, reconcile and
   * the missing-files check wait for the first loader
   */
  deferCatalog?: boolean;
  readDatastoreEnv?: DatastoreEnvReader;
  /**
   * drops a warning the command should not see; applies only to warnings the
   * deferred reconcile logs directly, the caller filters those collected at
   * startup
   */
  suppressWarning?: (warning: DeferredWarning) => boolean;
  datastoreLoader?: () => Promise<void>;
}

/**
 * resolves the managed config base before configuring loaders so none captures
 * a guessed lockfile path. with deferCatalog, resolution for extension-backed
 * datastores and the reconcile wait for the first loader
 */
export async function configureStartupExtensions(
  options: StartupExtensionOptions,
): Promise<() => void> {
  const {
    repoDir,
    marker,
    resolvedSources,
    deferredWarnings,
    quiet = false,
    extensionsDir,
    thinClient = false,
    deferCatalog = false,
    readDatastoreEnv,
  } = options;
  const effectiveExtDir = extensionsDir === undefined
    ? repoDir
    : rebaseOntoRepoDir(extensionsDir, repoDir);

  // extensions load through an embedded runtime under the home dir; without
  // HOME or USERPROFILE (e.g. systemd) each loader would fail with misleading
  // warnings, so warn once up front
  if (!homeDirectoryIsSet()) {
    deferredWarnings.push({
      kind: "extensions",
      file: "",
      error:
        "Extension loading is unavailable: no swamp data directory found " +
        "(none of SWAMP_HOME, HOME, or USERPROFILE is set). swamp loads all " +
        "extensions — including already-pulled repo extensions — through an " +
        "embedded runtime under the swamp data directory. If you run swamp " +
        "under a service manager such as systemd, set SWAMP_HOME to an " +
        "isolated directory, e.g. `Environment=SWAMP_HOME=/opt/swamp`, or " +
        "set HOME. Until then, pulled and user extensions are unavailable " +
        'and workflows that reference them fail with "Unknown behavior type".',
    });
  }

  const denoRuntime = new EmbeddedDenoRuntime();
  const sourceModelsDirs = collectDirsForKind(resolvedSources, "models");
  const sourceVaultsDirs = collectDirsForKind(resolvedSources, "vaults");
  const sourceDatastoresDirs = collectDirsForKind(
    resolvedSources,
    "datastores",
  );
  const sourceReportsDirs = collectDirsForKind(resolvedSources, "reports");
  const sourceWebhooksDirs = collectDirsForKind(resolvedSources, "webhooks");
  const mountedSourceDirs = flattenSourceKindDirs(resolvedSources);

  const resolveAbsoluteKindDir = (
    resolveDir: (m: RepoMarkerData | null) => string,
  ): string => {
    const dir = resolveDir(marker);
    return isAbsolute(dir)
      ? rebaseOntoRepoDir(dir, repoDir)
      : resolve(effectiveExtDir, dir);
  };

  const behaviorsDir = resolveBehaviorsDir(marker);
  const kindDirs = new Map<ExtensionKind, string[]>([
    ["models", [
      resolveAbsoluteKindDir(resolveModelsDir),
      // the behavior-spelled sibling of the default models directory; discovery
      // skips it when it does not exist
      ...(behaviorsDir === undefined
        ? []
        : [resolve(effectiveExtDir, behaviorsDir)]),
      ...sourceModelsDirs,
    ]],
    ["vaults", [resolveAbsoluteKindDir(resolveVaultsDir), ...sourceVaultsDirs]],
    [
      "datastores",
      [resolveAbsoluteKindDir(resolveDatastoresDir), ...sourceDatastoresDirs],
    ],
    [
      "reports",
      [resolveAbsoluteKindDir(resolveReportsDir), ...sourceReportsDirs],
    ],
    [
      "webhooks",
      [resolveAbsoluteKindDir(resolveWebhooksDir), ...sourceWebhooksDirs],
    ],
  ]);
  const manifestCrossKindDirs = await discoverManifestCrossKindDirs(kindDirs);

  const mergeManifestDirs = (
    sourceDirs: string[],
    kind: ExtensionKind,
  ): string[] => {
    const extra = manifestCrossKindDirs.get(kind);
    return extra ? [...sourceDirs, ...extra] : sourceDirs;
  };

  const catalog = new ExtensionCatalogStore(
    swampPath(repoDir, "_extension_catalog.db"),
    { openOnFirstUse: deferCatalog },
  );
  const dispose = () => catalog.close();

  try {
    const localManifestIdentity = readLocalManifestIdentity(repoDir);
    const managed = marker?.datastore?.managedConfig === true;
    const extensionBacked = isExtensionBackedDatastore(
      marker,
      readDatastoreEnv,
    );

    resolveManagedConfigPaths(repoDir, marker);

    // 2. The datastore extension must load before the base can resolve, so
    // in extension-backed repos it is discovered on disk, not via a lockfile.
    if (options.datastoreLoader) {
      datastoreTypeRegistry.setLoader(options.datastoreLoader);
    } else if (extensionBacked) {
      const datastoreRepository = new ExtensionRepository({
        catalog,
        lockfileRepository: new LockfileRepository(
          managedConfigLockfilePath(repoDir),
          {},
        ),
        repoRoot: repoDir,
        localManifestIdentity,
        mountedSourceDirs,
      });
      datastoreTypeRegistry.setLoader(() =>
        loadUserDatastores(
          repoDir,
          marker,
          denoRuntime,
          mergeManifestDirs(sourceDatastoresDirs, "datastores"),
          datastoreRepository,
          quiet,
          effectiveExtDir,
          undefined,
          undefined,
          () => choosePulledDatastoreDirsOnDisk(catalog, repoDir),
        )
      );
    }

    // installed-only; a failed attempt is remembered for this process so each
    // loader does not rerun the datastore index pass
    let resolutionFailed = false;
    const ensureResolvedForLoaders = async (): Promise<void> => {
      if (!extensionBacked || resolutionFailed) return;
      if (isManagedConfigBaseResolved(repoDir)) return;
      const resolved = await resolveManagedConfigOnce(
        repoDir,
        () =>
          ensureManagedConfigBase(repoDir, marker, undefined, {
            autoResolve: false,
          }),
      );
      if (!resolved) resolutionFailed = true;
    };
    if (managed && !extensionBacked) {
      await ensureManagedConfigBase(repoDir, marker);
    } else if (extensionBacked && !thinClient && !deferCatalog) {
      await ensureResolvedForLoaders();
    }
    const baseReady = () =>
      !extensionBacked || isManagedConfigBaseResolved(repoDir);

    const lockfilePathNow = () =>
      resolveManagedConfigPaths(repoDir, marker).lockfilePath;
    const localLockfileFor = (lockfilePath: string) =>
      transitionalLocalLockfilePath(
        repoDir,
        marker,
        lockfilePath,
        readDatastoreEnv,
      );
    const repositories = new Map<
      string,
      Promise<{
        repository: ExtensionRepository;
        lockfileRepository: LockfileRepository;
      }>
    >();
    const repositoryFor = (lockfilePath: string) => {
      let entry = repositories.get(lockfilePath);
      if (!entry) {
        entry = LockfileRepository.create(lockfilePath).then(
          (lockfileRepository) => ({
            lockfileRepository,
            repository: new ExtensionRepository({
              catalog,
              lockfileRepository,
              repoRoot: repoDir,
              localManifestIdentity,
              mountedSourceDirs,
            }),
          }),
        );
        entry.catch(() => repositories.delete(lockfilePath));
        repositories.set(lockfilePath, entry);
      }
      return entry;
    };

    let resolverPromise:
      | Promise<DatastorePathResolver | undefined>
      | undefined;
    const lazyResolver = async (): Promise<
      DatastorePathResolver | undefined
    > => {
      if (extensionBacked) {
        await ensureResolvedForLoaders();
        if (!isManagedConfigBaseResolved(repoDir)) return undefined;
      }
      const serveOptions = serveUpstreamConfigOptions(
        repoDir,
        await serveUpstreamOf(marker),
      );
      resolverPromise ??= resolveDatastoreConfig(
        marker,
        undefined,
        repoDir,
        serveOptions ?? (extensionBacked ? { autoResolve: false } : undefined),
      )
        .then((config) =>
          new DefaultDatastorePathResolver(
            repoDir,
            config,
          ) as DatastorePathResolver
        )
        .catch(() => {
          // an extension-backed repo retries once its base resolves,
          // installed-only; elsewhere the failure is kept so each loader does
          // not re-run the network auto-resolve
          if (extensionBacked) resolverPromise = undefined;
          return undefined;
        });
      return resolverPromise;
    };

    // reconcile returns false when the lockfile cannot be read; the
    // missing-files check reads the same file, so it is skipped rather than
    // repeating the warning
    const runReconcile = async (): Promise<boolean> => {
      const lockfilePath = lockfilePathNow();
      let loaded: Awaited<ReturnType<typeof repositoryFor>>;
      try {
        loaded = await repositoryFor(lockfilePath);
      } catch (error) {
        logger.warn`Skipping extension catalog repair: ${
          error instanceof Error ? error.message : String(error)
        }`;
        return false;
      }
      const { repository, lockfileRepository } = loaded;
      if (
        !repository.anyKindNeedsInvalidation() &&
        !repository.manifestIdentityChanged(localManifestIdentity)
      ) {
        return true;
      }
      const reconciler = new ReconcileFromDiskService({
        denoRuntime,
        repository,
        lockfileRepository,
        repoDir,
        bundleProber: new ProcessBundleProber(),
        localManifestIdentity,
        scanOnDiskDatastores: extensionBacked,
        additionalInstalledNames: await transitionalInstalledNames(
          repoDir,
          marker,
          lockfilePath,
          readDatastoreEnv,
        ),
      });
      await reconciler.execute();
      return true;
    };
    // skip local file checks when routing to a remote serve: a thin checkout's
    // lockfile references files that exist only on the server
    const checkLocalFiles = !Deno.env.get("SWAMP_SERVE_URL");
    const checkMissing = (report: (warning: DeferredWarning) => void) => {
      const lockfilePath = lockfilePathNow();
      return checkForMissingPulledExtensions(
        repoDir,
        lockfilePath,
        localLockfileFor(lockfilePath),
        report,
      );
    };

    // reconcile counts as done only once it has read the lockfile; an
    // unreadable one (caught mid-rewrite by a sync) is retried on a later load
    let reconciled = false;
    if (baseReady() && !deferCatalog) {
      // a failed repair must not fail every command, or doctor extensions and
      // extension rm become unreachable. it is marked done for this process;
      // the populated markers stay unset so the next process retries
      let repaired = false;
      try {
        reconciled = await runReconcile();
        repaired = reconciled;
      } catch (error) {
        reconciled = true;
        const reason = (error instanceof Error ? error.message : String(error))
          .replace(/\.$/, "");
        logger
          .warn`Extension catalog repair failed: ${reason}. Run ${"swamp doctor extensions"} to inspect.`;
      }
      if (checkLocalFiles && repaired) {
        await checkMissing((w) => deferredWarnings.push(w));
      }
    }
    let deferredReconcile: Promise<void> | undefined;
    const runDeferredReconcileOnce = (): Promise<void> => {
      if (reconciled || !baseReady()) return Promise.resolve();
      deferredReconcile ??= (async () => {
        try {
          if (!await runReconcile()) {
            deferredReconcile = undefined;
            return;
          }
          reconciled = true;
          if (checkLocalFiles) {
            await checkMissing((w) => {
              if (!options.suppressWarning?.(w)) logger.warn`${w.error}`;
            });
          }
        } catch (error) {
          deferredReconcile = undefined;
          logger.warn`Extension catalog repair failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      })();
      return deferredReconcile;
    };

    const withLoaderContext = async (
      registry: { resetLoadedFlag(): void },
      load: (
        lockfilePath: string,
        repository: ExtensionRepository,
        localLockfilePath: string | undefined,
      ) => Promise<void>,
    ): Promise<void> => {
      await ensureResolvedForLoaders();
      await runDeferredReconcileOnce();
      const lockfilePath = lockfilePathNow();
      let repository: ExtensionRepository;
      try {
        ({ repository } = await repositoryFor(lockfilePath));
      } catch (error) {
        // An unreadable lockfile fails this load, but must not stay cached
        // in the registry: the next ensureLoaded retries the read.
        registry.resetLoadedFlag();
        throw error;
      }
      await load(lockfilePath, repository, localLockfileFor(lockfilePath));
    };

    modelRegistry.setLoader(() =>
      withLoaderContext(
        modelRegistry,
        (lockfilePath, repository, localLockfilePath) =>
          loadUserModels(
            repoDir,
            marker,
            denoRuntime,
            mergeManifestDirs(sourceModelsDirs, "models"),
            lazyResolver,
            repository,
            quiet,
            effectiveExtDir,
            lockfilePath,
            localLockfilePath,
          ),
      )
    );
    vaultTypeRegistry.setLoader(() =>
      withLoaderContext(
        vaultTypeRegistry,
        (lockfilePath, repository, localLockfilePath) =>
          loadUserVaults(
            repoDir,
            marker,
            denoRuntime,
            mergeManifestDirs(sourceVaultsDirs, "vaults"),
            lazyResolver,
            repository,
            quiet,
            effectiveExtDir,
            lockfilePath,
            localLockfilePath,
          ),
      )
    );
    if (!options.datastoreLoader && !extensionBacked) {
      datastoreTypeRegistry.setLoader(() =>
        withLoaderContext(
          datastoreTypeRegistry,
          (lockfilePath, repository, localLockfilePath) =>
            loadUserDatastores(
              repoDir,
              marker,
              denoRuntime,
              mergeManifestDirs(sourceDatastoresDirs, "datastores"),
              repository,
              quiet,
              effectiveExtDir,
              lockfilePath,
              localLockfilePath,
            ),
        )
      );
    }
    reportRegistry.setLoader(() =>
      withLoaderContext(
        reportRegistry,
        (lockfilePath, repository, localLockfilePath) =>
          loadUserReports(
            repoDir,
            marker,
            denoRuntime,
            mergeManifestDirs(sourceReportsDirs, "reports"),
            lazyResolver,
            repository,
            quiet,
            effectiveExtDir,
            lockfilePath,
            localLockfilePath,
          ),
      )
    );
    webhookTypeRegistry.setLoader(() =>
      withLoaderContext(
        webhookTypeRegistry,
        (lockfilePath, repository, localLockfilePath) =>
          loadUserWebhooks(
            repoDir,
            marker,
            denoRuntime,
            mergeManifestDirs(sourceWebhooksDirs, "webhooks"),
            lazyResolver,
            repository,
            quiet,
            effectiveExtDir,
            lockfilePath,
            localLockfilePath,
          ),
      )
    );

    if (checkLocalFiles) {
      await checkForSupersededSkills(repoDir, marker, deferredWarnings);
    }
  } catch (error) {
    dispose();
    throw error;
  }

  return dispose;
}
export interface DeferredWarning {
  kind:
    | "model"
    | "vault"
    | "datastore"
    | "report"
    | "webhook"
    | "extensions"
    | "skills"
    | "skill-migration";
  file: string;
  error: string;
}

const MISSING_PULLED_EXTENSIONS_MARKER =
  "pulled extension(s) have missing source files";

export function shouldSuppressMissingExtensionsWarning(
  commandInfo: CommandInvocationData,
  warning: DeferredWarning,
): boolean {
  return commandInfo.command === "extension" &&
    commandInfo.subcommand === "install" &&
    warning.kind === "extensions" &&
    warning.error.includes(MISSING_PULLED_EXTENSIONS_MARKER);
}

/**
 * used to suppress the misleading per-kind loader warnings in favour of the
 * single one from configureStartupExtensions
 */
function isMissingHomeError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("home directory");
}

function throwOnTransientLoadFailures(
  failures: ReadonlyArray<
    { file: string; error: string; originalError?: unknown }
  >,
  kind: string,
  modelKind: string = kind,
): void {
  const transient = failures.filter((f) =>
    isTransientError(f.originalError ?? new Error(f.error))
  );
  if (transient.length === 0) return;
  const details = transient
    .map((f) => `${f.file}: ${f.error}`)
    .join("; ");
  const text = (noun: string) =>
    `Failed to load ${transient.length} extension ${noun}(s): ${details}. ` +
    "If another swamp process is writing the extension index, retry once it finishes.";
  throw markErrorPaths(
    markModelWording(
      new UserError(text(kind), "lock_timeout"),
      text(modelKind),
    ),
    transient.flatMap((f) => [f.file, ...errorPaths(f.originalError)]),
  );
}

async function loadUserModels(
  repoDir: string,
  marker: RepoMarkerData | null,
  denoRuntime: EmbeddedDenoRuntime,
  sourceDirs: string[],
  resolverFactory: () => Promise<DatastorePathResolver | undefined>,
  repository: ExtensionRepository,
  _quiet = false,
  extensionsDir?: string,
  managedLockfilePath?: string,
  localLockfilePath?: string,
): Promise<void> {
  try {
    const extBase = extensionsDir ?? repoDir;
    const modelsDir = resolveModelsDir(marker);
    const absoluteModelsDir = isAbsolute(modelsDir)
      ? modelsDir
      : resolve(extBase, modelsDir);

    const lockfilePath = managedLockfilePath ??
      join(absoluteModelsDir, "upstream_extensions.json");

    const resolver = resolverFactory ? await resolverFactory() : undefined;
    const loader = new ExtensionLoader(
      denoRuntime,
      modelKindAdapter,
      repoDir,
      resolver,
      repository,
      new ProcessBundleProber(),
      createDenoInfoModuleGraphReader,
    );
    const pulledDirs = await enumeratePulledExtensionDirs(
      lockfilePath,
      repoDir,
      "models",
      undefined,
      localLockfilePath,
    );

    // the lazy entry carries bundle/source paths from the catalog index,
    // avoiding a redundant SQLite read inside loadSingleType
    modelRegistry.setTypeLoader(async (type, lazyEntry) => {
      await loader.loadSingleType(type, lazyEntry);
    });

    // load order: local > sources > pulled; pulledDirs has one entry per
    // extension so file-name collisions cannot bleed across extensions
    const behaviorsDir = await existingBehaviorsDir(extBase, marker);
    const result = await loader.buildIndex(
      absoluteModelsDir,
      {
        additionalDirs: [...sourceDirs, ...pulledDirs],
        ...(behaviorsDir ? { localDirs: [behaviorsDir] } : {}),
        indexOnly: true,
      },
    );

    throwOnTransientLoadFailures(result.failed, "behavior", "model");

    // built-in and eagerly registered types skip the type loader, so their
    // extensions attach through this hook, wired once the index is built so an
    // attach never reads a partial catalog
    modelRegistry.setExtensionAttacher((type) =>
      loader.attachPendingExtensionsForType(type)
    );
    // lets long-lived processes pick up edited local models. dirs are resolved
    // again on each pass because the scan drops catalog rows of sources it does
    // not see; the behaviors dir is watched before it exists
    const behaviorsCandidate = resolveBehaviorsDir(marker);
    // the refresher imports in-process in a long-lived process, so an edited
    // add-on to a type already in use attaches straight away; probing is only
    // for indexing
    modelRegistry.setSourceRefresher(
      createLocalModelRefresher(
        new ExtensionLoader(
          denoRuntime,
          modelKindAdapter,
          repoDir,
          resolver,
          repository,
          undefined,
          createDenoInfoModuleGraphReader,
        ),
        absoluteModelsDir,
        [
          ...(behaviorsCandidate ? [resolve(extBase, behaviorsCandidate)] : []),
          ...sourceDirs,
        ],
        async () => {
          const behaviors = await existingBehaviorsDir(extBase, marker);
          return {
            localDirs: behaviors ? [behaviors] : [],
            additionalDirs: [
              ...sourceDirs,
              ...await enumeratePulledExtensionDirs(
                lockfilePath,
                repoDir,
                "models",
                undefined,
                localLockfilePath,
              ),
            ],
          };
        },
      ),
    );

    for (const failure of result.failed) {
      if (
        failure.error.startsWith("Cannot extend unregistered behavior type")
      ) {
        logger
          .warn`User extension ${failure.file} targets unregistered base type — will retry once the base is loaded: ${failure.error}`;
      } else {
        logger
          .warn`Failed to load user behavior ${failure.file}: ${failure.error}`;
      }
    }
  } catch (error) {
    if (error instanceof UserError) throw error;
    if (error instanceof Deno.errors.NotFound) return;
    // configureStartupExtensions already emitted one actionable warning for
    // the missing-home case; suppress the misleading per-kind duplicate.
    if (isMissingHomeError(error)) return;
    if (isTransientError(error)) {
      throw wordedUserError(
        wordedText((w) =>
          `Failed to load extension ${w.nouns}: ${
            error instanceof Error ? error.message : String(error)
          }. ` +
          "If another swamp process is writing the extension index, retry once it finishes."
        ),
        "lock_timeout",
      );
    }
    logger
      .warn`Failed to load user behavior extensions: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

async function loadUserVaults(
  repoDir: string,
  marker: RepoMarkerData | null,
  denoRuntime: EmbeddedDenoRuntime,
  sourceDirs: string[] = [],
  resolverFactory?: () => Promise<DatastorePathResolver | undefined>,
  repository?: ExtensionRepository,
  _quiet = false,
  extensionsDir?: string,
  managedLockfilePath?: string,
  localLockfilePath?: string,
): Promise<void> {
  try {
    const extBase = extensionsDir ?? repoDir;
    const vaultsDir = resolveVaultsDir(marker);
    const absoluteVaultsDir = isAbsolute(vaultsDir)
      ? vaultsDir
      : resolve(extBase, vaultsDir);

    const resolver = resolverFactory ? await resolverFactory() : undefined;
    const loader = new ExtensionLoader(
      denoRuntime,
      vaultKindAdapter,
      repoDir,
      resolver,
      repository,
      new ProcessBundleProber(),
      createDenoInfoModuleGraphReader,
    );
    const modelsDir = resolveModelsDir(marker);
    const lockfilePath = managedLockfilePath ?? join(
      isAbsolute(modelsDir) ? modelsDir : resolve(repoDir, modelsDir),
      "upstream_extensions.json",
    );
    const pulledDirs = await enumeratePulledExtensionDirs(
      lockfilePath,
      repoDir,
      "vaults",
      undefined,
      localLockfilePath,
    );

    if (repository) {
      vaultTypeRegistry.setTypeLoader(async (type) => {
        await loader.loadSingleType(type);
      });

      const result = await loader.buildIndex(absoluteVaultsDir, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
        indexOnly: true,
      });

      throwOnTransientLoadFailures(result.failed, "vault");

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user vault ${failure.file}: ${failure.error}`;
      }
    } else {
      const result = await loader.load(absoluteVaultsDir, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
        skipAlreadyRegistered: true,
      });

      throwOnTransientLoadFailures(result.failed, "vault");

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user vault ${failure.file}: ${failure.error}`;
      }
    }
  } catch (error) {
    if (error instanceof UserError) throw error;
    if (error instanceof Deno.errors.NotFound) return;
    if (isMissingHomeError(error)) return;
    if (isTransientError(error)) {
      throw new UserError(
        `Failed to load extension vaults: ${
          error instanceof Error ? error.message : String(error)
        }. ` +
          "If another swamp process is writing the extension index, retry once it finishes.",
        "lock_timeout",
      );
    }
    logger
      .warn`Failed to load user vault extensions: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

async function loadUserDatastores(
  repoDir: string,
  marker: RepoMarkerData | null,
  denoRuntime: EmbeddedDenoRuntime,
  sourceDirs: string[] = [],
  repository?: ExtensionRepository,
  _quiet = false,
  extensionsDir?: string,
  managedLockfilePath?: string,
  localLockfilePath?: string,
  pulledDirsOverride?: () => Promise<string[]>,
): Promise<void> {
  try {
    const extBase = extensionsDir ?? repoDir;
    const datastoresDir = resolveDatastoresDir(marker);
    const absoluteDatastoresDir = isAbsolute(datastoresDir)
      ? datastoresDir
      : resolve(extBase, datastoresDir);

    const loader = new ExtensionLoader(
      denoRuntime,
      datastoreKindAdapter,
      repoDir,
      undefined,
      repository,
      new ProcessBundleProber(),
      createDenoInfoModuleGraphReader,
    );
    const modelsDir = resolveModelsDir(marker);
    const lockfilePath = managedLockfilePath ?? join(
      isAbsolute(modelsDir) ? modelsDir : resolve(repoDir, modelsDir),
      "upstream_extensions.json",
    );
    const pulledDirs = pulledDirsOverride
      ? await pulledDirsOverride()
      : await enumeratePulledExtensionDirs(
        lockfilePath,
        repoDir,
        "datastores",
        undefined,
        localLockfilePath,
      );

    if (repository) {
      datastoreTypeRegistry.setTypeLoader(async (type) => {
        await loader.loadSingleType(type);
      });

      const result = await loader.buildIndex(
        absoluteDatastoresDir,
        {
          additionalDirs: [...sourceDirs, ...pulledDirs],
          indexOnly: true,
        },
      );

      throwOnTransientLoadFailures(result.failed, "datastore");

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user datastore ${failure.file}: ${failure.error}`;
      }
    } else {
      const result = await loader.load(absoluteDatastoresDir, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
        skipAlreadyRegistered: true,
      });

      throwOnTransientLoadFailures(result.failed, "datastore");

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user datastore ${failure.file}: ${failure.error}`;
      }
    }
  } catch (error) {
    if (error instanceof UserError) throw error;
    if (error instanceof Deno.errors.NotFound) return;
    if (isMissingHomeError(error)) return;
    if (isTransientError(error)) {
      throw new UserError(
        `Failed to load extension datastores: ${
          error instanceof Error ? error.message : String(error)
        }. ` +
          "If another swamp process is writing the extension index, retry once it finishes.",
        "lock_timeout",
      );
    }
    logger
      .warn`Failed to load user datastore extensions: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

async function loadUserReports(
  repoDir: string,
  marker: RepoMarkerData | null,
  denoRuntime: EmbeddedDenoRuntime,
  sourceDirs: string[] = [],
  resolverFactory?: () => Promise<DatastorePathResolver | undefined>,
  repository?: ExtensionRepository,
  _quiet = false,
  extensionsDir?: string,
  managedLockfilePath?: string,
  localLockfilePath?: string,
): Promise<void> {
  try {
    const extBase = extensionsDir ?? repoDir;
    const reportsDir = resolveReportsDir(marker);
    const absoluteReportsDir = isAbsolute(reportsDir)
      ? reportsDir
      : resolve(extBase, reportsDir);

    const resolver = resolverFactory ? await resolverFactory() : undefined;
    const loader = new ExtensionLoader(
      denoRuntime,
      reportKindAdapter,
      repoDir,
      resolver,
      repository,
      new ProcessBundleProber(),
      createDenoInfoModuleGraphReader,
    );
    const modelsDir = resolveModelsDir(marker);
    const lockfilePath = managedLockfilePath ?? join(
      isAbsolute(modelsDir) ? modelsDir : resolve(repoDir, modelsDir),
      "upstream_extensions.json",
    );
    const pulledDirs = await enumeratePulledExtensionDirs(
      lockfilePath,
      repoDir,
      "reports",
      undefined,
      localLockfilePath,
    );

    if (repository) {
      reportRegistry.setTypeLoader(async (type) => {
        await loader.loadSingleType(type);
      });

      const result = await loader.buildIndex(absoluteReportsDir, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
        indexOnly: true,
      });

      throwOnTransientLoadFailures(result.failed, "report");

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user report ${failure.file}: ${failure.error}`;
      }
    } else {
      const result = await loader.load(absoluteReportsDir, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
        skipAlreadyRegistered: true,
      });

      throwOnTransientLoadFailures(result.failed, "report");

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user report ${failure.file}: ${failure.error}`;
      }
    }
  } catch (error) {
    if (error instanceof UserError) throw error;
    if (error instanceof Deno.errors.NotFound) return;
    if (isMissingHomeError(error)) return;
    if (isTransientError(error)) {
      throw new UserError(
        `Failed to load extension reports: ${
          error instanceof Error ? error.message : String(error)
        }. ` +
          "If another swamp process is writing the extension index, retry once it finishes.",
        "lock_timeout",
      );
    }
    logger
      .warn`Failed to load user report extensions: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

async function loadUserWebhooks(
  repoDir: string,
  marker: RepoMarkerData | null,
  denoRuntime: EmbeddedDenoRuntime,
  sourceDirs: string[] = [],
  resolverFactory?: () => Promise<DatastorePathResolver | undefined>,
  repository?: ExtensionRepository,
  _quiet = false,
  extensionsDir?: string,
  managedLockfilePath?: string,
  localLockfilePath?: string,
): Promise<void> {
  try {
    const extBase = extensionsDir ?? repoDir;
    const webhooksDir = resolveWebhooksDir(marker);
    const absoluteWebhooksDir = isAbsolute(webhooksDir)
      ? webhooksDir
      : resolve(extBase, webhooksDir);

    const resolver = resolverFactory ? await resolverFactory() : undefined;
    const loader = new ExtensionLoader(
      denoRuntime,
      webhookKindAdapter,
      repoDir,
      resolver,
      repository,
      new ProcessBundleProber(),
      createDenoInfoModuleGraphReader,
    );
    const modelsDir = resolveModelsDir(marker);
    const lockfilePath = managedLockfilePath ?? join(
      isAbsolute(modelsDir) ? modelsDir : resolve(repoDir, modelsDir),
      "upstream_extensions.json",
    );
    const pulledDirs = await enumeratePulledExtensionDirs(
      lockfilePath,
      repoDir,
      "webhooks",
      undefined,
      localLockfilePath,
    );

    if (repository) {
      webhookTypeRegistry.setTypeLoader(async (type) => {
        await loader.loadSingleType(type);
      });

      const result = await loader.buildIndex(absoluteWebhooksDir, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
        indexOnly: true,
      });

      throwOnTransientLoadFailures(result.failed, "webhook");

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user webhook ${failure.file}: ${failure.error}`;
      }
    } else {
      const result = await loader.load(absoluteWebhooksDir, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
        skipAlreadyRegistered: true,
      });

      throwOnTransientLoadFailures(result.failed, "webhook");

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user webhook ${failure.file}: ${failure.error}`;
      }
    }
  } catch (error) {
    if (error instanceof UserError) throw error;
    if (error instanceof Deno.errors.NotFound) return;
    if (isMissingHomeError(error)) return;
    if (isTransientError(error)) {
      throw new UserError(
        `Failed to load extension webhooks: ${
          error instanceof Error ? error.message : String(error)
        }. ` +
          "If another swamp process is writing the extension index, retry once it finishes.",
        "lock_timeout",
      );
    }
    logger
      .warn`Failed to load user webhook extensions: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

function trackedSourceFiles(entry: unknown): string[] {
  if (typeof entry !== "object" || entry === null) return [];
  const { files } = entry as { files?: unknown };
  return Array.isArray(files)
    ? files.filter((file): file is string => typeof file === "string")
    : [];
}

/**
 * entries found only in the in-repo lockfile are reported separately, since
 * extension install restores only the resolved one; an entry already gone
 * entirely awaits the auto-resolver and is not reported
 */
async function checkForMissingPulledExtensions(
  repoDir: string,
  lockfilePath: string,
  localLockfilePath: string | undefined,
  report: (warning: DeferredWarning) => void,
): Promise<void> {
  let installed: InstalledEntries;
  try {
    installed = await readInstalledEntries(lockfilePath, localLockfilePath);
  } catch (error) {
    logger.warn`Cannot check pulled extensions: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return;
  }
  const { entries, localOnly } = installed;
  if (Object.keys(entries).length === 0) return;

  // skips bundle artifacts (regenerable cache), with the same filter as
  // inspectInstallation. advisory: a malformed entry is skipped and anything
  // else that goes wrong warns rather than failing startup
  const missing: Array<{ name: string; file: string }> = [];
  try {
    for (const [name, entry] of Object.entries(entries)) {
      for (const file of trackedSourceFiles(entry)) {
        if (isBundleArtifactPath(file)) continue;
        try {
          await Deno.stat(join(repoDir, file));
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            missing.push({ name, file });
            break;
          }
        }
      }
    }
  } catch (error) {
    logger.warn`Cannot check pulled extensions: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return;
  }

  const describe = (items: typeof missing) => {
    const files = items.map((m) => m.file);
    const detail = ` (e.g. ${files.slice(0, 3).join(", ")})`;
    return `${items.map((m) => m.name).join(", ")}${detail}`;
  };
  const shared = missing.filter((m) => !localOnly.has(m.name));
  const local: typeof missing = [];
  for (const m of missing) {
    if (!localOnly.has(m.name)) continue;
    // Gone entirely, it is reinstalled on next use: nothing to repair.
    if (await isAbsentFromDisk(repoDir, m.name, entries[m.name])) continue;
    local.push(m);
  }
  if (shared.length > 0) {
    report({
      kind: "extensions",
      file: lockfilePath,
      error: `${shared.length} pulled extension(s) have missing source files: ${
        describe(shared)
      }. Run 'swamp extension install' to restore them.`,
    });
  }
  if (local.length > 0) {
    // pulling would record the extension in the team's lockfile, so the remedy
    // is an auto-resolver reinstall. all of an extension's paths, skill dirs
    // included, must go or the auto-resolver treats it as installed
    const toRemove = local.map(({ name }) => {
      const paths = pathsToRemoveForReinstall(repoDir, name, entries);
      return paths.length > 0 ? `${name}: ${paths.join(", ")}` : name;
    });
    report({
      kind: "extensions",
      file: localLockfilePath ?? lockfilePath,
      error:
        `${local.length} auto-resolved extension(s) have missing source files: ${
          describe(local)
        }. To reinstall them, delete what each installed ` +
        `(${toRemove.join("; ")}) and the auto-resolver reinstalls it on ` +
        `next use. Don't use 'swamp extension pull': it would pin the ` +
        `extension in the team's lockfile.`,
    });
  }
}

async function checkForSupersededSkills(
  repoDir: string,
  marker: RepoMarkerData | null,
  deferredWarnings: DeferredWarning[],
): Promise<void> {
  try {
    const allStale = new Set<string>();
    const { contained } = await resolveSupersededSkillDirs(
      repoDir,
      marker?.tools ?? [],
    );
    for (const dir of contained) {
      const stale = await detectSupersededSkills(dir);
      for (const name of stale) allStale.add(name);
    }
    if (allStale.size > 0) {
      const names = [...allStale].sort();
      deferredWarnings.push({
        kind: "skills",
        file: repoDir,
        error:
          `${names.length} old swamp-managed skill(s) can be safely deleted: ${
            names.join(", ")
          }. These have been replaced by the bundled swamp skill. Run 'swamp repo upgrade' to remove them.`,
      });
    }
  } catch {
    // Non-fatal — don't block startup for skill dir read errors
  }
}
