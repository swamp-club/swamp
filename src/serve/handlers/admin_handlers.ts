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
 * Platform-admin request handlers (worker, datastore, extension, doctor, run-tracker, and audit-timeline verbs).
 */

import { runGeneratorWithoutVaultAccess } from "../../domain/vaults/run_vault_access.ts";
import { isAbsolute, join, relative, resolve } from "@std/path";
import {
  DEFAULT_STALE_TTL_MS,
  InstanceHeartbeatService,
} from "../instance_heartbeat.ts";
import type { MergedServeOptions } from "../serve_config.ts";
import {
  type ActiveRun,
  STALE_TTL_MS,
} from "../../domain/models/active_run.ts";
import {
  auditTimeline,
  createAuditTimelineDeps,
} from "../../libswamp/audit/timeline.ts";
import { buildAggregateState } from "../../libswamp/extensions/doctor_aggregate.ts";
import { consumeStream, withDefaults } from "../../libswamp/stream.ts";
import {
  createRepoPendingLockfileStore,
  createRootLockfileSync,
  type LockfileTransaction,
  ManagedLockfileTransaction,
  withManagedLockfileTransaction,
} from "../../libswamp/extensions/managed_lockfile_transaction.ts";
import {
  createDatastoreSetupDeps,
  datastoreSetupExtension,
} from "../../libswamp/datastores/setup.ts";
import {
  createDatastoreStatusDeps,
  datastoreStatus,
} from "../../libswamp/datastores/status.ts";
import {
  createDoctorSecretsDeps,
  doctorSecrets,
} from "../../libswamp/models/doctor_secrets.ts";
import {
  createDoctorVaultsDeps,
  doctorVaults,
} from "../../libswamp/models/doctor_vaults.ts";
import {
  createExtensionInfoDeps,
  extensionInfo,
} from "../../libswamp/extensions/info.ts";
import {
  createExtensionListDeps,
  extensionList,
} from "../../libswamp/extensions/list.ts";
import {
  createExtensionPullDeps,
  createInstallContext,
  extensionPull,
  parseExtensionRef,
  resolveServerUrl,
  validateExtensionName,
} from "../../libswamp/extensions/pull.ts";
import {
  createExtensionRmDeps,
  extensionRm,
} from "../../libswamp/extensions/rm.ts";
import {
  createExtensionUpdateDeps,
  extensionUpdate,
} from "../../libswamp/extensions/update.ts";
import {
  createModelDeleteDeps,
  modelDelete,
} from "../../libswamp/models/delete.ts";
import {
  createVaultMigrateDeps,
  vaultMigrate,
  vaultMigratePreview,
} from "../../libswamp/vaults/migrate.ts";
import {
  createWorkerListDeps,
  workerList,
  workerTokenList,
} from "../../libswamp/worker/list.ts";
import { createWorkerModelRunDeps } from "../../libswamp/worker/run_deps.ts";
import {
  createWorkerQueueListDeps,
  workerQueueList,
} from "../../libswamp/worker/queue_list.ts";
import {
  createWorkerTokenCreateDeps,
  workerTokenCreate,
} from "../../libswamp/worker/token_create.ts";
import {
  createWorkerTokenRevokeDeps,
  workerTokenRevoke,
} from "../../libswamp/worker/token_revoke.ts";
import { datastoreNamespaceList } from "../../libswamp/datastores/namespace_list.ts";
import {
  doctorDatastores,
  type DoctorDatastoresDeps,
} from "../../libswamp/datastores/doctor_datastores.ts";
import {
  doctorExtensions,
  type DoctorExtensionsDeps,
  type DoctorRegistryDeps,
  extensionMemberDoctorDeps,
  toDoctorWarnings,
} from "../../libswamp/extensions/doctor.ts";
import {
  doctorWorkflowDirs,
  doctorWorkflows,
  type DoctorWorkflowsDeps,
} from "../../libswamp/workflows/doctor.ts";
import { extensionInstall } from "../../libswamp/extensions/install.ts";
import {
  extensionSearch,
  type ExtensionSearchDeps,
} from "../../libswamp/extensions/search.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import { modelMethodRun } from "../../libswamp/models/run.ts";
import {
  ReconcileFromDiskService,
  type ReconcileTransition,
} from "../../libswamp/extensions/reconcile_from_disk_service.ts";
import type { TriggerOverride } from "../../libswamp/workflows/scheduled_execution.ts";
import { UpgradeExtensionService } from "../../libswamp/extensions/upgrade_extension_service.ts";
import {
  workerPrune,
  type WorkerPruneDeps,
} from "../../libswamp/worker/prune.ts";
import {
  WORKER_MODEL_TYPE,
  WorkerStateSchema,
} from "../../domain/models/worker/worker_model.ts";
import { fleetMemberSuffix } from "../worker_gateway.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";
import { DEFAULT_WORKER_GC_GRACE_PERIOD_MS } from "../worker_gc_service.ts";
import {
  type CustomDatastoreConfig,
  isCustomDatastoreConfig,
  resolveSyncTimeoutMs,
} from "../../domain/datastore/datastore_config.ts";
import type { DatastoreProvider } from "../../domain/datastore/datastore_provider.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import { FilesystemDatastoreVerifier } from "../../infrastructure/persistence/filesystem_datastore_verifier.ts";

import {
  datastoreBasePath,
  resolveConfigTierPath,
  resolveDatastoreConfig,
} from "../../cli/resolve_datastore.ts";
import {
  listNamespaceManifests,
} from "../../infrastructure/persistence/namespace_manifest.ts";
import { createExtensionInstallDeps } from "../../cli/create_extension_install_deps.ts";
import { loadIdentity } from "../../cli/load_identity.ts";
import { resolveModelsDir } from "../../cli/resolve_models_dir.ts";
import type {
  AuditTimelinePayload,
  DatastoreSetupExtensionPayload,
  ExtensionInfoPayload,
  ExtensionPullPayload,
  ExtensionRmPayload,
  ExtensionSearchPayload,
  ExtensionUpdatePayload,
  VaultMigratePayload,
  WorkerListPayload,
  WorkerProbeResult,
  WorkerPrunePayload,
  WorkerTokenCreatePayload,
  WorkerTokenRevokePayload,
  WorkerVerifyPayload,
} from "../protocol.ts";
import { dispatchFleetProbe } from "../fleet_probe_dispatch.ts";
import { ownerGoneDecider } from "../suspended_run_cancel.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import { isExtensionBackedDatastore } from "../../infrastructure/persistence/managed_config_lockfile.ts";
import { datastoreGlobalLock } from "../../infrastructure/persistence/datastore_global_lock.ts";
import {
  transitionalInstalledNames,
  transitionalLocalLockfilePath,
} from "../../infrastructure/persistence/installed_entries.ts";
import { ExtensionApiClient } from "../../infrastructure/http/extension_api_client.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import { readLocalManifestIdentity } from "../../infrastructure/persistence/local_manifest_reader.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { runInRootUnitOfWork } from "../../infrastructure/persistence/repo_unit_of_work.ts";
import { pushNamespaceCounted } from "../../infrastructure/persistence/push_paths.ts";
import { EmbeddedDenoRuntime } from "../../infrastructure/runtime/embedded_deno_runtime.ts";
import {
  getExtensionLoadWarnings,
  resetExtensionLoadWarnings,
} from "../../infrastructure/logging/extension_load_warnings.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { resolvePrimaryTool } from "../../domain/repo/primary_tool.ts";
import { resolveUniqueLocalSkillsDirs } from "../../domain/repo/skill_dirs.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import {
  runRecordFinder,
  settleInterruptedWorkflowRows,
} from "../../domain/workflows/orphaned_run_reaper.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import { webhookTypeRegistry } from "../../domain/webhooks/webhook_type_registry.ts";
import type { Principal } from "../../domain/access/principal.ts";
import {
  authorizeOrReject,
  authorizeVaultOrReject,
  type ConnectionContext,
  handlerLibSwampContext,
  pushChangedToRemote,
  sanitizeErrorForClient,
  send,
  sendError,
} from "./shared.ts";
import { kindResource } from "../../domain/access/access_decision_service.ts";
import {
  performServeReload,
  resolveLockfilePath,
  type ServeReloadOptions,
} from "../extension_reload.ts";
import { isReservedVaultName } from "./vault_handlers.ts";
import { TOKEN_SECRETS_VAULT_NAME } from "../../domain/vaults/control_plane_vault_provider.ts";

