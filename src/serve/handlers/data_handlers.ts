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
  DEFAULT_OUTPUT_RETENTION_DAYS,
  dataVersions,
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
import { ModelType } from "../../domain/models/model_type.ts";
import { findLatestItemsFromCatalog } from "../../infrastructure/persistence/catalog_search_adapter.ts";
import type { Principal } from "../../domain/access/principal.ts";
import {
  authorizeAnyOrReject,
  authorizeOrReject,
  type ConnectionContext,
  DEFAULT_QUERY_LIMIT,
  filterByAuthorization,
  MAX_QUERY_RESULTS,
  sanitizeErrorForClient,
  send,
  sendError,
} from "./shared.ts";
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
  const fields: Record<string, unknown> = { name: modelIdOrName };
  try {
    const result = await findDefinitionByIdOrName(
      definitionRepo,
      modelIdOrName,
    );
    if (result) {
      fields.name = result.definition.name;
      const ns = ModelType.getUserNamespace(result.type.normalized);
      if (ns) fields.ns = ns;
      const tags = result.definition.tags;
      if (tags && Object.keys(tags).length > 0) fields.tags = tags;
    }
  } catch {
    // Fall back to name-only fields on lookup failure
  }
  return fields;
}

export async function handleDataGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: DataGetPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const resourceName = payload.modelIdOrName ?? "*";
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

  try {
    const libCtx = createLibSwampContext();
    const deps = createDataGetDeps(
      ctx.repoDir,
      undefined,
      ctx.repoContext.unifiedDataRepo,
      ctx.repoContext.workflowRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      dataGet(libCtx, deps, {
        modelIdOrName: payload.modelIdOrName,
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
      type: "data.get",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "data_get_failed", message);
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
      results?: Array<{ modelName: string; modelType: string }>;
      total?: number;
    };
    if (!payload.select && data.results) {
      data.results = filterByAuthorization(
        data.results,
        (item) => item.modelName,
        (item) => ({ name: item.modelName, modelType: item.modelType }),
        socket,
        principal,
        "read",
        "data",
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
  const resourceName = payload.modelIdOrName ?? "*";
  if (resourceName !== "*") {
    const listFields = await resolveDataFields(
      ctx.repoContext.definitionRepo,
      resourceName,
    );
    if (
      !authorizeOrReject(socket, requestId, principal, "read", {
        kind: "data",
        name: resourceName,
        fields: listFields,
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
    const deps = createDataListDeps(
      ctx.repoDir,
      undefined,
      ctx.repoContext.unifiedDataRepo,
      undefined,
      ctx.repoContext.workflowRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      dataList(libCtx, deps, {
        modelIdOrName: payload.modelIdOrName,
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
          throw new Error(e.error.message);
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
        modelName?: string;
        modelType?: string;
        groups?: Array<{
          type: string;
          items: Array<{ modelName: string; modelType: string }>;
        }>;
        total?: number;
      };
      if (listData.modelName) {
        const filtered = filterByAuthorization(
          [listData],
          (item) => item.modelName,
          (item) => ({
            name: item.modelName,
            modelType: item.modelType,
          }),
          socket,
          principal,
          "read",
          "data",
          ctx,
        );
        if (filtered.length === 0) {
          sendError(socket, requestId, "not_found", "No data found");
          return;
        }
      } else if (listData.groups) {
        let total = 0;
        for (const group of listData.groups) {
          group.items = filterByAuthorization(
            group.items,
            (item) => item.modelName,
            (item) => ({
              name: item.modelName,
              modelType: item.modelType,
            }),
            socket,
            principal,
            "read",
            "data",
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
    sendError(socket, requestId, "data_list_failed", message);
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
      results?: Array<{ modelName: string; modelType: string }>;
      total?: number;
    };
    if (data.results) {
      data.results = filterByAuthorization(
        data.results,
        (item) => item.modelName,
        (item) => ({ name: item.modelName, modelType: item.modelType }),
        socket,
        principal,
        "read",
        "data",
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
  const resourceName = payload.modelIdOrName;
  const versionFields = await resolveDataFields(
    ctx.repoContext.definitionRepo,
    resourceName,
  );
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "data",
      name: resourceName,
      fields: versionFields,
    }, ctx).allowed
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createDataVersionsDeps(
      ctx.repoDir,
      undefined,
      ctx.repoContext.unifiedDataRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      dataVersions(libCtx, deps, {
        modelIdOrName: payload.modelIdOrName,
        dataName: payload.dataName,
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
    sendError(socket, requestId, "data_versions_failed", message);
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
  const deleteFields = await resolveDataFields(
    ctx.repoContext.definitionRepo,
    payload.modelIdOrName,
  );
  if (
    !authorizeOrReject(socket, requestId, principal, "write", {
      kind: "data",
      name: payload.modelIdOrName,
      fields: deleteFields,
    }, ctx).allowed
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createDataDeleteDeps(
      ctx.repoDir,
      ctx.datastoreResolver,
      ctx.repoContext.unifiedDataRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      dataDelete(libCtx, deps, {
        modelIdOrName: payload.modelIdOrName,
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
  const renameFields = await resolveDataFields(
    ctx.repoContext.definitionRepo,
    payload.modelIdOrName,
  );
  if (
    !authorizeOrReject(socket, requestId, principal, "write", {
      kind: "data",
      name: payload.modelIdOrName,
      fields: renameFields,
    }, ctx).allowed
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createDataRenameDeps(
      ctx.repoDir,
      ctx.datastoreResolver,
      ctx.repoContext.unifiedDataRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      dataRename(libCtx, deps, {
        modelIdOrName: payload.modelIdOrName,
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
  }
}
