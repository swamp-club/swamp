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
 * Data-domain request handlers (data.* and summarise verbs).
 */

import {
  consumeStream,
  createDataDeleteDeps,
  createDataGcDeps,
  createDataGetDeps,
  createDataListDeps,
  createDataPruneDeps,
  createDataRenameDeps,
  createDataVersionsDeps,
  createLibSwampContext,
  createRunGcDeps,
  createSummariseDeps,
  dataDelete,
  dataGc,
  dataGet,
  type DataGetDeps,
  dataList,
  type DataOwnerInfo,
  dataPrune,
  dataQuery,
  type DataQueryDeps,
  type DataRecord,
  dataRename,
  dataSearch,
  type DataSearchDeps,
  dataVersions,
  DEFAULT_OUTPUT_RETENTION_DAYS,
  DEFAULT_WORKFLOW_RUN_RETENTION_DAYS,
  parseDuration,
  resolveWorkflowData,
  runGc,
  type RunGcGarbageCollectionPolicy,
  type RunGcInput,
  runGcRetentionFromPolicy,
  summarise,
  validationFailed,
  type WorkflowDataPin,
  workflowsDirFor,
} from "../../libswamp/mod.ts";
import type {
  DataDeletePayload,
  DataGcPayload,
  DataGetPayload,
  DataListPayload,
  DataPrunePayload,
  DataQueryPayload,
  DataRenamePayload,
  DataSearchPayload,
  DataVersionsPayload,
  RunGcPayload,
  SummarisePayload,
} from "../protocol.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { findLatestItemsFromCatalog } from "../../infrastructure/persistence/catalog_search_adapter.ts";
import type { Principal } from "../../domain/access/principal.ts";
import {
  authorizeAllOrReject,
  authorizeAnyOrReject,
  authorizeOrReject,
  clientErrorDetails,
  type ConnectionContext,
  DEFAULT_QUERY_LIMIT,
  filterByResources,
  isAuthorized,
  LibSwampStreamError,
  MAX_QUERY_RESULTS,
  pushChangedToRemote,
  recordAuditedResource,
  resourceDecider,
  sanitizeErrorForClient,
  send,
  sendError,
} from "./shared.ts";
import {
  authorizeResolved,
  canonicalResources,
  type RecordedOwner,
  resolveModelTarget,
  resolveWorkflowTarget,
  targetArgument,
  unresolvedAccessResource,
} from "./resource_resolution.ts";
import type { AccessResource } from "../../domain/access/access_decision_service.ts";
import type { LatestWorkflowRunResolver } from "../../domain/data/data_query_service.ts";
import { latestRunForWorkflow } from "../../domain/workflows/workflow_lookup.ts";
import { UserError } from "../../domain/errors.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";

export function resolveRunGcInput(
  payload: RunGcPayload | undefined,
  policy?: RunGcGarbageCollectionPolicy,
): RunGcInput {
  const configuredRetention = runGcRetentionFromPolicy(policy);
  const workflowRunRetentionDays = payload?.workflowRunRetentionDays ??
    configuredRetention.workflowRunRetentionDays ??
    DEFAULT_WORKFLOW_RUN_RETENTION_DAYS;

  return {
    dryRun: payload?.dryRun ?? false,
    workflowRunRetentionDays,
    outputRetentionDays: payload?.outputRetentionDays ??
      configuredRetention.outputRetentionDays ?? DEFAULT_OUTPUT_RETENTION_DAYS,
  };
}