/**
 * Derives the extension lockfile path from the connection context's
 * datastore resolver. When managedConfig is true the lockfile lives at the
 * datastore-resolved config path (cache path for S3, local for filesystem).
 * Pulled extension sources always live under the in-repo pulled root.
 */
function resolveManagedPathsFromContext(
  ctx: ConnectionContext,
  marker:
    | import("../../infrastructure/persistence/repo_marker_repository.ts").RepoMarkerData
    | null,
): { lockfilePath: string } {
  if (marker?.datastore?.managedConfig) {
    const configBase = ctx.datastoreResolver.resolvePath("config");
    return {
      lockfilePath: join(configBase, "upstream_extensions.json"),
    };
  }
  const modelsDir = resolveModelsDir(marker);
  return {
    lockfilePath: join(
      isAbsolute(modelsDir) ? modelsDir : resolve(ctx.repoDir, modelsDir),
      "upstream_extensions.json",
    ),
  };
}

/**
 * The transaction an extension handler runs its lockfile changes in. Under
 * managedConfig on an extension-backed datastore the lockfile is shared
 * with other instances and checkouts: each change is made against the
 * datastore's copy under the datastore global lock and published as it
 * lands (swamp-club#2838). Extension sources stay in the repo-local
 * pulled-extensions root (swamp-club#2612). Otherwise undefined, and the
 * handler writes the lockfile directly.
 *
 * Each outermost run is the request's root unit of work over
 * `repoContext.markDirty` itself, with no flush and the namespace push as
 * its checkpoint: the publish stages the lockfile into it and pushes at the
 * checkpoint, inside the sync gate and before the global lock is released
 * (swamp-club#3192).
 */
function extensionLockfileTransaction(
  ctx: ConnectionContext,
  marker:
    | import("../../infrastructure/persistence/repo_marker_repository.ts").RepoMarkerData
    | null,
  lockfilePath: string,
): LockfileTransaction | undefined {
  const { syncService, datastoreConfig } = ctx;
  const markDirty = ctx.repoContext.markDirty;
  if (!syncService || !markDirty || !isExtensionBackedDatastore(marker)) {
    return undefined;
  }
  const logger = getSwampLogger(["serve", "extension", "lockfile"]);
  const namespace = isCustomDatastoreConfig(datastoreConfig)
    ? datastoreConfig.namespace
    : undefined;
  return new ManagedLockfileTransaction({
    lockfilePath,
    // The hook itself, captured once, for both the root and the publish:
    // the publish finds the root by hook identity.
    inRoot: (fn) =>
      runInRootUnitOfWork(
        { markDirty },
        {
          flush: undefined,
          checkpoint: ({ signal }) =>
            pushNamespaceCounted(syncService, namespace, signal),
        },
        () => fn(),
      ),
    // Taken inside the handler's exclusive sync gate: the gate always comes
    // before the global lock in serve (see sync_gate.ts).
    lock: datastoreGlobalLock(datastoreConfig),
    sync: createRootLockfileSync({
      syncService,
      namespace,
      timeoutMs: resolveSyncTimeoutMs(datastoreConfig),
      lockfilePath,
      markDirty,
    }),
    pending: createRepoPendingLockfileStore(ctx.repoDir),
    // The change has applied on this instance, so the request succeeds; a
    // failed publish stays pending and the next extension change retries it.
    publishFailure: "defer",
    onWarning: (message, error) =>
      error === undefined ? logger.warn(message) : logger.warn(
        `${message}: {error}`,
        { error: error instanceof Error ? error.message : String(error) },
      ),
  });
}

export async function handleWorkerList(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: WorkerListPayload,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx).allowed
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps = createWorkerListDeps(ctx.repoContext.dataQueryService);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workerList(libCtx, deps, {
        includeDisconnected: payload?.showAll ?? false,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "worker.list",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "worker_list_failed", message);
  }
}

export async function handleWorkerQueueList(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx).allowed
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps = createWorkerQueueListDeps(ctx.repoContext.dataQueryService);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workerQueueList(libCtx, deps),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "worker.queue.list",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "worker_queue_list_failed", message);
  }
}

export async function handleWorkerVerify(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkerVerifyPayload | undefined,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx).allowed
  ) return;

  if (!ctx.workerGateway) {
    sendError(
      socket,
      requestId,
      "not_available",
      "Worker gateway not available",
    );
    return;
  }

  if (!ctx.dispatchService) {
    sendError(
      socket,
      requestId,
      "not_available",
      "Dispatch service not available",
    );
    return;
  }

  try {
    let workers = ctx.workerGateway.workers();

    if (payload?.workerName) {
      workers = workers.filter((w) => w.name === payload.workerName);
    } else if (payload?.labels) {
      const requiredLabels = payload.labels;
      workers = workers.filter((w) =>
        Object.entries(requiredLabels).every(([k, v]) => w.labels[k] === v)
      );
    }

    const connectedWorkers = workers.filter((w) => w.connected);
    const results: WorkerProbeResult[] = [];

    for (const worker of connectedWorkers) {
      if (controller.signal.aborted) break;
      results.push(
        await dispatchFleetProbe(
          ctx.dispatchService,
          ctx.repoContext.unifiedDataRepo,
          worker.name,
          "fleet-verify",
          controller.signal,
        ),
      );
    }

    send(socket, {
      type: "worker.verify",
      id: requestId,
      payload: {
        data: {
          workers: results,
          total: connectedWorkers.length,
          passed: results.filter((r) => r.status === "pass").length,
          failed: results.filter((r) => r.status !== "pass").length,
        },
      },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "worker_verify_failed", message);
  }
}

export async function handleDatastoreStatus(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx).allowed
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps = await createDatastoreStatusDeps(ctx.datastoreResolver);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      datastoreStatus(libCtx, deps),
      {
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "datastore.status",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "datastore_status_failed", message);
  }
}

export async function handleExtensionList(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "read",
      kindResource("model"),
      ctx,
    ).allowed
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const marker = await new RepoMarkerRepository().read(
      RepoPath.create(ctx.repoDir),
    );
    const { lockfilePath } = resolveManagedPathsFromContext(ctx, marker);
    const deps = await createExtensionListDeps(
      ctx.repoDir,
      lockfilePath,
      transitionalLocalLockfilePath(ctx.repoDir, marker, lockfilePath),
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      extensionList(libCtx, deps),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "extension.list",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "extension_list_failed", message);
  }
}

