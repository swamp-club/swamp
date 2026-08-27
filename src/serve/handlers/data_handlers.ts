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
  DEFAULT_WORKFLOW_RUN_RETENTION_DAYS,
  parseDuration,
  runGc,
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
  authorizeOrReject,
  type ConnectionContext,
  DEFAULT_QUERY_LIMIT,
  MAX_QUERY_RESULTS,
  sanitizeErrorForClient,
  send,
  sendError,
} from "./shared.ts";
import type { DefinitionRepository } from "../../domain/definitions/repositories.ts";

export async function resolveDataFields(
  definitionRepo: DefinitionRepository,
  modelIdOrName: string,
): Promise<Record<string, unknown>> {
  const fields: Record<string, unknown> = { name: modelIdOrName };
  const result = await findDefinitionByIdOrName(definitionRepo, modelIdOrName);
  if (result) {
    fields.name = result.definition.name;
    const tags = result.definition.tags;
    if (tags && Object.keys(tags).length > 0) fields.tags = tags;
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
    }, ctx)
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
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "data",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

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

    send(socket, {
      type: "data.query",
      id: requestId,
      payload: { data: result ?? {} },
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
  const listFields = resourceName !== "*"
    ? await resolveDataFields(ctx.repoContext.definitionRepo, resourceName)
    : {};
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "data",
      name: resourceName,
      fields: listFields,
    }, ctx)
  ) return;

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
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "data",
      name: "*",
      fields: {},
    }, ctx)
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

    send(socket, {
      type: "data.search",
      id: requestId,
      payload: { data: result ?? { items: [], totalCount: 0 } },
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
    }, ctx)
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
    }, ctx)
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
    }, ctx)
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
    }, ctx)
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
    }, ctx)
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
    }, ctx)
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
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createRunGcDeps(
      ctx.repoDir,
      ctx.datastoreResolver,
      ctx.repoContext.markDirty,
    );

    const retentionDays = payload?.workflowRunRetentionDays ??
      DEFAULT_WORKFLOW_RUN_RETENTION_DAYS;

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      runGc(libCtx, deps, {
        dryRun: payload?.dryRun ?? false,
        workflowRunRetentionDays: retentionDays,
        outputRetentionDays: payload?.outputRetentionDays ?? retentionDays,
      }),
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
