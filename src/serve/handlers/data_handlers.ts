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
  dataList,
  dataPrune,
  dataQuery,
  type DataQueryDeps,
  dataRename,
  dataSearch,
  type DataSearchDeps,
  dataVersions,
  DEFAULT_OUTPUT_RETENTION_DAYS,
  DEFAULT_WORKFLOW_RUN_RETENTION_DAYS,
  parseDuration,
  runGc,
  type RunGcGarbageCollectionPolicy,
  type RunGcInput,
  runGcRetentionFromPolicy,
  summarise,
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
  authorizeAnyOrReject,
  authorizeOrReject,
  clientErrorDetails,
  type ConnectionContext,
  DEFAULT_QUERY_LIMIT,
  filterByResources,
  LibSwampStreamError,
  MAX_QUERY_RESULTS,
  pushChangedToRemote,
  sanitizeErrorForClient,
  send,
  sendError,
} from "./shared.ts";
import {
  authorizeResolved,
  canonicalResources,
  type RecordedOwner,
  resolveModelTarget,
  targetArgument,
  unresolvedAccessResource,
} from "./resource_resolution.ts";
import type { DefinitionRepository } from "../../domain/definitions/repositories.ts";
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

export async function resolveDataFields(
  definitionRepo: DefinitionRepository,
  modelIdOrName: string,
): Promise<Record<string, unknown>> {
  const target = await resolveModelTarget(
    definitionRepo,
    modelIdOrName,
    "data",
  );
  if (target.status === "found") return { ...target.resource.fields };
  // A model that does not exist has no tags or namespace. A lookup that
  // failed says nothing about them, so only the name is known and a deny
  // conditioned on the rest fails closed (swamp-club#2675).
  return target.status === "missing"
    ? { ...unresolvedAccessResource("data", modelIdOrName).fields }
    : { name: modelIdOrName };
}

export async function handleDataGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: DataGetPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  // Scoped to a workflow, modelIdOrName names a data item rather than a
  // model, and without either the request reads "*"; how those forms
  // authorize is swamp-club#2675. A model-scoped read resolves its model
  // first and authorizes the model's canonical name (swamp-club#2674).
  let model:
    | { idOrName: string; byId: boolean; expectedName?: string }
    | undefined;
  if (payload.workflowName || !payload.modelIdOrName) {
    // An empty name reads as absent, exactly as libswamp reads it.
    const resourceName = payload.modelIdOrName || "*";
    const dataFields = resourceName !== "*"
      ? await resolveDataFields(ctx.repoContext.definitionRepo, resourceName)
      : {};
    if (
      !authorizeOrReject(socket, requestId, principal, "read", {
        kind: "data",
        name: resourceName,
        fields: dataFields,
      }, ctx).allowed
    ) return;
  } else {
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
        "data_get_failed",
      )
    ) return;
    model = targetArgument(target, payload.modelIdOrName);
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

export async function handleDataQuery(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: DataQueryPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (payload.select) {
    if (
      !authorizeOrReject(socket, requestId, principal, "read", {
        kind: "data",
        name: "*",
        fields: {},
      }, ctx).allowed
    ) return;
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
    const queryService = ctx.repoContext.dataQueryService;
    const deps: DataQueryDeps = {
      query: (pred, opts) => queryService.query(pred, opts),
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

    const data = (result ?? {}) as {
      results?: RecordedOwner[];
      total?: number;
    };
    if (!payload.select && data.results) {
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
        workflowName: payload.workflowName,
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
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx).allowed
  ) return;

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
  if (
    !authorizeOrReject(socket, requestId, principal, "write", {
      kind: "data",
      name: "*",
      fields: {},
    }, ctx).allowed
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
  if (
    !authorizeOrReject(socket, requestId, principal, "write", {
      kind: "data",
      name: "*",
      fields: {},
    }, ctx).allowed
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
  if (
    !authorizeOrReject(socket, requestId, principal, "write", {
      kind: "data",
      name: "*",
      fields: {},
    }, ctx).allowed
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