export async function handleExtensionSearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: ExtensionSearchPayload,
): Promise<void> {
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "read",
      kindResource("model"),
      ctx,
    ).allowed
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const serverUrl = resolveServerUrl();
    const identity = await loadIdentity();
    const client = new ExtensionApiClient(serverUrl, identity);
    const apiKey = identity.bearerToken;
    const deps: ExtensionSearchDeps = {
      searchExtensions: (params) =>
        client.searchExtensions(
          params as Parameters<typeof client.searchExtensions>[0],
          apiKey,
        ),
    };

    const toArray = (
      v: string | string[] | undefined,
    ): string[] | undefined =>
      v == null ? undefined : Array.isArray(v) ? v : [v];

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      extensionSearch(libCtx, deps, {
        query: payload?.query,
        collective: payload?.collective,
        platform: toArray(
          payload?.platform as string | string[] | undefined,
        ),
        label: toArray(payload?.label as string | string[] | undefined),
        contentType: toArray(
          payload?.contentType as string | string[] | undefined,
        ),
        channel: toArray(
          payload?.channel as string | string[] | undefined,
        ),
        sort: payload?.sort as
          | "name"
          | "new"
          | "relevance"
          | "updated"
          | undefined,
        perPage: payload?.perPage,
        page: payload?.page,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "extension.search",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "extension_search_failed", message);
  }
}

export async function handleExtensionInfo(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ExtensionInfoPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "read",
      kindResource("model"),
      ctx,
    ).allowed
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const identity = await loadIdentity();
    const deps = createExtensionInfoDeps(identity.bearerToken, identity);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      extensionInfo(libCtx, deps, {
        extensionName: payload.extensionName,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        not_found: () => {},
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(
        socket,
        requestId,
        "not_found",
        `Extension not found: ${payload.extensionName}`,
      );
      return;
    }

    send(socket, {
      type: "extension.info",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "extension_info_failed", message);
  }
}

export async function handleExtensionInstall(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "admin",
      kindResource("model"),
      ctx,
    ).allowed
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const logger = getSwampLogger(["serve", "extension", "install"]);
    const marker = await new RepoMarkerRepository().read(
      RepoPath.create(ctx.repoDir),
    );
    // Serve's datastore resolver is always resolved; use its lockfile
    // rather than the process-wide registry (swamp-club#2483).
    const { lockfilePath } = resolveManagedPathsFromContext(ctx, marker);
    const deps = await createExtensionInstallDeps(ctx.repoDir, logger, {
      lockfilePath,
    });

    let result: Record<string, unknown> | undefined;
    await withManagedLockfileTransaction(
      extensionLockfileTransaction(ctx, marker, lockfilePath),
      () =>
        consumeStream(
          extensionInstall(libCtx, deps),
          {
            resolving: () => {},
            installing: () => {},
            migrating: () => {},
            "orphans-pruned": () => {},
            completed: (e) => {
              result = e.data as unknown as Record<string, unknown>;
            },
            error: (e) => {
              throw new Error(e.error.message);
            },
          },
        ),
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "extension.install",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "extension_install_failed", message);
  }
}

export async function handleExtensionPull(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ExtensionPullPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "admin",
      kindResource("model"),
      ctx,
    ).allowed
  ) return;

  let catalog: ExtensionCatalogStore | undefined;
  try {
    const repoDir = ctx.repoDir;
    const ref = parseExtensionRef(payload.extensionName);
    validateExtensionName(ref.name);

    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(RepoPath.create(repoDir));
    const { lockfilePath } = resolveManagedPathsFromContext(ctx, marker);

    const tools = marker?.tools?.length ? marker.tools : ["claude"];
    const skillsDirs = resolveUniqueLocalSkillsDirs(repoDir, tools);

    const denoRuntime = new EmbeddedDenoRuntime();
    catalog = new ExtensionCatalogStore(
      swampPath(repoDir, "_extension_catalog.db"),
    );

    const serverUrl = resolveServerUrl();
    const identity = await loadIdentity();
    const deps = await createExtensionPullDeps(
      serverUrl,
      lockfilePath,
      skillsDirs,
      repoDir,
      { identity },
    );
    const repository = new ExtensionRepository({
      catalog,
      lockfileRepository: deps.lockfileRepository,
      repoRoot: repoDir,
      localManifestIdentity: readLocalManifestIdentity(repoDir),
    });

    const libCtx = handlerLibSwampContext(ctx, { signal: controller.signal });
    const pullDeps = {
      getExtension: deps.getExtension,
      getLatestVersion: deps.getLatestVersion,
      downloadArchive: deps.downloadArchive,
      getChecksum: deps.getChecksum,
      lockfileRepository: deps.lockfileRepository,
      skillsDirs,
      repoDir,
      alreadyPulled: new Set<string>(),
      depth: 0,
      denoRuntime,
      repository,
    };

    let result: Record<string, unknown> | undefined;
    await withManagedLockfileTransaction(
      extensionLockfileTransaction(ctx, marker, lockfilePath),
      () =>
        consumeStream(
          extensionPull(libCtx, pullDeps, {
            ref,
            force: payload.force ?? false,
            channel: payload.channel,
          }),
          {
            installing: () => {
              if (controller.signal.aborted) throw new Error("cancelled");
            },
            deprecated_warning: () => {},
            "orphans-pruned": () => {},
            completed: (e) => {
              result = e.data as unknown as Record<string, unknown>;
            },
            error: (e) => {
              throw new Error(e.error.message);
            },
          },
        ),
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "extension.pull",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const raw = error instanceof Error
      ? error
      : typeof error === "object" && error !== null && "message" in error
      ? (error as { message: string }).message
      : error;
    const message = sanitizeErrorForClient(raw);
    sendError(socket, requestId, "extension_pull_failed", message);
  } finally {
    catalog?.close();
  }
}

export async function handleExtensionRm(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ExtensionRmPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "admin",
      kindResource("model"),
      ctx,
    ).allowed
  ) return;

  let deps: Awaited<ReturnType<typeof createExtensionRmDeps>> | undefined;
  try {
    const repoDir = ctx.repoDir;
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(RepoPath.create(repoDir));
    const { lockfilePath } = resolveManagedPathsFromContext(ctx, marker);

    const rmDeps = await createExtensionRmDeps(repoDir, lockfilePath);
    deps = rmDeps;
    const libCtx = handlerLibSwampContext(ctx);

    let result: Record<string, unknown> | undefined;
    await withManagedLockfileTransaction(
      extensionLockfileTransaction(ctx, marker, lockfilePath),
      () =>
        consumeStream(
          extensionRm(libCtx, rmDeps, { extensionName: payload.extensionName }),
          {
            deleting: () => {},
            completed: (e) => {
              result = e.data as unknown as Record<string, unknown>;
            },
            error: (e) => {
              throw new Error(e.error.message);
            },
          },
        ),
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "extension.rm",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "extension_rm_failed", message);
  } finally {
    deps?.repository.close();
  }
}

export async function handleExtensionOutdated(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "read",
      kindResource("model"),
      ctx,
    ).allowed
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const repoDir = ctx.repoDir;
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(RepoPath.create(repoDir));
    const { lockfilePath } = resolveManagedPathsFromContext(ctx, marker);

    const identity = await loadIdentity();
    const deps = await createExtensionUpdateDeps({
      lockfilePath,
      serverUrl: resolveServerUrl(),
      identity,
      installExtension: () => {
        throw new Error("should not be called in checkOnly mode");
      },
    });

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      extensionUpdate(libCtx, deps, { checkOnly: true }),
      {
        no_extensions: () => {},
        extension_not_installed: () => {},
        checking: () => {},
        updating: () => {},
        "orphans-pruned": () => {},
        "shadowed-by-local": () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "extension.outdated",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "extension_outdated_failed", message);
  }
}

