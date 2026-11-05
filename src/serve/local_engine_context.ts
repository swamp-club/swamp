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

import { UserError } from "../domain/errors.ts";
import { TOKEN_SECRETS_VAULT_NAME } from "../domain/vaults/control_plane_vault_provider.ts";
import { initializeControlPlaneVault } from "../domain/vaults/control_plane_vault_init.ts";
import { VaultService } from "../domain/vaults/vault_service.ts";
import { FileSystemControlPlaneStore } from "../infrastructure/persistence/fs_control_plane_store.ts";
import { parseTokenSecretsKeyConfig } from "./serve_config.ts";
import { RetentionPolicy } from "../domain/retention/retention_policy.ts";
import { parseTimerDuration } from "../domain/runtime/timer_duration.ts";
import { GrantsDirectoryPoller } from "../domain/access/grants_directory_poller.ts";
import { createAccessDataPoller } from "./access_data_poller.ts";
import { join, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import { RepoPath } from "../domain/repo/repo_path.ts";
import { RepoMarkerRepository } from "../infrastructure/persistence/repo_marker_repository.ts";
import { createRepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import { DefaultDatastorePathResolver } from "../infrastructure/persistence/default_datastore_path_resolver.ts";
import { resolveSourceBaseDirs } from "../infrastructure/persistence/git_worktree.ts";
import { ensureSupportedDatastoreFormat } from "../infrastructure/persistence/datastore_format_guard.ts";
import {
  DEFAULT_DATASTORE_SUBDIRS,
  type FilesystemDatastoreConfig,
  readDatastoreFormatKey,
} from "../domain/datastore/datastore_config.ts";
import { buildServeAuthConfig } from "../domain/access/serve_auth_config.ts";
import { PolicySnapshotLoader } from "../domain/access/policy_snapshot_loader.ts";
import {
  checkServeGrantFiles,
  readServeGrantFiles,
} from "../domain/access/grant_file_loader.ts";
import type {
  GrantFileEntry,
  ParsedGrantFileEntry,
} from "../domain/access/grant_file.ts";
import {
  createAdminGrantStore,
  materializeAdmins,
} from "../domain/access/admin_materializer.ts";
import {
  createFileGrantStore,
  reconcileAllFileGrants,
} from "../domain/access/grant_file_reconciler.ts";
import { GRANTS_FILE_SOURCE_NAME } from "../domain/access/grant_source.ts";
import {
  readConditionTypeLiterals,
  validateGrantCondition,
} from "../infrastructure/cel/grant_condition_environment.ts";
import {
  collectDirsForKind,
  expandSourcePaths,
  flattenSourceKindDirs,
  readSwampSources,
  resolveSourceExtensionDirs,
} from "../infrastructure/persistence/swamp_sources_repository.ts";
import {
  existingBehaviorsDir,
  modelsDirEnvConflict,
  resolveModelsDir,
} from "../infrastructure/persistence/resolve_models_dir.ts";
import { resolveWorkflowsDir } from "../infrastructure/persistence/resolve_workflows_dir.ts";
import { resolveVaultsDir } from "../infrastructure/persistence/resolve_vaults_dir.ts";
import { resolveReportsDir } from "../infrastructure/persistence/resolve_reports_dir.ts";
import { ExtensionLoader } from "../domain/extensions/extension_loader.ts";
import { CATALOG_FAILURE_STATES } from "../domain/extensions/bundle_freshness.ts";
import { modelKindAdapter } from "../domain/extensions/model_kind_adapter.ts";
import { vaultKindAdapter } from "../domain/extensions/vault_kind_adapter.ts";
import { reportKindAdapter } from "../domain/extensions/report_kind_adapter.ts";
import { ExtensionRepository } from "../infrastructure/persistence/extension_repository.ts";
import {
  ExtensionCatalogStore,
  sourceDirsFingerprint,
} from "../infrastructure/persistence/extension_catalog_store.ts";
import { LockfileRepository } from "../infrastructure/persistence/lockfile_repository.ts";
import { readLocalManifestIdentity } from "../infrastructure/persistence/local_manifest_reader.ts";
import { EmbeddedDenoRuntime } from "../infrastructure/runtime/embedded_deno_runtime.ts";
import { ProcessBundleProber } from "../infrastructure/runtime/process_bundle_prober.ts";
import { createDenoInfoModuleGraphReader } from "../infrastructure/runtime/deno_info_module_graph_reader.ts";
import { enumeratePulledExtensionDirs } from "../libswamp/extensions/enumerate_pulled.ts";
import { ReconcileFromDiskService } from "../libswamp/extensions/reconcile_from_disk_service.ts";
import { resolveFilesystemDatastoreConfig } from "../libswamp/datastores/resolve_filesystem.ts";
import { runInRootUnitOfWork } from "../infrastructure/persistence/repo_unit_of_work.ts";
import {
  localOwnerLiveness,
  RunTrackerStore,
} from "../infrastructure/persistence/run_tracker_store.ts";
import {
  settleDeadOwnerMethodRuns,
  settleDeadOwnerRun,
} from "../domain/workflows/orphaned_run_reaper.ts";
import { ActiveRunRegistry } from "./active_run_registry.ts";
import {
  collectLocalHealth,
  createLocalHealthCollector,
  trackedRunsFrom,
} from "./local/local_dashboard_server.ts";
import { RunCancelRegistry } from "./run_cancel_registry.ts";
import { loadServeConfig, mergeServeOptions } from "./serve_config.ts";
import {
  type ConnectionContext,
  listTokenSessions,
  terminateTokenSessions,
} from "./handlers/shared.ts";
import { readServerTokenRecord } from "./token_auth.ts";
import {
  DEFAULT_TOKEN_SESSION_REVALIDATION_MS,
  TokenSessionRevalidationService,
} from "./token_session_revalidation_service.ts";
import {
  EngineProfileError,
  EngineReadOnlyFallback,
  EngineRepositoryNotInitializedError,
  EngineWorkspaceUntrustedError,
  validateEngineConfig,
  validateEngineWorkflow,
} from "../engine/profile.ts";
import { effectiveDatastoreType } from "../infrastructure/persistence/managed_config_lockfile.ts";
import {
  composeReadOnlyDashboard,
  type ReadOnlyRepoOpener,
} from "./local/read_only_dashboard.ts";

export interface LocalEngineComposition {
  context: ConnectionContext;
  page: { context: ConnectionContext };
  health(signal: AbortSignal): Promise<unknown>;
  mode: "full" | "read-only";
  extensions: boolean;
  /** why a repo local-v1 refused is served read-only; cli callers are told */
  readOnlyReason?: string;
  dispose(): Promise<void>;
}

/**
 * Composition for the explicitly local profile; never starts a listener or CLI.
 * A profile refusal raised before the first write becomes EngineReadOnlyFallback.
 */
export async function createLocalEngineContext(
  repoDir: string,
): Promise<LocalEngineComposition> {
  const progress = { writing: false };
  try {
    return await composeFullEngine(repoDir, progress);
  } catch (error) {
    if (!progress.writing && error instanceof EngineProfileError) {
      throw new EngineReadOnlyFallback(error);
    }
    throw error;
  }
}

/** The dashboard child's composition, for repos local-v1 cannot serve. */
export async function createReadOnlyEngineContext(
  repoDir: string,
  open: ReadOnlyRepoOpener,
  options: { readonly extensions: boolean },
): Promise<LocalEngineComposition> {
  repoDir = await Deno.realPath(repoDir);
  const marker = await new RepoMarkerRepository().read(
    RepoPath.create(repoDir),
  );
  if (!marker) throw new EngineRepositoryNotInitializedError();
  if (!options.extensions && effectiveDatastoreType(marker) !== "filesystem") {
    throw new EngineWorkspaceUntrustedError();
  }
  const repo = await open(repoDir, options);
  try {
    const dashboard = composeReadOnlyDashboard(repo, {
      untrustedWorkspace: !options.extensions,
    });
    dashboard.warmup.start();
    return {
      context: dashboard.context,
      page: { context: dashboard.context },
      health: (signal) =>
        collectLocalHealth(
          dashboard.healthCollector,
          dashboard.trackedRuns,
          signal,
        ),
      mode: "read-only",
      extensions: options.extensions,
      dispose: async () => {
        try {
          await dashboard.warmup.dispose();
          dashboard.runTracker.close();
        } finally {
          await repo.dispose();
        }
      },
    };
  } catch (error) {
    await repo.dispose();
    throw error;
  }
}

async function composeFullEngine(
  repoDir: string,
  progress: { writing: boolean },
): Promise<LocalEngineComposition> {
  if (modelsDirEnvConflict()) {
    throw new EngineProfileError(
      "conflicting SWAMP_MODELS_DIR and SWAMP_BEHAVIORS_DIR",
      "Set only one variable, or set both to the same value.",
    );
  }
  repoDir = await Deno.realPath(repoDir);
  const marker = await new RepoMarkerRepository().read(
    RepoPath.create(repoDir),
  );
  if (!marker) {
    throw new EngineRepositoryNotInitializedError();
  }
  // Environment datastore overrides need the full bootstrap resolver. Refuse
  // them before opening anything rather than using a different store silently.
  if (Deno.env.get("SWAMP_DATASTORE")) {
    throw new EngineProfileError(
      "SWAMP_DATASTORE overrides are not supported; configure the local repository datastore",
    );
  }
  if (Deno.env.get("SWAMP_EXTENSIONS_DIR")) {
    throw new EngineProfileError("SWAMP_EXTENSIONS_DIR overrides");
  }
  const raw = marker.datastore;
  if (raw && raw.type !== "filesystem") {
    throw new EngineProfileError("local-v1 requires a filesystem datastore");
  }
  if (raw?.managedConfig) {
    throw new EngineProfileError("local-v1 does not support managed config");
  }
  const file = loadServeConfig(undefined, repoDir);
  const options = mergeServeOptions(
    {
      schedule: false,
      "detach-runs": true,
      "grant-reload": "auto",
      ...file,
      auth: { mode: "token", ...file?.auth },
    },
    {},
    new Set(),
  );
  // Reject known profile/configuration failures before expression resolution,
  // which can import cached vault code and invoke providers. The preflight
  // path is unused by profile validation; the shared resolver selects it below.
  validateEngineConfig(file, options, {
    type: "filesystem",
    path: repoDir,
    format: readDatastoreFormatKey("filesystem", raw?.format),
    namespace: raw?.namespace,
  });
  let authConfig: ReturnType<typeof buildServeAuthConfig>;
  try {
    authConfig = buildServeAuthConfig(options);
  } catch (error) {
    // A repo with no serve config has no admins for token mode: it serves
    // no cli caller, but a hub can still show its dashboard read-only.
    if (!(error instanceof UserError)) throw error;
    throw new EngineProfileError(
      "this repository's serve authentication",
      error.message,
    );
  }
  const datastoreConfig: FilesystemDatastoreConfig = raw
    ? await resolveFilesystemDatastoreConfig(raw, repoDir, {
      beforeExpressions: async (base) => {
        if (await ensureSupportedDatastoreFormat(repoDir, base) !== "v2") {
          throw new EngineProfileError("local-v1 requires datastore format 2");
        }
      },
    })
    : {
      type: "filesystem",
      path: join(repoDir, ".swamp"),
      directories: [...DEFAULT_DATASTORE_SUBDIRS],
    };
  validateEngineConfig(file, options, datastoreConfig);
  if (await ensureSupportedDatastoreFormat(repoDir, datastoreConfig) !== "v2") {
    throw new EngineProfileError("local-v1 requires datastore format 2");
  }
  const datastoreResolver = new DefaultDatastorePathResolver(
    repoDir,
    datastoreConfig,
  );
  const sourceConfig = await readSwampSources(repoDir);
  const sourceBase = sourceConfig
    ? await resolveSourceBaseDirs(repoDir)
    : undefined;
  const sources = sourceConfig && sourceBase
    ? (await resolveSourceExtensionDirs(
      await expandSourcePaths(
        sourceConfig,
        repoDir,
        sourceBase.baseDir,
        sourceBase.legacyBaseDir,
      ),
    )).resolved
    : [];
  const modelsDir = resolve(repoDir, resolveModelsDir(marker));
  const lockfilePath = join(modelsDir, "upstream_extensions.json");
  progress.writing = true;
  await ensureDir(join(repoDir, ".swamp"));
  const cleanups: Array<() => void | Promise<void>> = [];
  const stops: Array<() => void | Promise<void>> = [];
  let disposing: Promise<void> | undefined;
  function dispose(): Promise<void> {
    disposing ??= (async () => {
      const errors: unknown[] = [];
      for (const cleanup of [...stops.reverse(), ...cleanups.reverse()]) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        throw new AggregateError(errors, "Engine cleanup failed");
      }
    })();
    return disposing;
  }
  const catalog = new ExtensionCatalogStore(
    join(repoDir, ".swamp", "_extension_catalog.db"),
  );
  cleanups.push(() => catalog.close());
  try {
    const lockfileRepository = await LockfileRepository.create(lockfilePath);
    const localManifestIdentity = readLocalManifestIdentity(repoDir);
    const extensions = new ExtensionRepository({
      catalog,
      lockfileRepository,
      repoRoot: repoDir,
      localManifestIdentity,
      mountedSourceDirs: flattenSourceKindDirs(sources),
    });
    const denoRuntime = new EmbeddedDenoRuntime();
    const behaviorsDir = await existingBehaviorsDir(repoDir, marker);
    const vaultsDir = resolve(repoDir, resolveVaultsDir(marker));
    const reportsDir = resolve(repoDir, resolveReportsDir(marker));
    const kinds = [];
    for (
      const [adapter, dir, kind] of [
        [modelKindAdapter, modelsDir, "models"],
        [vaultKindAdapter, vaultsDir, "vaults"],
        [reportKindAdapter, reportsDir, "reports"],
      ] as const
    ) {
      const localDirs = kind === "models" && behaviorsDir ? [behaviorsDir] : [];
      const additionalDirs = [
        ...collectDirsForKind(sources, kind),
        ...await enumeratePulledExtensionDirs(lockfilePath, repoDir, kind),
      ];
      kinds.push({ adapter, dir, kind, localDirs, additionalDirs });
    }
    // The shared cold-start reconcile probes actual exports, including wrapped
    // and computed declarations that cannot be discovered by source scanning.
    if (
      extensions.anyKindNeedsInvalidation() ||
      extensions.manifestIdentityChanged(localManifestIdentity) ||
      kinds.some(({ adapter, dir, localDirs, additionalDirs }) =>
        catalog.getSourceDirsFingerprint(adapter.kind) !==
          sourceDirsFingerprint(dir, [...localDirs, ...additionalDirs])
      )
    ) {
      await new ReconcileFromDiskService({
        denoRuntime,
        repository: extensions,
        lockfileRepository,
        repoDir,
        localManifestIdentity,
        localDirectories: {
          models: [modelsDir, ...(behaviorsDir ? [behaviorsDir] : [])],
          vaults: [vaultsDir],
          reports: [reportsDir],
        },
        bundleProber: new ProcessBundleProber(),
      }).execute();
    }
    for (
      const { adapter, dir, kind, localDirs, additionalDirs } of kinds
    ) {
      const loader = new ExtensionLoader(
        denoRuntime,
        adapter,
        repoDir,
        datastoreResolver,
        extensions,
        new ProcessBundleProber(),
        createDenoInfoModuleGraphReader,
      );
      // Resolve local overrides and ordered mounts before importing any winner
      // into this engine. Eager promotion keeps the local profile load-once.
      const loaded = await loader.buildIndex(dir, {
        indexOnly: true,
        additionalDirs,
        localDirs,
      });
      const rows = adapter.catalogKinds.flatMap((kind) =>
        catalog.findByKind(kind)
      );
      const loadFailure = () =>
        new Error(
          `Engine failed to load installed ${kind}; repair extensions locally before serving`,
        );
      if (
        loaded.failed.length ||
        rows.some((row) =>
          row.state === "ValidationFailed" ||
          CATALOG_FAILURE_STATES.has(row.state ?? "Indexed")
        )
      ) {
        throw loadFailure();
      }
      for (const row of rows) {
        if (
          row.kind !== adapter.catalogKinds[0] || !row.type_normalized ||
          row.state === "Tombstoned"
        ) continue;
        await loader.loadSingleType(row.type_normalized);
        if (!adapter.isFullyLoaded(row.type_normalized)) throw loadFailure();
      }
      // Built-ins have no primary catalog row, so promote their add-ons too.
      for (const type of new Set(rows.map((row) => row.extends_type))) {
        if (!type) continue;
        if (!adapter.isFullyLoaded(type)) throw loadFailure();
        await loader.attachPendingExtensionsForType(type);
      }
    }
    const repoContext = createRepositoryContext({
      repoDir,
      datastoreResolver,
      workflowsDir: resolve(repoDir, resolveWorkflowsDir(marker)),
      additionalWorkflowsDirs: [
        ...collectDirsForKind(sources, "workflows"),
        ...await enumeratePulledExtensionDirs(
          lockfilePath,
          repoDir,
          "workflows",
        ),
      ],
      filterStaleRows: true,
      autoGc: marker.autoGc === true,
    });
    cleanups.push(() => repoContext.catalogStore.close());
    await initializeControlPlaneVault(
      new FileSystemControlPlaneStore(join(repoDir, ".swamp")),
      false,
      {
        tokenSecretsKey: parseTokenSecretsKeyConfig(
          file,
          join(repoDir, ".swamp", "serve.yaml"),
        ),
        vaultService: () =>
          VaultService.fromRepository(repoDir, {
            defaultVaultName: marker.defaultVault,
          }),
      },
    );
    cleanups.push(() =>
      VaultService.unregisterGlobalProvider(TOKEN_SECRETS_VAULT_NAME)
    );
    const grants = await readServeGrantFiles(repoDir, {
      grantsFile: options.grantsFile,
      grantsDir: options.grantsDir,
      validateCondition: validateGrantCondition,
      readTypeLiterals: readConditionTypeLiterals,
    });
    const checked = checkServeGrantFiles(grants);
    if (
      checked.errors.length ||
      checked.warnings.some((w) => w.reason === "missing-source")
    ) {
      throw new Error(
        "Engine grant file validation failed; run swamp serve check-config",
      );
    }
    const entries = new Map<string, ParsedGrantFileEntry[]>();
    for (const [name, result] of grants.repo) entries.set(name, result.entries);
    if (grants.grantsFile?.status === "loaded") {
      entries.set(
        GRANTS_FILE_SOURCE_NAME,
        grants.grantsFile.file.result?.entries ?? [],
      );
    }
    if (grants.grantsDir?.status === "loaded") {
      for (const f of grants.grantsDir.files) {
        entries.set(f.sourceName, f.result?.entries ?? []);
      }
    }
    if (
      [...entries.values()].flat().some((e) => e.subject.kind === "username")
    ) {
      throw new EngineProfileError(
        "Username grant subjects require OAuth and are not supported by local-v1",
      );
    }
    const resolvedEntries = new Map<string, GrantFileEntry[]>();
    for (const [name, parsed] of entries) {
      resolvedEntries.set(
        name,
        parsed.map((entry) => {
          if (entry.subject.kind === "username") {
            throw new EngineProfileError(
              "Username grant subjects require OAuth",
            );
          }
          return { ...entry, subject: entry.subject };
        }),
      );
    }
    await runInRootUnitOfWork(repoContext, { flush: undefined }, async () => {
      await materializeAdmins(
        authConfig.mode,
        authConfig.admins,
        createAdminGrantStore(
          repoContext.definitionRepo,
          repoContext.definitionRepo,
          repoContext.unifiedDataRepo,
        ),
      );
      await reconcileAllFileGrants(
        resolvedEntries,
        createFileGrantStore(
          repoContext.definitionRepo,
          repoContext.definitionRepo,
          repoContext.unifiedDataRepo,
        ),
      );
    });
    const policySnapshotLoader = new PolicySnapshotLoader(
      repoContext.unifiedDataRepo,
      repoContext.eventBus,
      "auto",
      {
        runImpliesApprove: !authConfig.approveRequiresExplicitGrant,
        runImpliesSignal: !authConfig.signalRequiresExplicitGrant,
        writeImpliesTag: !authConfig.tagRequiresExplicitGrant,
      },
      readConditionTypeLiterals,
    );
    stops.push(() => policySnapshotLoader.dispose());
    const accessPoller = await createAccessDataPoller({
      policySnapshotLoader,
      catalogInvalidate: () => repoContext.catalogStore.invalidate(),
      datastoreConfig,
      datastoreEngine: "v2",
      datastoreResolver,
      eventBus: repoContext.eventBus,
    });
    stops.push(() => accessPoller?.stop());
    await policySnapshotLoader.load();
    accessPoller?.start();
    const grantsPoller = new GrantsDirectoryPoller({
      grantsDir: join(repoDir, "grants"),
      externalGrantsFile: options.grantsFile
        ? resolve(repoDir, options.grantsFile)
        : undefined,
      externalGrantsDir: options.grantsDir
        ? resolve(repoDir, options.grantsDir)
        : undefined,
      validateCondition: validateGrantCondition,
      fileGrantStore: createFileGrantStore(
        repoContext.definitionRepo,
        repoContext.definitionRepo,
        repoContext.unifiedDataRepo,
      ),
      policySnapshotLoader,
      commitReconcile: (action) =>
        runInRootUnitOfWork(repoContext, { flush: undefined }, action),
    });
    stops.push(() => grantsPoller.stop());
    await grantsPoller.start();
    const runTracker = RunTrackerStore.fromSwampDir(join(repoDir, ".swamp"));
    cleanups.push(() => runTracker.close());
    // The local CLI may be alive in this repository. Only proven-dead owners
    // are interrupted; a fresh engine generation is not proof of death.
    const liveness = localOwnerLiveness();
    await runInRootUnitOfWork(repoContext, { flush: undefined }, async () => {
      for (
        const { run, workflowId } of await repoContext.workflowRunRepo
          .findGlobalByStatus("running")
      ) {
        await settleDeadOwnerRun(
          repoContext.workflowRunRepo,
          runTracker,
          workflowId,
          run.id,
          liveness,
          repoContext.outputRepo,
        );
      }
      await settleDeadOwnerMethodRuns(
        repoContext.outputRepo,
        runTracker,
        liveness,
      );
    });
    const context: ConnectionContext = {
      repoDir,
      repoContext,
      datastoreConfig,
      datastoreResolver,
      authConfig,
      policySnapshotLoader,
      activeRunRegistry: new ActiveRunRegistry({
        maxConcurrent: options.maxConcurrentRuns,
        maxPerPrincipal: options.maxRunsPerPrincipal,
        maxRunDurationMs: options.maxRunDuration === undefined
          ? undefined
          : parseTimerDuration(options.maxRunDuration, "--max-run-duration"),
      }),
      cancelRegistry: new RunCancelRegistry(),
      runTracker,
      instanceId: crypto.randomUUID(),
      defaultVault: marker.defaultVault,
      // Vault definitions live here; resolveVaultsDir above selects extension
      // source code. This profile refuses the managed-config definition tier.
      vaultsDir: join(repoDir, "vaults"),
      validateWorkflow: validateEngineWorkflow,
    };
    const { initializeLocalEngineAudit } = await import(
      "./local_engine_audit.ts"
    );
    const retention = RetentionPolicy.fromConfig(marker.garbageCollection);
    const closeAudit = await initializeLocalEngineAudit(
      context,
      file,
      retention.automatic ? retention.retentionMs("audit") : undefined,
    );
    cleanups.push(closeAudit);
    const tokenRevalidation = new TokenSessionRevalidationService({
      intervalMs: DEFAULT_TOKEN_SESSION_REVALIDATION_MS,
      listTokenSessions,
      readToken: (name) => readServerTokenRecord(repoContext, name),
      terminateSessions: (name, settings) =>
        terminateTokenSessions(name, {
          ...settings,
          initiatedBy: "system",
          audit: {
            emitter: context.auditEmitter,
            instanceId: context.instanceId,
          },
        }),
    });
    stops.push(() => tokenRevalidation.dispose());
    tokenRevalidation.start();
    return {
      context,
      ...localPageServices(context),
      mode: "full",
      extensions: true,
      dispose,
    };
  } catch (error) {
    try {
      await dispose();
    } catch { /* Preserve the original startup refusal. */ }
    throw error;
  }
}

/**
 * Built after every context mutation: a page shares each service with the cli
 * context, and only its auth mode differs.
 */
export function localPageServices(context: ConnectionContext): {
  page: { context: ConnectionContext };
  health(signal: AbortSignal): Promise<unknown>;
} {
  const healthCollector = createLocalHealthCollector({
    instanceId: context.instanceId ?? crypto.randomUUID(),
    activeRunRegistry: context.activeRunRegistry!,
    datastoreConfig: context.datastoreConfig,
  });
  const trackedRuns = context.runTracker
    ? trackedRunsFrom(context.runTracker)
    : undefined;
  return {
    page: {
      context: {
        ...context,
        authConfig: buildServeAuthConfig({}),
        healthCollector,
      },
    },
    health: (signal) =>
      collectLocalHealth(healthCollector, trackedRuns, signal),
  };
}
