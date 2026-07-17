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

import { isAbsolute, join, relative, resolve } from "@std/path";
import {
  type ActiveRun,
  STALE_TTL_MS,
} from "../../domain/models/active_run.ts";
import {
  auditTimeline,
  buildAggregateState,
  consumeStream,
  createAuditTimelineDeps,
  createDatastoreStatusDeps,
  createDoctorSecretsDeps,
  createDoctorVaultsDeps,
  createExtensionInfoDeps,
  createExtensionListDeps,
  createExtensionRmDeps,
  createExtensionUpdateDeps,
  createLibSwampContext,
  createWorkerListDeps,
  createWorkerQueueListDeps,
  datastoreStatus,
  doctorDatastores,
  type DoctorDatastoresDeps,
  doctorExtensions,
  type DoctorExtensionsDeps,
  type DoctorRegistryDeps,
  doctorSecrets,
  doctorVaults,
  doctorWorkflows,
  type DoctorWorkflowsDeps,
  extensionInfo,
  extensionInstall,
  extensionList,
  extensionRm,
  extensionSearch,
  type ExtensionSearchDeps,
  extensionUpdate,
  LockfileRepository,
  ReconcileFromDiskService,
  type ReconcileTransition,
  resolveServerUrl,
  workerList,
  workerQueueList,
} from "../../libswamp/mod.ts";
import {
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import { FilesystemDatastoreVerifier } from "../../infrastructure/persistence/filesystem_datastore_verifier.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import { resolveDatastoreConfig } from "../../cli/resolve_datastore.ts";
import { createExtensionInstallDeps } from "../../cli/create_extension_install_deps.ts";
import { resolveModelsDir } from "../../cli/resolve_models_dir.ts";
import type {
  AuditTimelinePayload,
  ExtensionInfoPayload,
  ExtensionRmPayload,
  ExtensionSearchPayload,
  WorkerListPayload,
  WorkerProbeResult,
  WorkerVerifyPayload,
} from "../protocol.ts";
import { dispatchFleetProbe } from "../fleet_probe_dispatch.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { ExtensionApiClient } from "../../infrastructure/http/extension_api_client.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import { readLocalManifestIdentity } from "../../infrastructure/persistence/local_manifest_reader.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { EmbeddedDenoRuntime } from "../../infrastructure/runtime/embedded_deno_runtime.ts";
import {
  getExtensionLoadWarnings,
  resetExtensionLoadWarnings,
} from "../../infrastructure/logging/extension_load_warnings.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { resolvePrimaryTool } from "../../domain/repo/primary_tool.ts";
import { resolveUniqueLocalSkillsDirs } from "../../domain/repo/skill_dirs.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import type { Principal } from "../../domain/access/principal.ts";
import {
  authorizeOrReject,
  type ConnectionContext,
  sanitizeErrorForClient,
  send,
  sendError,
} from "./shared.ts";

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
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
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
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
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
    }, ctx)
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
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
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
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = await createExtensionListDeps(ctx.repoDir);

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
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const serverUrl = resolveServerUrl();
    const client = new ExtensionApiClient(serverUrl);
    const deps: ExtensionSearchDeps = {
      searchExtensions: (params) =>
        client.searchExtensions(
          params as Parameters<typeof client.searchExtensions>[0],
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
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    // TODO: createExtensionInfoDeps takes apiKey/identity for the
    // swamp-club API. Pass undefined for now until auth forwarding is
    // wired through the serve layer.
    const deps = createExtensionInfoDeps();

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
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const logger = getSwampLogger(["serve", "extension", "install"]);
    const deps = await createExtensionInstallDeps(ctx.repoDir, logger);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
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

export async function handleExtensionRm(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ExtensionRmPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  let deps: Awaited<ReturnType<typeof createExtensionRmDeps>> | undefined;
  try {
    const repoDir = ctx.repoDir;
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(RepoPath.create(repoDir));
    const modelsDir = resolveModelsDir(marker);
    const absoluteModelsDir = isAbsolute(modelsDir)
      ? modelsDir
      : resolve(repoDir, modelsDir);
    const lockfilePath = join(absoluteModelsDir, "upstream_extensions.json");

    deps = await createExtensionRmDeps(repoDir, lockfilePath);
    const libCtx = createLibSwampContext();

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      extensionRm(libCtx, deps, { extensionName: payload.extensionName }),
      {
        deleting: () => {},
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
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const repoDir = ctx.repoDir;
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(RepoPath.create(repoDir));
    const modelsDir = resolveModelsDir(marker);
    const absoluteModelsDir = isAbsolute(modelsDir)
      ? modelsDir
      : resolve(repoDir, modelsDir);
    const lockfilePath = join(absoluteModelsDir, "upstream_extensions.json");

    const deps = await createExtensionUpdateDeps({
      lockfilePath,
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
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
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
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
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
        const vaultRepo = new YamlVaultConfigRepository(repoDir);
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
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
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
    }, ctx)
  ) return;

  try {
    const workflowsDir = swampPath(ctx.repoDir, SWAMP_SUBDIRS.workflows);

    const deps: DoctorWorkflowsDeps = {
      workflowDirs: [workflowsDir],
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
    }, ctx)
  ) return;

  const logger = getSwampLogger(["serve", "doctor", "extensions"]);
  let sharedCatalog: ExtensionCatalogStore | undefined;
  try {
    const repoDir = ctx.repoDir;
    const repoPath = RepoPath.create(repoDir);
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(repoPath);
    const modelsDir = resolveModelsDir(marker);
    const absoluteModelsDir = isAbsolute(modelsDir)
      ? modelsDir
      : resolve(repoDir, modelsDir);
    const lockfilePath = join(absoluteModelsDir, "upstream_extensions.json");

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
      const reconciler = new ReconcileFromDiskService({
        denoRuntime,
        repository: rescanRepo,
        lockfileRepository: reconcileLockfileRepo,
        repoDir,
        localManifestIdentity,
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
      getWarnings: () =>
        getExtensionLoadWarnings().map((w) => ({
          sourcePath: w.file,
          category: "TypeExtractionFailed",
          message: w.error,
        })),
      resetWarnings: resetExtensionLoadWarnings,
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
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
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
      })),
    },
  });
}

export function handleRunDoctor(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: { fix?: boolean } | undefined,
  principal: Principal | null,
): void {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
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
    const reapedRuns = ctx.runTracker.reapStaleRuns(STALE_TTL_MS);
    reaped = reapedRuns.length;
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
  });

  send(socket, {
    type: "run.doctor",
    id: requestId,
    payload: {
      totalTracked: allRuns.length,
      active: active.length,
      stale: stale.length,
      reaped,
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
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
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