export async function handleExtensionUpdate(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ExtensionUpdatePayload | undefined,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "admin",
      kindResource("model"),
      ctx,
    ).allowed
  ) return;

  let catalog: ExtensionCatalogStore | undefined;
  try {
    const libCtx = handlerLibSwampContext(ctx, { signal: controller.signal });
    const logger = getSwampLogger(["serve", "extension", "update"]);
    const repoDir = ctx.repoDir;
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(RepoPath.create(repoDir));
    const { lockfilePath } = resolveManagedPathsFromContext(ctx, marker);

    const tools = marker?.tools?.length ? marker.tools : ["claude"];
    const skillsDirs = resolveUniqueLocalSkillsDirs(repoDir, tools);

    const denoRuntime = new EmbeddedDenoRuntime();
    catalog = new ExtensionCatalogStore(
      swampPath(repoDir, "_extension_catalog.db"),
    );

    const serverUrl = resolveServerUrl();
    const identity = await loadIdentity();
    const deps = await createExtensionUpdateDeps({
      lockfilePath,
      serverUrl,
      identity,
      installExtension: async (
        name: string,
        version: string,
        channel?: string,
      ) => {
        const installCtx = await createInstallContext(serverUrl, {
          logger,
          lockfilePath,
          skillsDirs,
          repoDir,
          force: true,
          channel,
          identity,
        });
        const repository = new ExtensionRepository({
          catalog: catalog!,
          lockfileRepository: installCtx.lockfileRepository,
          repoRoot: repoDir,
        });
        return await new UpgradeExtensionService({
          denoRuntime,
          repository,
        }).execute(name, version, installCtx);
      },
    });

    let result: Record<string, unknown> | undefined;
    await withManagedLockfileTransaction(
      payload?.checkOnly
        ? undefined
        : extensionLockfileTransaction(ctx, marker, lockfilePath),
      () =>
        consumeStream(
          extensionUpdate(libCtx, deps, {
            extensionName: payload?.extensionName,
            checkOnly: payload?.checkOnly ?? false,
          }),
          {
            no_extensions: () => {},
            extension_not_installed: () => {},
            checking: () => {},
            updating: () => {},
            "orphans-pruned": () => {},
            "shadowed-by-local": () => {},
            completed: (e) => {
              result = e.data as unknown as Record<string, unknown>;
            },
            error: (e) => {
              throw new Error(e.error.message);
            },
          },
        ),
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "extension.update",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const raw = error instanceof Error
      ? error
      : typeof error === "object" && error !== null && "message" in error
      ? (error as { message: string }).message
      : error;
    const message = sanitizeErrorForClient(raw);
    sendError(socket, requestId, "extension_update_failed", message);
  } finally {
    catalog?.close();
  }
}

export async function handleDatastoreSetupExtension(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: DatastoreSetupExtensionPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "admin",
      kindResource("model"),
      ctx,
    ).allowed
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const repoDir = ctx.repoDir;
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(RepoPath.create(repoDir));
    const deps = createDatastoreSetupDeps(repoDir, resolveConfigTierPath);

    const MAX_TIMEOUT_SECONDS = 21600;
    const syncTimeoutMsOverride = payload.timeout != null
      ? Math.min(payload.timeout, MAX_TIMEOUT_SECONDS) * 1000
      : undefined;

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      datastoreSetupExtension(libCtx, deps, {
        type: payload.type,
        config: payload.config,
        repoDir,
        repoId: marker?.repoId,
        skipMigration: payload.skipMigration ?? false,
        hydrationStrategy: payload.hydrationStrategy as
          | "full"
          | "lazy"
          | undefined,
        namespace: payload.namespace,
        syncTimeoutMsOverride,
      }),
      {
        validating: () => {},
        migrating: () => {},
        hydrating: () => {},
        warning: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "datastore.setup.extension",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const raw = error instanceof Error
      ? error
      : typeof error === "object" && error !== null && "message" in error
      ? (error as { message: string }).message
      : error;
    const message = sanitizeErrorForClient(raw);
    sendError(
      socket,
      requestId,
      "datastore_setup_extension_failed",
      message,
    );
  }
}

export async function handleVaultMigrate(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: VaultMigratePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const logger = getSwampLogger(["serve", "vault", "migrate"]);
  if (isReservedVaultName(payload.vaultName)) {
    sendError(
      socket,
      requestId,
      "forbidden",
      `Vault '${payload.vaultName}' is reserved for internal use`,
    );
    return;
  }

  // Today's check (admin on the model kind) is kept; admin on vault:<name>
  // also allows, and a deny on any of the vault's names refuses
  // (swamp-club#2676).
  if (
    !authorizeVaultOrReject(socket, requestId, principal, {
      vaultName: payload.vaultName,
      action: "admin",
      existing: kindResource("model"),
    }, ctx).allowed
  ) return;

  // The root pushes only once the success reply was sent (swamp-club#3035).
  let replied = false;
  await runInRootUnitOfWork(
    ctx.repoContext,
    {
      flush: () =>
        replied
          ? pushChangedToRemote(ctx, {
            onError: (error) =>
              logger.warn(
                "Failed to push changes to remote datastore: {error}",
                { error },
              ),
          })
          : Promise.resolve(),
    },
    async () => {
      try {
        const libCtx = handlerLibSwampContext(ctx);
        const repoDir = ctx.repoDir;
        // The shared repository's mark hook signals the config it writes and
        // the one it removes, which the scoped push then deletes remotely.
        const deps = await createVaultMigrateDeps(repoDir, {
          repo: ctx.repoContext.vaultConfigRepo,
        });

        // No trustKeySource: the client does not own this host, so a
        // local_encryption target gets the server's key source
        // (swamp-club#2690).
        await vaultMigratePreview(libCtx, deps, {
          vaultName: payload.vaultName,
          targetType: payload.targetType,
          targetConfig: payload.targetConfig,
          repoDir,
        });

        let result: Record<string, unknown> | undefined;
        await consumeStream(
          vaultMigrate(libCtx, deps, {
            vaultName: payload.vaultName,
            targetType: payload.targetType,
            targetConfig: payload.targetConfig,
            repoDir,
          }),
          {
            copying_secret: () => {},
            updating_config: () => {},
            completed: (e) => {
              result = e.data as unknown as Record<string, unknown>;
            },
            error: (e) => {
              throw new Error(e.error.message);
            },
          },
        );

        if (controller.signal.aborted) {
          sendError(socket, requestId, "cancelled", "Operation was cancelled");
          return;
        }

        send(socket, {
          type: "vault.migrate",
          id: requestId,
          payload: { data: result ?? {} },
        });
        replied = true;
      } catch (error) {
        const raw = error instanceof Error
          ? error
          : typeof error === "object" && error !== null && "message" in error
          ? (error as { message: string }).message
          : error;
        const message = sanitizeErrorForClient(raw);
        sendError(socket, requestId, "vault_migrate_failed", message);
      }
    },
  );
}

export async function handleDoctorVaults(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx).allowed
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps = await createDoctorVaultsDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      doctorVaults(libCtx, deps),
      {
        scanning: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "doctor.vaults",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "doctor_vaults_failed", message);
  }
}