export async function handleDataGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: DataGetPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  // A model-scoped read resolves its model first and authorizes the model's
  // canonical name (swamp-club#2674). A workflow-scoped read authorizes the
  // workflow, then every owner of the item it will return, and reads exactly
  // that item (swamp-club#2603).
  let model:
    | { idOrName: string; byId: boolean; expectedName?: string }
    | undefined;
  if (!payload.workflowName && !payload.modelIdOrName) {
    // Neither: libswamp reports the missing argument. An empty name reads as
    // absent, exactly as libswamp reads it.
    if (
      !authorizeAnyOrReject(socket, requestId, principal, "read", "data", ctx)
    ) return;
  } else if (!payload.workflowName) {
    const modelIdOrName = payload.modelIdOrName!;
    const target = await resolveModelTarget(
      ctx.repoContext.definitionRepo,
      modelIdOrName,
      "data",
    );
    if (
      !authorizeResolved(
        socket,
        requestId,
        principal,
        "read",
        target,
        modelIdOrName,
        "data",
        ctx,
        "data_get_failed",
      )
    ) return;
    model = targetArgument(target, modelIdOrName);
  }

  try {
    const libCtx = createLibSwampContext();
    const deps = createDataGetDeps(
      ctx.repoDir,
      ctx.datastoreResolver,
      ctx.repoContext.unifiedDataRepo,
      ctx.repoContext.workflowRepo,
      ctx.repoContext.definitionRepo,
    );

    let expectedOwner: WorkflowDataPin | undefined;
    if (payload.workflowName) {
      const pinned = await authorizeWorkflowData(
        socket,
        ctx,
        requestId,
        payload,
        deps,
        principal,
      );
      if (!pinned) return;
      expectedOwner = pinned;
    }

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      dataGet(libCtx, deps, {
        modelIdOrName: model?.idOrName ?? payload.modelIdOrName,
        byId: model?.byId,
        expectedName: model?.expectedName,
        dataName: payload.dataName,
        workflowName: payload.workflowName,
        runId: payload.runId,
        version: payload.version,
        includeContent: payload.includeContent ?? true,
        repoDir: ctx.repoDir,
        expectedOwner,
        canReadOwner: ownerReadCheck(socket, ctx, principal),
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new LibSwampStreamError(e.error);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Data not found");
      return;
    }

    send(socket, {
      type: "data.get",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(
      socket,
      requestId,
      "data_get_failed",
      message,
      clientErrorDetails(error),
    );
  }
}

/**
 * A silent check of whether the principal may read data owned by a model, by
 * the rules data.list filters items with, so a read's warnings never name a
 * producer the caller could not list.
 */
function ownerReadCheck(
  socket: WebSocket,
  ctx: ConnectionContext,
  principal: Principal | null,
): (owner: DataOwnerInfo) => Promise<boolean> {
  if (ctx.authConfig.mode === "none") return () => Promise.resolve(true);
  const canonical = canonicalResources(ctx);
  const readable = resourceDecider(socket, principal, "read", ctx);
  return async (owner) => {
    const resources = await canonical.dataOwners(owner);
    return resources.length > 0 && resources.every(readable);
  };
}

/**
 * Authorizes a workflow-scoped data read and returns the item to pin it to,
 * or null when the request was replied to. The workflow is resolved and its
 * `read` authorized before any run is looked up, so a run-not-found, a
 * pending run or a run id reaches only a caller who may read that workflow's
 * history; then `data` read is authorized on every owner of the item the
 * read will return (swamp-club#2603).
 */
async function authorizeWorkflowData(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: DataGetPayload,
  deps: DataGetDeps,
  principal: Principal | null,
): Promise<WorkflowDataPin | null> {
  const workflowName = payload.workflowName!;
  const target = await resolveWorkflowTarget(
    ctx.repoContext.workflowRepo,
    workflowName,
    workflowsDirFor(ctx.repoDir),
  );
  if (
    !authorizeResolved(
      socket,
      requestId,
      principal,
      "read",
      target,
      workflowName,
      "workflow",
      ctx,
      "data_get_failed",
    )
  ) return null;
  const workflow = targetArgument(target, workflowName);

  const dataName = payload.modelIdOrName || payload.dataName;
  if (!dataName) {
    throw new LibSwampStreamError(
      validationFailed(
        "A data name is required when using --workflow. Usage: swamp data get --workflow <name> <data_name>",
      ),
    );
  }
  const located = await resolveWorkflowData(deps, {
    workflowId: workflow.idOrName,
    workflowName: workflow.expectedName,
    runId: payload.runId,
    dataName,
    version: payload.version,
  });
  if (located.kind === "error") throw new LibSwampStreamError(located.error);
  const { workflow: found, run, item } = located.location;

  const owners = await canonicalResources(ctx).dataOwners({
    modelType: item.modelType.normalized,
    modelId: item.modelId,
    modelName: item.modelName,
  });
  for (const owner of owners) {
    if (
      !authorizeOrReject(socket, requestId, principal, "read", owner, ctx)
        .allowed
    ) return null;
  }
  // Audited as the data read — its owners — not the workflow asked for.
  recordAuditedResource(
    socket,
    requestId,
    "data",
    owners.map((owner) => owner.name).join(", "),
    ctx,
  );
  return {
    workflowId: found.id,
    workflowName: found.name,
    runId: run.id,
    modelType: item.modelType.normalized,
    modelId: item.modelId,
    version: item.data.version,
  };
}

/**
 * Resolves `latestRun("<workflow>")` for a data query over serve with the
 * checks a workflow history read of the latest run makes: `read` on the
 * workflow, then on every workflow the run is recorded under — a copy
 * shares its original's id and runs (swamp-club#2957). The run is looked up
 * by the resolved id, so it belongs to the workflow that was authorized. A
 * refusal is audited but never replied; it, an unknown workflow and a file
 * that does not parse all fail as one not-found naming only the argument,
 * so the error says nothing about what the caller may not read.
 */
function servedLatestRunResolver(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  ctx: ConnectionContext,
): LatestWorkflowRunResolver {
  return async (workflow) => {
    const notFound = new UserError(`Workflow not found: ${workflow}`);
    const allowed = (resource: AccessResource) =>
      isAuthorized(socket, requestId, principal, "read", resource, ctx);
    const target = await resolveWorkflowTarget(
      ctx.repoContext.workflowRepo,
      workflow,
      workflowsDirFor(ctx.repoDir),
    );
    if (target.status === "failed") {
      if (!allowed(unresolvedAccessResource("workflow", workflow))) {
        throw notFound;
      }
      throw target.error;
    }
    if (!allowed(target.resource) || target.status !== "found") throw notFound;
    const run = await latestRunForWorkflow(
      ctx.repoContext.workflowRunRepo,
      target.id,
    );
    if (!run) return null;
    const owners = await canonicalResources(ctx).workflowOwners(
      run.workflowId,
      run.workflowName,
    );
    if (!owners.every(allowed)) throw notFound;
    return run.id;
  };
}

export async function handleDataQuery(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: DataQueryPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  // Matched records are filtered to what the caller may read inside the
  // query, before the limit, `limited` and any projection are computed, so
  // neither a projection nor the page size says anything about data the
  // caller may not read (swamp-club#2675).
  if (
    !authorizeAnyOrReject(
      socket,
      requestId,
      principal,
      "read",
      "data",
      ctx,
    )
  ) return;
  const canonical = canonicalResources(ctx);
  const readable = resourceDecider(socket, principal, "read", ctx);
  const include = async (record: DataRecord) =>
    (await canonical.dataOwners(record)).every(readable);

  try {
    const libCtx = createLibSwampContext();
    const queryService = ctx.repoContext.dataQueryService;
    const latestRunResolver = servedLatestRunResolver(
      socket,
      requestId,
      principal,
      ctx,
    );
    const deps: DataQueryDeps = {
      query: (pred, opts) =>
        queryService.query(pred, { ...opts, latestRunResolver }),
    };

    const limit = Math.min(
      payload.limit ?? DEFAULT_QUERY_LIMIT,
      MAX_QUERY_RESULTS,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      dataQuery(libCtx, deps, {
        predicate: payload.predicate,
        select: payload.select,
        limit,
        include,
      }),
      {
        resolving: () => {},
        match: () => {},
        projected_match: () => {},
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

    const data = result ?? {};

    send(socket, {
      type: "data.query",
      id: requestId,
      payload: { data },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "data_query_failed", message);
  }
}

export async function handleDataList(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: DataListPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  // An empty name reads as absent, exactly as libswamp reads it, so it takes
  // the "*" form and its per-item filtering.
  const resourceName = payload.modelIdOrName || "*";
  let model:
    | { idOrName: string; byId: boolean; expectedName?: string }
    | undefined;
  let workflow:
    | { idOrName: string; byId: boolean; expectedName?: string }
    | undefined;
  if (resourceName !== "*") {
    const target = await resolveModelTarget(
      ctx.repoContext.definitionRepo,
      resourceName,
      "data",
    );
    if (
      !authorizeResolved(
        socket,
        requestId,
        principal,
        "read",
        target,
        resourceName,
        "data",
        ctx,
        "data_list_failed",
      )
    ) return;
    model = targetArgument(target, resourceName);
  } else if (payload.workflowName) {
    // A workflow-scoped list reveals the run and its steps, so it needs read
    // on the workflow, resolved the way the list resolves it (by name, then
    // id), before any run is looked up; items are then filtered on their
    // owners (swamp-club#2603).
    const target = await resolveWorkflowTarget(
      ctx.repoContext.workflowRepo,
      payload.workflowName,
      workflowsDirFor(ctx.repoDir),
    );
    if (
      !authorizeResolved(
        socket,
        requestId,
        principal,
        "read",
        target,
        payload.workflowName,
        "workflow",
        ctx,
        "data_list_failed",
      )
    ) return;
    workflow = targetArgument(target, payload.workflowName);
  } else {
    if (
      !authorizeAnyOrReject(
        socket,
        requestId,
        principal,
        "read",
        "data",
        ctx,
      )
    ) return;
  }

  try {
    const libCtx = createLibSwampContext();
    const deps = createDataListDeps(
      ctx.repoDir,
      ctx.datastoreResolver,
      ctx.repoContext.unifiedDataRepo,
      undefined,
      ctx.repoContext.workflowRepo,
      ctx.repoContext.definitionRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      dataList(libCtx, deps, {
        modelIdOrName: model?.idOrName ?? payload.modelIdOrName,
        byId: model?.byId,
        expectedName: model?.expectedName,
        workflowName: workflow?.idOrName ?? payload.workflowName,
        workflowById: workflow?.byId,
        expectedWorkflowName: workflow?.expectedName,
        runId: payload.runId,
        typeFilter: payload.typeFilter,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new LibSwampStreamError(e.error);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "No data found");
      return;
    }

    if (resourceName === "*") {
      const listData = result as {
        modelId?: string;
        modelName?: string;
        modelType?: string;
        groups?: Array<{ type: string; items: RecordedOwner[] }>;
        total?: number;
      };
      const canonical = canonicalResources(ctx);
      if (listData.modelName) {
        const owner: RecordedOwner = {
          modelId: listData.modelId ?? "",
          modelName: listData.modelName,
          modelType: listData.modelType ?? "",
        };
        const filtered = await filterByResources(
          [owner],
          (item) => canonical.dataOwners(item),
          socket,
          principal,
          "read",
          ctx,
        );
        if (filtered.length === 0) {
          sendError(socket, requestId, "not_found", "No data found");
          return;
        }
      } else if (listData.groups) {
        let total = 0;
        for (const group of listData.groups) {
          group.items = await filterByResources(
            group.items,
            (item) => canonical.dataOwners(item),
            socket,
            principal,
            "read",
            ctx,
          );
          total += group.items.length;
        }
        listData.groups = listData.groups.filter((g) => g.items.length > 0);
        listData.total = total;
      }
    }

    send(socket, {
      type: "data.list",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(
      socket,
      requestId,
      "data_list_failed",
      message,
      clientErrorDetails(error),
    );
  }
}

export async function handleDataSearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: DataSearchPayload,
): Promise<void> {
  if (
    !authorizeAnyOrReject(
      socket,
      requestId,
      principal,
      "read",
      "data",
      ctx,
    )
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const definitionRepo = ctx.repoContext.definitionRepo;
    const dataQueryService = ctx.repoContext.dataQueryService;
    const catalogStore = ctx.repoContext.catalogStore;

    const deps: DataSearchDeps = {
      findLatestItems: () =>
        findLatestItemsFromCatalog(dataQueryService, catalogStore),
      findDefinitionByIdOrName: (idOrName) =>
        findDefinitionByIdOrName(definitionRepo, idOrName),
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      dataSearch(libCtx, deps, {
        query: payload?.query,
        type: payload?.type,
        lifetime: payload?.lifetime,
        ownerType: payload?.ownerType,
        workflow: payload?.workflow,
        model: payload?.model,
        contentType: payload?.contentType,
        since: payload?.since,
        output: payload?.output,
        run: payload?.run,
        streaming: payload?.streaming,
        tags: payload?.tags,
        limit: payload?.limit ?? 50,
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

    const data = (result ?? { results: [], total: 0 }) as {
      results?: RecordedOwner[];
      total?: number;
    };
    if (data.results) {
      const canonical = canonicalResources(ctx);
      data.results = await filterByResources(
        data.results,
        (item) => canonical.dataOwners(item),
        socket,
        principal,
        "read",
        ctx,
      );
      data.total = data.results.length;
    }

    send(socket, {
      type: "data.search",
      id: requestId,
      payload: { data },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "data_search_failed", message);
  }
}

export async function handleDataVersions(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: DataVersionsPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const target = await resolveModelTarget(
    ctx.repoContext.definitionRepo,
    payload.modelIdOrName,
    "data",
  );
  if (
    !authorizeResolved(
      socket,
      requestId,
      principal,
      "read",
      target,
      payload.modelIdOrName,
      "data",
      ctx,
      "data_versions_failed",
    )
  ) return;
  const model = targetArgument(target, payload.modelIdOrName);

  try {
    const libCtx = createLibSwampContext();
    const deps = createDataVersionsDeps(
      ctx.repoDir,
      ctx.datastoreResolver,
      ctx.repoContext.unifiedDataRepo,
      ctx.repoContext.definitionRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      dataVersions(libCtx, deps, {
        modelIdOrName: model.idOrName,
        byId: model.byId,
        expectedName: model.expectedName,
        dataName: payload.dataName,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new LibSwampStreamError(e.error);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Data not found");
      return;
    }

    send(socket, {
      type: "data.versions",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(
      socket,
      requestId,
      "data_versions_failed",
      message,
      clientErrorDetails(error),
    );
  }
}

export async function handleDataDelete(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: DataDeletePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const target = await resolveModelTarget(
    ctx.repoContext.definitionRepo,
    payload.modelIdOrName,
    "data",
  );
  if (
    !authorizeResolved(
      socket,
      requestId,
      principal,
      "write",
      target,
      payload.modelIdOrName,
      "data",
      ctx,
      "data_delete_failed",
    )
  ) return;
  const model = targetArgument(target, payload.modelIdOrName);

  try {
    const libCtx = createLibSwampContext();
    const deps = createDataDeleteDeps(
      ctx.repoDir,
      ctx.datastoreResolver,
      ctx.repoContext.unifiedDataRepo,
      ctx.repoContext.definitionRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      dataDelete(libCtx, deps, {
        modelIdOrName: model.idOrName,
        byId: model.byId,
        expectedName: model.expectedName,
        dataName: payload.dataName,
        version: payload.version,
      }),
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

    if (!result) {
      sendError(socket, requestId, "not_found", "Data not found");
      return;
    }

    send(socket, {
      type: "data.delete",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "data_delete_failed", message);
  } finally {
    await pushChangedToRemote(ctx);
  }
}

export async function handleDataRename(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: DataRenamePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const target = await resolveModelTarget(
    ctx.repoContext.definitionRepo,
    payload.modelIdOrName,
    "data",
  );
  if (
    !authorizeResolved(
      socket,
      requestId,
      principal,
      "write",
      target,
      payload.modelIdOrName,
      "data",
      ctx,
      "data_rename_failed",
    )
  ) return;
  const model = targetArgument(target, payload.modelIdOrName);

  try {
    const libCtx = createLibSwampContext();
    const deps = createDataRenameDeps(
      ctx.repoDir,
      ctx.datastoreResolver,
      ctx.repoContext.unifiedDataRepo,
      ctx.repoContext.definitionRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      dataRename(libCtx, deps, {
        modelIdOrName: model.idOrName,
        byId: model.byId,
        expectedName: model.expectedName,
        oldName: payload.oldName,
        newName: payload.newName,
      }),
      {
        renaming: () => {},
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

    if (!result) {
      sendError(socket, requestId, "rename_failed", "Rename operation failed");
      return;
    }

    send(socket, {
      type: "data.rename",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "data_rename_failed", message);
  } finally {
    await pushChangedToRemote(ctx);
  }
}

export async function handleSummarise(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: SummarisePayload,
): Promise<void> {
  // Summarises models, workflows and their data across the repository, so it
  // needs read on every resource of each kind (swamp-club#2675).
  for (const kind of ["model", "workflow", "data"] as const) {
    if (
      !authorizeAllOrReject(socket, requestId, principal, "read", kind, ctx)
        .allowed
    ) return;
  }

  try {
    const libCtx = createLibSwampContext();
    const deps = createSummariseDeps({
      outputRepo: ctx.repoContext.outputRepo,
      workflowRunRepo: ctx.repoContext.workflowRunRepo,
      dataRepo: ctx.repoContext.unifiedDataRepo,
      definitionRepo: ctx.repoContext.definitionRepo,
      workflowRepo: ctx.repoContext.workflowRepo,
    });

    const sinceLabel = payload?.since ?? "7d";
    const durationMs = parseDuration(sinceLabel);
    const cutoffDate = new Date(Date.now() - durationMs);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      summarise(libCtx, deps, {
        since: cutoffDate,
        sinceLabel,
        limit: payload?.limit,
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
      type: "summarise",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "summarise_failed", message);
  }
}

export async function handleDataGc(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: DataGcPayload | undefined,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  // Reaches every data resource, so any deny for it refuses (swamp-club#2675).
  if (
    !authorizeAllOrReject(socket, requestId, principal, "write", "data", ctx)
      .allowed
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createDataGcDeps(
      ctx.repoDir,
      ctx.datastoreResolver,
      ctx.repoContext.markDirty,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      dataGc(libCtx, deps, { dryRun: payload?.dryRun ?? false }),
      {
        collecting: () => {},
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
      type: "data.gc",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "data_gc_failed", message);
  } finally {
    await pushChangedToRemote(ctx);
  }
}

export async function handleDataPrune(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: DataPrunePayload | undefined,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  // Reaches every data resource, so any deny for it refuses (swamp-club#2675).
  if (
    !authorizeAllOrReject(socket, requestId, principal, "write", "data", ctx)
      .allowed
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createDataPruneDeps(
      ctx.repoDir,
      ctx.datastoreResolver,
      ctx.repoContext.unifiedDataRepo,
      ctx.repoContext.definitionRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      dataPrune(libCtx, deps, { dryRun: payload?.dryRun ?? false }),
      {
        collecting: () => {},
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
      type: "data.prune",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "data_prune_failed", message);
  } finally {
    await pushChangedToRemote(ctx);
  }
}

export async function handleRunGc(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: RunGcPayload | undefined,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  // Reaches every data resource, so any deny for it refuses (swamp-club#2675).
  if (
    !authorizeAllOrReject(socket, requestId, principal, "write", "data", ctx)
      .allowed
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createRunGcDeps(
      ctx.repoDir,
      ctx.datastoreResolver,
      ctx.repoContext.markDirty,
    );

    const marker = await new RepoMarkerRepository().read(
      RepoPath.create(ctx.repoDir),
    );
    const gcInput = resolveRunGcInput(
      payload,
      marker?.garbageCollection,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      runGc(libCtx, deps, gcInput),
      {
        collecting: () => {},
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
      type: "run.gc",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "run_gc_failed", message);
  } finally {
    await pushChangedToRemote(ctx);
  }
}
