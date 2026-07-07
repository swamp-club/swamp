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

import {
  type ActiveRun,
  STALE_TTL_MS,
} from "../../domain/models/active_run.ts";
import {
  auditTimeline,
  consumeStream,
  createAuditTimelineDeps,
  createDoctorSecretsDeps,
  createDoctorVaultsDeps,
  createExtensionInfoDeps,
  createExtensionListDeps,
  createLibSwampContext,
  createWorkerListDeps,
  createWorkerQueueListDeps,
  doctorSecrets,
  doctorVaults,
  doctorWorkflows,
  type DoctorWorkflowsDeps,
  extensionInfo,
  extensionList,
  workerList,
  workerQueueList,
} from "../../libswamp/mod.ts";
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
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { resolvePrimaryTool } from "../../domain/repo/primary_tool.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
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

export function handleDatastoreStatus(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  _controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx)
  ) return Promise.resolve();

  // TODO: datastoreStatus requires a DatastorePathResolver which the
  // ConnectionContext does not currently expose. Send a minimal status
  // response until the resolver is wired through.
  sendError(
    socket,
    requestId,
    "not_implemented",
    "datastore.status is not yet available over the WebSocket API",
  );
  return Promise.resolve();
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

// deno-lint-ignore require-await
export async function handleExtensionSearch(
  socket: WebSocket,
  _ctx: ConnectionContext,
  requestId: string,
  _controller: AbortController,
  _principal: Principal | null,
  _payload?: ExtensionSearchPayload,
): Promise<void> {
  sendError(
    socket,
    requestId,
    "not_implemented",
    "extension.search is not yet available over the WebSocket API",
  );
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

export function handleExtensionInstall(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  _controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
  ) return Promise.resolve();

  // TODO: ExtensionInstallDeps requires complex infrastructure wiring
  // (lockfilePath, createInstallContext, etc.) that is not yet available
  // in the serve context. Return not_implemented until wired.
  sendError(
    socket,
    requestId,
    "not_implemented",
    "extension.install is not yet available over the WebSocket API",
  );
  return Promise.resolve();
}

export function handleExtensionRm(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  _payload: ExtensionRmPayload,
  _controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
  ) return Promise.resolve();

  // TODO: createExtensionRmDeps requires a lockfilePath resolved from
  // the repo marker. Wire this through ConnectionContext.
  sendError(
    socket,
    requestId,
    "not_implemented",
    "extension.rm is not yet available over the WebSocket API",
  );
  return Promise.resolve();
}

export function handleExtensionOutdated(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  _controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
  ) return Promise.resolve();

  // TODO: extensionOutdated wraps extensionUpdate with checkOnly=true.
  // It requires a lockfilePath and identity for the swamp-club API.
  // Wire these through ConnectionContext.
  sendError(
    socket,
    requestId,
    "not_implemented",
    "extension.outdated is not yet available over the WebSocket API",
  );
  return Promise.resolve();
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

export function handleDoctorExtensions(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  _controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx)
  ) return Promise.resolve();

  // TODO: DoctorExtensionsDeps requires complex infrastructure wiring
  // (registries, lockfileRepository, skillsDir, etc.) that is not yet
  // available in the serve context. Return not_implemented until wired.
  sendError(
    socket,
    requestId,
    "not_implemented",
    "doctor.extensions is not yet available over the WebSocket API",
  );
  return Promise.resolve();
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