export async function handleDoctorDatastores(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx).allowed
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    await datastoreTypeRegistry.ensureLoaded();
    const repoDir = ctx.repoDir;
    const deps: DoctorDatastoresDeps = {
      getDatastoreConfig: async () => {
        const markerRepo = new RepoMarkerRepository();
        const marker = await markerRepo.read(RepoPath.create(repoDir));
        return await resolveDatastoreConfig(marker, undefined, repoDir);
      },
      checkHealth: async (config) => {
        if (isCustomDatastoreConfig(config)) {
          await datastoreTypeRegistry.ensureTypeLoaded(config.type);
          const typeInfo = datastoreTypeRegistry.get(config.type);
          if (typeInfo?.createProvider) {
            const provider = typeInfo.createProvider(config.config);
            const verifier = provider.createVerifier();
            return await verifier.verify();
          }
          return {
            healthy: false,
            message: "No provider available for datastore type",
            latencyMs: 0,
          };
        } else {
          const verifier = new FilesystemDatastoreVerifier(config.path);
          return await verifier.verify();
        }
      },
      getVaultConfigs: async () => {
        const vaultRepo = ctx.repoContext.vaultConfigRepo;
        try {
          const vaultConfigs = await vaultRepo.findAll();
          return vaultConfigs.map((vc) => ({
            name: vc.name,
            type: vc.type,
          }));
        } catch {
          return [];
        }
      },
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      doctorDatastores(libCtx, deps),
      {
        scanning: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "doctor.datastores",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "doctor_datastores_failed", message);
  }
}

export async function handleDoctorSecrets(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx).allowed
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps = await createDoctorSecretsDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      doctorSecrets(libCtx, deps),
      {
        scanning: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "doctor.secrets",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "doctor_secrets_failed", message);
  }
}

export async function handleDoctorWorkflows(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx).allowed
  ) return;

  try {
    // The live repository context, so remote doctor checks the dirs this
    // server loads workflows from, including any refreshed by a reload.
    const deps: DoctorWorkflowsDeps = {
      ...doctorWorkflowDirs(ctx.repoContext),
      abortSignal: controller.signal,
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      doctorWorkflows(deps),
      {
        "workflow-checked": () => {},
        completed: (e) => {
          result = e.report as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "doctor.workflows",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "doctor_workflows_failed", message);
  }
}

export async function handleDoctorExtensions(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx).allowed
  ) return;

  const logger = getSwampLogger(["serve", "doctor", "extensions"]);
  let sharedCatalog: ExtensionCatalogStore | undefined;
  try {
    const repoDir = ctx.repoDir;
    const repoPath = RepoPath.create(repoDir);
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(repoPath);
    const { lockfilePath } = resolveManagedPathsFromContext(ctx, marker);

    const catalogDbPath = swampPath(repoDir, "_extension_catalog.db");
    sharedCatalog = new ExtensionCatalogStore(catalogDbPath);

    const localManifestIdentity = readLocalManifestIdentity(repoDir);
    let reconcileTransitions: readonly ReconcileTransition[] = [];
    try {
      const reconcileLockfileRepo = await LockfileRepository.create(
        lockfilePath,
      );
      const rescanRepo = new ExtensionRepository({
        catalog: sharedCatalog,
        lockfileRepository: reconcileLockfileRepo,
        repoRoot: repoDir,
        localManifestIdentity,
      });
      rescanRepo.invalidateAll();
      const denoRuntime = new EmbeddedDenoRuntime();
      // Same treatment of on-disk datastore extensions and the
      // transitional in-repo auto-resolve lockfile as the CLI's startup and
      // doctor reconcile (swamp-club#2483).
      const reconciler = new ReconcileFromDiskService({
        denoRuntime,
        repository: rescanRepo,
        lockfileRepository: reconcileLockfileRepo,
        repoDir,
        localManifestIdentity,
        scanOnDiskDatastores: isExtensionBackedDatastore(marker),
        additionalInstalledNames: await transitionalInstalledNames(
          repoDir,
          marker,
          lockfilePath,
        ),
      });
      const result = await reconciler.execute();
      reconcileTransitions = result.transitions;
    } catch (reconcileError) {
      logger.debug`Reconciliation failed (best-effort): ${reconcileError}`;
    }

    const registries: ReadonlyArray<DoctorRegistryDeps> = [
      {
        registry: "model",
        ensureLoaded: () => modelRegistry.ensureLoaded(),
        resetLoadedFlag: () => modelRegistry.resetLoadedFlag(),
      },
      {
        registry: "vault",
        ensureLoaded: () => vaultTypeRegistry.ensureLoaded(),
        resetLoadedFlag: () => vaultTypeRegistry.resetLoadedFlag(),
      },
      {
        registry: "datastore",
        ensureLoaded: () => datastoreTypeRegistry.ensureLoaded(),
        resetLoadedFlag: () => datastoreTypeRegistry.resetLoadedFlag(),
      },
      {
        registry: "report",
        ensureLoaded: () => reportRegistry.ensureLoaded(),
        resetLoadedFlag: () => reportRegistry.resetLoadedFlag(),
      },
      {
        registry: "webhook",
        ensureLoaded: () => webhookTypeRegistry.ensureLoaded(),
        resetLoadedFlag: () => webhookTypeRegistry.resetLoadedFlag(),
      },
    ];

    const tools = marker?.tools?.length ? marker.tools : ["claude"];
    const absoluteSkillsDirs = resolveUniqueLocalSkillsDirs(repoDir, tools);
    const repoRelativeSkillsDirs = absoluteSkillsDirs.map((d) =>
      relative(repoDir, d)
    );

    const doctorLockfileRepo = await LockfileRepository.create(lockfilePath);
    const deps: DoctorExtensionsDeps = {
      registries,
      lockfileRepository: doctorLockfileRepo,
      repoDir,
      skillsDirs: repoRelativeSkillsDirs,
      abortSignal: controller.signal,
      buildAggregateState: async () => {
        const aggLockfileRepo = await LockfileRepository.create(lockfilePath);
        const localIdentity = readLocalManifestIdentity(repoDir);
        const repo = new ExtensionRepository({
          catalog: sharedCatalog!,
          lockfileRepository: aggLockfileRepo,
          repoRoot: repoDir,
          localManifestIdentity: localIdentity,
        });
        const extensions = repo.loadAll();
        return buildAggregateState({ extensions, repoDir });
      },
      getRecentTransitions: () => reconcileTransitions,
      getWarnings: () => toDoctorWarnings(getExtensionLoadWarnings()),
      resetWarnings: resetExtensionLoadWarnings,
      ...extensionMemberDoctorDeps(sharedCatalog!),
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      doctorExtensions(deps),
      {
        "kind-started": () => {},
        "kind-completed": () => {},
        completed: (e) => {
          result = e.report as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "doctor.extensions",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "doctor_extensions_failed", message);
  } finally {
    sharedCatalog?.close();
  }
}

export function handleRunHistory(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: { active?: boolean; all?: boolean } | undefined,
  principal: Principal | null,
): void {
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "admin",
      kindResource("model"),
      ctx,
    ).allowed
  ) return;
  if (!ctx.runTracker) {
    sendError(socket, requestId, "not_available", "Run tracker not available");
    return;
  }

  const runs = payload?.active
    ? ctx.runTracker.findAllRunning()
    : payload?.all
    ? ctx.runTracker.findAll()
    : ctx.runTracker.findRecent();

  send(socket, {
    type: "run.history",
    id: requestId,
    payload: {
      runs: runs.map((r) => ({
        id: r.id,
        runKind: r.runKind,
        modelType: r.modelType,
        methodName: r.methodName,
        workflowName: r.workflowName,
        pid: r.pid,
        hostname: r.hostname,
        status: r.status,
        startedAt: r.startedAt.toISOString(),
        heartbeatAt: r.heartbeatAt.toISOString(),
        stale: r.isStale(STALE_TTL_MS),
        initiatedBy: r.initiatedBy,
      })),
    },
  });
}

