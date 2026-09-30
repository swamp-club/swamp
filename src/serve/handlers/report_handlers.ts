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
 * Report-domain request handlers (report.* verbs).
 */

import {
  consumeStream,
  createLibSwampContext,
  reportDescribe,
  type ReportDescribeDeps,
  reportGet,
  type ReportGetDeps,
  reportSearch,
  type ReportSearchDeps,
  reportTypeSearch,
  type ReportTypeSearchDeps,
  workflowsDirFor,
} from "../../libswamp/mod.ts";
import type {
  ReportDescribePayload,
  ReportGetPayload,
  ReportSearchPayload,
  ReportTypeSearchPayload,
} from "../protocol.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { createDefinitionId } from "../../domain/definitions/definition.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import { getReportTypes } from "../../domain/reports/report_types.ts";
import type { Principal } from "../../domain/access/principal.ts";
import {
  authorizeAnyOrReject,
  authorizeOrReject,
  type ConnectionContext,
  filterByResources,
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
} from "./resource_resolution.ts";
import { kindResource } from "../../domain/access/access_decision_service.ts";

export async function handleReportGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ReportGetPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  // A report is data, so it is read as its owner's data: a named model or
  // workflow is authorized first, and the report read — and any ambiguity it
  // reports — covers only owners the caller may read (swamp-club#2675).
  if (
    !authorizeAnyOrReject(socket, requestId, principal, "read", "data", ctx)
  ) return;
  if (payload.model) {
    const target = await resolveModelTarget(
      ctx.repoContext.definitionRepo,
      payload.model,
      "data",
    );
    if (
      !authorizeResolved(
        socket,
        requestId,
        principal,
        "read",
        target,
        payload.model,
        "data",
        ctx,
        "report_get_failed",
      )
    ) return;
  } else if (payload.workflow) {
    const target = await resolveWorkflowTarget(
      ctx.repoContext.workflowRepo,
      payload.workflow,
      workflowsDirFor(ctx.repoDir),
    );
    if (
      !authorizeResolved(
        socket,
        requestId,
        principal,
        "read",
        target,
        payload.workflow,
        "workflow",
        ctx,
        "report_get_failed",
      )
    ) return;
  }
  const canonical = canonicalResources(ctx);
  const readable = resourceDecider(socket, principal, "read", ctx);
  const include = async (
    owner: { modelType: string; modelId: string; modelName: string },
  ) => (await canonical.dataOwners(owner)).every(readable);

  try {
    const libCtx = createLibSwampContext();
    const deps: ReportGetDeps = {
      findAllGlobal: () => ctx.repoContext.unifiedDataRepo.findAllGlobal(),
      findAllForModel: (type, modelId) =>
        ctx.repoContext.unifiedDataRepo.findAllForModel(type, modelId),
      findDataByVersion: (type, modelId, dataName, version) =>
        ctx.repoContext.unifiedDataRepo.findByName(
          type,
          modelId,
          dataName,
          version,
        ),
      getContent: (type, modelId, dataName, version) =>
        ctx.repoContext.unifiedDataRepo.getContent(
          type,
          modelId,
          dataName,
          version,
        ),
      lookupDefinition: (idOrName) =>
        findDefinitionByIdOrName(ctx.repoContext.definitionRepo, idOrName),
      lookupDefinitionById: (type, id) =>
        ctx.repoContext.definitionRepo.findById(type, createDefinitionId(id)),
      findWorkflowByName: async (name) => {
        const wf = await ctx.repoContext.workflowRepo.findByName(name);
        if (!wf) return null;
        return { id: wf.id, name: wf.name };
      },
      findWorkflowById: async (id) => {
        const all = await ctx.repoContext.workflowRepo.findAll();
        const wf = all.find((w) => w.id === id);
        if (!wf) return null;
        return { id: wf.id, name: wf.name };
      },
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      reportGet(libCtx, deps, {
        reportName: payload.reportName,
        model: payload.model,
        workflow: payload.workflow,
        version: payload.version,
        variant: payload.variant,
        include,
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
      sendError(socket, requestId, "not_found", "Report not found");
      return;
    }

    send(socket, {
      type: "report.get",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "report_get_failed", message);
  }
}

export async function handleReportSearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: ReportSearchPayload,
): Promise<void> {
  // Reports are data: results are filtered to owners the caller may read
  // (swamp-club#2675).
  if (
    !authorizeAnyOrReject(socket, requestId, principal, "read", "data", ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    await reportRegistry.ensureLoaded();
    const deps: ReportSearchDeps = {
      findAllGlobal: () => ctx.repoContext.unifiedDataRepo.findAllGlobal(),
      findAllForModel: (type, modelId) =>
        ctx.repoContext.unifiedDataRepo.findAllForModel(type, modelId),
      lookupDefinition: (idOrName) =>
        findDefinitionByIdOrName(ctx.repoContext.definitionRepo, idOrName),
      lookupDefinitionById: (type, id) =>
        ctx.repoContext.definitionRepo.findById(type, createDefinitionId(id)),
      findWorkflowByName: async (name) => {
        const wf = await ctx.repoContext.workflowRepo.findByName(name);
        if (!wf) return null;
        return { id: wf.id, name: wf.name };
      },
      findWorkflowById: async (id) => {
        const all = await ctx.repoContext.workflowRepo.findAll();
        const wf = all.find((w) => w.id === id);
        if (!wf) return null;
        return { id: wf.id, name: wf.name };
      },
      getReport: async (name) => {
        await reportRegistry.ensureTypeLoaded(name);
        return reportRegistry.get(name);
      },
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      reportSearch(libCtx, deps, {
        query: payload?.query,
        model: payload?.model,
        workflow: payload?.workflow,
        scope: payload?.scope,
        type: payload?.type,
        labels: payload?.labels,
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

    const data = (result ?? {}) as { reports?: RecordedOwner[] };
    if (data.reports) {
      const canonical = canonicalResources(ctx);
      data.reports = await filterByResources(
        data.reports,
        (report) => canonical.dataOwners(report),
        socket,
        principal,
        "read",
        ctx,
      );
    }

    send(socket, {
      type: "report.search",
      id: requestId,
      payload: { data },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "report_search_failed", message);
  }
}

export async function handleReportDescribe(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ReportDescribePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  // Report types only: a check on the kind, touching no model.
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
    await reportRegistry.ensureLoaded();
    const libCtx = createLibSwampContext();
    const deps: ReportDescribeDeps = {
      getReport: async (name) => {
        await reportRegistry.ensureTypeLoaded(name);
        return reportRegistry.get(name);
      },
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      reportDescribe(libCtx, deps, payload.reportName),
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
      sendError(socket, requestId, "not_found", "Report type not found");
      return;
    }

    send(socket, {
      type: "report.describe",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "report_describe_failed", message);
  }
}

export async function handleReportTypeSearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: ReportTypeSearchPayload,
): Promise<void> {
  // Report types only: a check on the kind, touching no model.
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
    const libCtx = createLibSwampContext();
    await reportRegistry.ensureLoaded();
    for (const lazy of reportRegistry.getAllLazy()) {
      await reportRegistry.ensureTypeLoaded(lazy.type);
    }

    const deps: ReportTypeSearchDeps = {
      getReportTypes: () => getReportTypes(),
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      reportTypeSearch(libCtx, deps, { query: payload?.query }),
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
      type: "report.type.search",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "report_type_search_failed", message);
  }
}