export async function handleRunDoctor(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: { fix?: boolean } | undefined,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "admin",
      kindResource("model"),
      ctx,
    ).allowed
  ) return;
  if (!ctx.runTracker) {
    sendError(socket, requestId, "not_available", "Run tracker not available");
    return;
  }

  const allRuns = ctx.runTracker.findAll();
  const running = allRuns.filter((r) => r.status === "running");
  const stale = ctx.runTracker.findStaleRuns(STALE_TTL_MS);
  const active = running.filter((r) => !r.isStale(STALE_TTL_MS));

  let reaped = 0;
  if (payload?.fix && stale.length > 0) {
    const reapedRuns = ctx.runTracker.reapStaleRuns(
      STALE_TTL_MS,
      ctx.instanceId,
    );
    reaped = reapedRuns.length;
  }

  let orphanedWorkflowRuns = 0;
  let orphanedReaped = 0;
  if (ctx.controlPlaneStore && ctx.instanceId) {
    const controlPlaneStore = ctx.controlPlaneStore;
    const runTracker = ctx.runTracker;
    try {
      // The fix's saves run in a root unit of work with no push, so they
      // stage into it instead of reaching the hook through signalChange's
      // fallback (swamp-club#3056). Nothing pushes, as before.
      await runInRootUnitOfWork(
        ctx.repoContext,
        { flush: undefined },
        async () => {
          // From the records, not the index as it stands: a stale entry would
          // hide the very run being looked for (swamp-club#2518).
          await ctx.repoContext.workflowRunRepo.verifyIndexes?.();
          const yamlRuns = await ctx.repoContext.workflowRunRepo
            .findGlobalByStatus("running");

          // Each heartbeat is read once for the whole scan.
          const heartbeats = new Map<string, Promise<Uint8Array | null>>();
          const ownerGone = ownerGoneDecider({
            activeRunRegistry: ctx.activeRunRegistry,
            runTracker,
            instanceId: ctx.instanceId,
            controlPlaneStore: {
              get: (key) => {
                let read = heartbeats.get(key);
                if (!read) {
                  read = controlPlaneStore.get(key);
                  heartbeats.set(key, read);
                }
                return read;
              },
            },
          });
          for (const { run, workflowId } of yamlRuns) {
            if (!run.instanceId || run.instanceId === ctx.instanceId) continue;

            // As a cancel decides it. A missing heartbeat alone says nothing
            // where serve records none, and going by it interrupted live
            // runs of other instances (swamp-club#3059).
            if (!(await ownerGone(run)).gone) continue;

            orphanedWorkflowRuns++;
            if (payload?.fix) {
              run.interruptOrphaned("doctor_reap");
              await ctx.repoContext.workflowRunRepo.save(workflowId, run);
              runTracker.markSettled(run.id, "doctor_reap");
              orphanedReaped++;
            }
          }
        },
      );
    } catch (err: unknown) {
      getSwampLogger(["serve", "run-doctor"]).warn(
        "Failed to scan YAML workflow runs: {error}",
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  if (payload?.fix) {
    // Rows this or another reap left interrupted while their record is no
    // longer running; serve-only deployments have no other sweep
    // (swamp-club#2917).
    try {
      await settleInterruptedWorkflowRows(
        ctx.runTracker,
        runRecordFinder(
          ctx.repoContext.workflowRunRepo,
          ctx.repoContext.workflowRepo,
        ),
      );
    } catch (err: unknown) {
      getSwampLogger(["serve", "run-doctor"]).warn(
        "Failed to settle interrupted workflow run rows: {error}",
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  const mapRun = (r: ActiveRun) => ({
    id: r.id,
    runKind: r.runKind,
    modelType: r.modelType,
    methodName: r.methodName,
    workflowName: r.workflowName,
    pid: r.pid,
    hostname: r.hostname,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    heartbeatAt: r.heartbeatAt.toISOString(),
    stale: r.isStale(STALE_TTL_MS),
    initiatedBy: r.initiatedBy,
  });

  send(socket, {
    type: "run.doctor",
    id: requestId,
    payload: {
      totalTracked: allRuns.length,
      active: active.length,
      stale: stale.length,
      reaped,
      orphanedWorkflowRuns,
      orphanedReaped,
      activeRuns: active.map(mapRun),
      staleRuns: stale.map(mapRun),
    },
  });
}

export async function handleAuditTimeline(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: AuditTimelinePayload,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "audit",
      fields: {},
    }, ctx).allowed
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps = createAuditTimelineDeps(ctx.repoDir);

    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(RepoPath.create(ctx.repoDir));
    const configuredTool = resolvePrimaryTool(marker);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      auditTimeline(libCtx, deps, {
        hours: payload?.hours ?? 24,
        showAll: payload?.showAll ?? false,
        sessionId: payload?.sessionId,
        tool: configuredTool,
        includeDiagnostic: payload?.includeDiagnostic ?? false,
      }),
      {
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "audit.timeline",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "audit_timeline_failed", message);
  }
}

let auditReloadInProgress = false;

export async function handleServeReload(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx).allowed
  ) return;

  if (!ctx.hotReload) {
    sendError(
      socket,
      requestId,
      "hot_reload_disabled",
      "Extension reload is not available — the server was not started with --hot-reload",
    );
    return;
  }

  const logger = getSwampLogger(["serve", "reload"]);
  const who = principal ? `${principal.kind}:${principal.id}` : "anonymous";
  logger.info`Extension reload requested by ${who}`;

  try {
    const lockfilePath = await resolveLockfilePath(
      ctx.repoDir,
      ctx.datastoreResolver,
    );
    const reloadOptions: ServeReloadOptions = {
      triggerOverrideUpdater: ctx.scheduledExecution
        ? (overrides: ReadonlyMap<string, TriggerOverride>) =>
          ctx.scheduledExecution!.updateTriggerOverrides(overrides)
        : undefined,
      workflowReloader: ctx.workflowReloader,
      webhookUpdater: ctx.webhookUpdater,
      configPath: ctx.serveConfigPath,
    };
    const result = await performServeReload(
      ctx.repoDir,
      lockfilePath,
      reloadOptions,
    );

    if (result.success) {
      logger
        .info`Extension reload completed: ${result.reloadedCount} type(s) reloaded (requested by ${who})`;
      if (result.workflowsReloaded && result.workflowsReloaded > 0) {
        logger.info(
          "Refreshed {count} extension workflow dir(s) (requested by {who})",
          { count: result.workflowsReloaded, who },
        );
      }
      if (
        result.triggerOverridesChanged &&
        result.triggerOverridesChanged > 0
      ) {
        logger.info(
          "Reloaded {count} trigger override(s) from serve.yaml (requested by {who})",
          { count: result.triggerOverridesChanged, who },
        );
      }
      if (
        result.webhooksReloaded &&
        result.webhooksReloaded > 0
      ) {
        logger.info(
          "Reloaded {count} webhook route(s) from serve.yaml (requested by {who})",
          { count: result.webhooksReloaded, who },
        );
      }

      if (ctx.auditEmitter && ctx.auditSinkRebuilder) {
        if (auditReloadInProgress) {
          logger.warn(
            "Audit sink reload already in progress, skipping (requested by {who})",
            { who },
          );
        } else {
          auditReloadInProgress = true;
          try {
            const newSinks = await ctx.auditSinkRebuilder();
            ctx.auditEmitter.replaceSinks(newSinks);
            logger.info(
              "Audit sinks reloaded: {count} sink(s) (requested by {who})",
              { count: newSinks.length, who },
            );
          } catch (error: unknown) {
            logger.warn(
              "Audit sink hot-reload failed, keeping existing sinks: {error}",
              {
                error: error instanceof Error ? error.message : String(error),
              },
            );
          } finally {
            auditReloadInProgress = false;
          }
        }
      }
    }

    send(socket, {
      type: "serve.reload",
      id: requestId,
      payload: result,
    });
  } catch (error) {
    logger.error`Extension reload failed (requested by ${who}): ${error}`;
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "serve_reload_failed", message);
  }
}

export async function handleWorkerTokenCreate(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkerTokenCreatePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx).allowed
  ) return;

  await runInRootUnitOfWork(
    ctx.repoContext,
    { flush: () => pushChangedToRemote(ctx) },
    async () => {
      try {
        const libCtx = handlerLibSwampContext(ctx);
        const deps = await createWorkerTokenCreateDeps(
          libCtx,
          ctx.repoDir,
          ctx.repoContext,
          { vaultsDir: ctx.vaultsDir },
        );

        let result: Record<string, unknown> | undefined;
        await consumeStream(
          workerTokenCreate(libCtx, deps, {
            name: payload.name,
            durationMs: payload.durationMs,
            // An explicit --vault wins: redeem reads the secret from the vault
            // recorded on the token, so any configured vault works. Without
            // one, use the control-plane vault, as the local CLI path does.
            // Leaving it unset makes resolveVaultName count _token-secrets
            // alongside any user vault and fail with "Multiple vaults are
            // configured".
            vaultName: payload.vaultName ?? TOKEN_SECRETS_VAULT_NAME,
            maxEnrollments: payload.maxEnrollments,
          }),
          withDefaults({
            completed: (e) => {
              result = e.data as unknown as Record<string, unknown>;
            },
            error: (e) => {
              throw new Error(e.error.message);
            },
          }),
        );

        if (controller.signal.aborted) {
          sendError(socket, requestId, "cancelled", "Operation was cancelled");
          return;
        }

        send(socket, {
          type: "worker.token.create",
          id: requestId,
          payload: { data: result ?? {} },
        });
      } catch (error) {
        const message = sanitizeErrorForClient(error);
        sendError(socket, requestId, "worker_token_create_failed", message);
      }
    },
  );
}

export async function handleWorkerTokenList(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx).allowed
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps = createWorkerListDeps(
      ctx.repoContext.dataQueryService,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workerTokenList(libCtx, deps),
      withDefaults({
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      }),
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "worker.token.list",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "worker_token_list_failed", message);
  }
}

export async function handleWorkerTokenRevoke(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkerTokenRevokePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx).allowed
  ) return;

  await runInRootUnitOfWork(
    ctx.repoContext,
    { flush: () => pushChangedToRemote(ctx) },
    async () => {
      try {
        const libCtx = handlerLibSwampContext(ctx);
        const deps = await createWorkerTokenRevokeDeps(
          libCtx,
          ctx.repoDir,
          ctx.repoContext,
          { vaultsDir: ctx.vaultsDir },
        );

        let result: Record<string, unknown> | undefined;
        await consumeStream(
          workerTokenRevoke(libCtx, deps, { name: payload.name }),
          withDefaults({
            completed: (e) => {
              result = e.data as unknown as Record<string, unknown>;
            },
            error: (e) => {
              throw new Error(e.error.message);
            },
          }),
        );

        // The revoke is persisted even if the request was cancelled, and an
        // already-revoked token may still hold workers this instance missed, so
        // every worker enrolled on any mint of the name is cut off now.
        const disconnectedWorkers = await ctx.workerGateway?.revokeToken(
          payload.name,
          "revoked",
        );

        if (controller.signal.aborted) {
          sendError(socket, requestId, "cancelled", "Operation was cancelled");
          return;
        }

        send(socket, {
          type: "worker.token.revoke",
          id: requestId,
          payload: {
            data: disconnectedWorkers === undefined
              ? result ?? {}
              : { ...result, disconnectedWorkers },
          },
        });
      } catch (error) {
        const message = sanitizeErrorForClient(error);
        sendError(socket, requestId, "worker_token_revoke_failed", message);
      }
    },
  );
}

export async function handleWorkerPrune(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkerPrunePayload | undefined,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx).allowed
  ) return;

  await runInRootUnitOfWork(
    ctx.repoContext,
    { flush: () => pushChangedToRemote(ctx) },
    async () => {
      try {
        const libCtx = handlerLibSwampContext(ctx);
        const gracePeriodMs = payload?.gracePeriodMs ??
          DEFAULT_WORKER_GC_GRACE_PERIOD_MS;
        const dryRun = payload?.dryRun ?? false;

        const listDeps = createWorkerListDeps(ctx.repoContext.dataQueryService);

        const runDeps = await createWorkerModelRunDeps(
          ctx.repoDir,
          ctx.repoContext,
          { vaultsDir: ctx.vaultsDir },
        );

        const deleteDeps = createModelDeleteDeps(
          ctx.repoDir,
          ctx.datastoreResolver,
          undefined,
          ctx.repoContext.markDirty,
          ctx.repoContext.definitionRepo,
        );

        const pruneDeps: WorkerPruneDeps = {
          listWorkers: async () => {
            const records = await ctx.repoContext.dataQueryService.query(
              `modelType == "${WORKER_MODEL_TYPE.normalized}" && name == "state-main"`,
              { loadAttributes: true },
            ) as DataRecord[];
            return records.flatMap((r) => {
              const parsed = WorkerStateSchema.safeParse(r.attributes);
              if (!parsed.success) return [];
              const s = parsed.data;
              return [{
                name: s.name,
                definitionName: `worker-${s.name}`,
                status: s.status,
                tokenName: s.tokenName,
                disconnectedAt: s.disconnectedAt,
              }];
            });
          },

          listTokens: async () => {
            const tokens: WorkerPruneDeps extends
              { listTokens(): Promise<infer R> } ? R
              : never = [];
            await consumeStream(
              workerTokenList(libCtx, listDeps),
              withDefaults({
                completed: (
                  e: {
                    data: {
                      tokens: Array<
                        { name: string; bindings: Array<{ machineId: string }> }
                      >;
                    };
                  },
                ) => {
                  for (const t of e.data.tokens) {
                    tokens.push({ name: t.name, bindings: t.bindings });
                  }
                },
              }),
            );
            return tokens;
          },

          deleteWorker: (definitionName) =>
            modelDelete(libCtx, deleteDeps, {
              modelIdOrName: definitionName,
              force: true,
            }),

          // Control-plane bookkeeping: never held to a run's vault scope
          // (swamp-club#2676).
          pruneBindings: (tokenName, machineIds) =>
            runGeneratorWithoutVaultAccess(() =>
              modelMethodRun(libCtx, runDeps, {
                modelIdOrName: tokenName,
                methodName: "prune_bindings",
                inputs: { machineIds },
                lastEvaluated: false,
              })
            ),

          resolveStaleBindings: async (token, remainingWorkerNames) => {
            const remaining = new Set(remainingWorkerNames);
            const stale: string[] = [];
            for (const binding of token.bindings) {
              const suffix = await fleetMemberSuffix(binding.machineId);
              const expectedName = `${token.name}-${suffix}`;
              if (
                !remaining.has(expectedName) && !remaining.has(token.name)
              ) {
                stale.push(binding.machineId);
              }
            }
            return stale.length > 0 ? stale : null;
          },
        };

        let result: Record<string, unknown> | undefined;
        let preview: unknown[] | undefined;
        await consumeStream(
          workerPrune(libCtx, pruneDeps, { gracePeriodMs, dryRun }),
          withDefaults({
            previewing: (e: { workers: unknown[] }) => {
              preview = e.workers;
            },
            completed: (e: { result: unknown }) => {
              result = e.result as Record<string, unknown>;
            },
            error: (e: { error: { message: string } }) => {
              throw new Error(e.error.message);
            },
          }),
        );
        if (dryRun && preview) {
          result = { ...result, prunable: preview };
        }

        if (controller.signal.aborted) {
          sendError(socket, requestId, "cancelled", "Operation was cancelled");
          return;
        }

        send(socket, {
          type: "worker.prune",
          id: requestId,
          payload: { data: result ?? {} },
        });
      } catch (error) {
        const message = sanitizeErrorForClient(error);
        sendError(socket, requestId, "worker_prune_failed", message);
      }
    },
  );
}

export async function handleDatastoreNamespaceList(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "read",
      kindResource("data"),
      ctx,
    ).allowed
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const dsBasePath = datastoreBasePath(ctx.datastoreConfig);

    let listProvider: DatastoreProvider | undefined;
    if (isCustomDatastoreConfig(ctx.datastoreConfig)) {
      await datastoreTypeRegistry.ensureLoaded();
      await datastoreTypeRegistry.ensureTypeLoaded(ctx.datastoreConfig.type);
      const typeInfo = datastoreTypeRegistry.get(ctx.datastoreConfig.type);
      listProvider = typeInfo?.createProvider?.(ctx.datastoreConfig.config);
    }

    const deps = {
      getCurrentNamespace: () => ctx.datastoreConfig.namespace,
      listNamespaces: async () => {
        if (listProvider?.listNamespaces) {
          const slugs = await listProvider.listNamespaces(
            (ctx.datastoreConfig as CustomDatastoreConfig).datastorePath,
          );
          return slugs.map((ns: string) => ({
            namespace: ns,
            repoId: "",
            registeredAt: "",
          }));
        }
        return await listNamespaceManifests(dsBasePath);
      },
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      datastoreNamespaceList(libCtx, deps),
      {
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "datastore.namespace.list",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "datastore_namespace_list_failed", message);
  }
}

export interface CollectClusterInstancesOptions {
  controlPlaneStore?:
    import("../../domain/datastore/control_plane_store.ts").ControlPlaneStore;
  healthCollector?: import("../health_collector.ts").HealthCollector;
  instanceId?: string;
  staleTtlMs?: number;
  serveOptions?: MergedServeOptions;
  signal: AbortSignal;
}

export async function collectClusterInstances(
  opts: CollectClusterInstancesOptions,
): Promise<Record<string, unknown>[]> {
  const instances: Record<string, unknown>[] = [];
  const staleTtlMs = opts.staleTtlMs ?? DEFAULT_STALE_TTL_MS;
  const degradedThresholdMs = staleTtlMs * 2 / 3;

  if (opts.controlPlaneStore) {
    const keys = await opts.controlPlaneStore.list("heartbeats/");
    for (const key of keys) {
      if (opts.signal.aborted) break;
      const data = await opts.controlPlaneStore.get(key);
      if (!data) continue;
      const record = InstanceHeartbeatService.parseRecord(data);
      if (!record) continue;

      const isLocal = record.instanceId === opts.instanceId;
      const age = Date.now() - new Date(record.heartbeatAt).getTime();
      let status: string;
      if (isNaN(age)) {
        status = "unreachable";
      } else if (age <= degradedThresholdMs) {
        status = "healthy";
      } else if (age <= staleTtlMs) {
        status = "degraded";
      } else {
        status = "unreachable";
      }

      const entry: Record<string, unknown> = {
        instanceId: record.instanceId,
        hostname: record.hostname,
        pid: record.pid,
        startedAt: record.startedAt,
        lastHeartbeatAt: record.heartbeatAt,
        status,
        address: record.address ?? null,
      };

      if (isLocal && opts.healthCollector) {
        const snapshot = await opts.healthCollector.collect(opts.signal);
        entry.health = snapshot;
      }

      instances.push(entry);
    }
  }

  if (instances.length === 0 && opts.instanceId) {
    let address: string | null = null;
    if (opts.serveOptions) {
      const scheme = opts.serveOptions.certFile !== undefined &&
          opts.serveOptions.keyFile !== undefined
        ? "https"
        : "http";
      address =
        `${scheme}://${opts.serveOptions.host}:${opts.serveOptions.port}`;
    }

    const entry: Record<string, unknown> = {
      instanceId: opts.instanceId,
      hostname: Deno.hostname(),
      pid: Deno.pid,
      startedAt: null,
      lastHeartbeatAt: null,
      status: "healthy",
      address,
    };

    if (opts.healthCollector) {
      const snapshot = await opts.healthCollector.collect(opts.signal);
      entry.health = snapshot;
    }

    instances.push(entry);
  }

  return instances;
}

export async function handleClusterInstances(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx).allowed
  ) return;

  try {
    const instances = await collectClusterInstances({
      controlPlaneStore: ctx.controlPlaneStore,
      healthCollector: ctx.healthCollector,
      instanceId: ctx.instanceId,
      staleTtlMs: ctx.staleTtlMs,
      serveOptions: ctx.serveOptions,
      signal: controller.signal,
    });

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "cluster.instances",
      id: requestId,
      payload: { instances },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "cluster_instances_failed", message);
  }
}

export function redactServeOptions(
  opts: MergedServeOptions,
): Record<string, unknown> {
  return {
    port: opts.port,
    host: opts.host,
    tls: {
      enabled: opts.certFile !== undefined && opts.keyFile !== undefined,
      certFile: opts.certFile ?? null,
    },
    authMode: opts.authMode,
    scheduling: { enabled: opts.schedule },
    dashboard: { enabled: opts.dashboard },
    webhooks: (opts.webhookConfigs ?? []).map((wh) => ({
      route: wh.route,
      workflow: wh.workflow,
      scheme: wh.scheme ?? "github",
    })),
    maxConcurrentRuns: opts.maxConcurrentRuns ?? null,
    maxRunsPerPrincipal: opts.maxRunsPerPrincipal ?? null,
    maxRunDuration: opts.maxRunDuration ?? null,
    enableInternalApi: opts.enableInternalApi,
    detachRuns: opts.detachRuns,
    hotReload: opts.hotReload,
    remoteOnly: opts.remoteOnly,
    autoResume: opts.autoResume,
    trustProxy: opts.trustProxy,
    verifyOnEnroll: opts.verifyOnEnroll,
  };
}

export function handleServeConfig(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  principal: Principal | null,
): void {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx).allowed
  ) return;

  if (!ctx.serveOptions) {
    sendError(
      socket,
      requestId,
      "not_available",
      "Serve configuration not available",
    );
    return;
  }

  send(socket, {
    type: "serve.config",
    id: requestId,
    payload: { config: redactServeOptions(ctx.serveOptions) },
  });
}
