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
 * Resolves the id-or-name in a serve request to the resource it names, and
 * builds the access resource to authorize from that resource's canonical
 * name and fields (swamp-club#2674).
 *
 * A grant selector matches a resource name, so a handler must never authorize
 * the raw string a client sent: a model's UUID would sidestep a deny on its
 * name. Handlers resolve first, authorize on {@link ResourceResolution}'s
 * `resource`, then act on {@link targetArgument} — the resolved id, looked up
 * by id only — so the resource acted on is the resource authorized.
 */

import type { AccessResource } from "../../domain/access/access_decision_service.ts";
import type { DefinitionRepository } from "../../domain/definitions/repositories.ts";
import {
  type DefinitionLookupResult,
  findDefinitionByIdGlobal,
  findDefinitionByIdOrName,
} from "../../domain/models/model_lookup.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import {
  findWorkflowById,
  findWorkflowByIdOrName,
} from "../../domain/workflows/workflow_lookup.ts";
import { findBrokenWorkflow } from "../../libswamp/mod.ts";
import type { Action } from "../../domain/access/action.ts";
import type { Principal } from "../../domain/access/principal.ts";
import {
  authorizeOrReject,
  type ConnectionContext,
  sanitizeErrorForClient,
  sendError,
} from "./shared.ts";

/** How a request's id-or-name resolved. */
export type ResourceResolution =
  | {
    /** It names an existing resource; authorize `resource`, act on `id`. */
    status: "found";
    resource: AccessResource;
    id: string;
    name: string;
  }
  | {
    /**
     * It names a workflow file that does not parse. `resource` carries the
     * name the file declares; `id` is its declared id, when readable.
     */
    status: "broken";
    resource: AccessResource;
    id: string | null;
    name: string;
  }
  | {
    /**
     * Nothing matches. `resource` is built from the raw string, so a deny on
     * that string still applies; the operation then reports its own
     * not-found.
     */
    status: "missing";
    resource: AccessResource;
  }
  | {
    /** The lookup itself failed; the request must fail, never proceed. */
    status: "failed";
    error: unknown;
  };

/** Which resource kind a model reference is authorized as. */
export type ModelResourceKind = "model" | "data";

/** The access resource for a model definition, authorized as `kind`. */
export function modelAccessResource(
  result: DefinitionLookupResult,
  kind: ModelResourceKind = "model",
): AccessResource {
  const name = result.definition.name;
  const fields: Record<string, unknown> = { name };
  if (kind === "model") {
    fields.modelType = result.type.normalized;
  } else {
    const ns = ModelType.getUserNamespace(result.type.normalized);
    if (ns) fields.ns = ns;
  }
  const tags = result.definition.tags;
  if (tags && Object.keys(tags).length > 0) fields.tags = tags;
  return { kind, name, fields };
}

/** The access resource for a workflow. */
export function workflowAccessResource(
  workflow: Pick<Workflow, "name" | "tags">,
): AccessResource {
  const fields: Record<string, unknown> = { name: workflow.name };
  if (workflow.tags && Object.keys(workflow.tags).length > 0) {
    fields.tags = workflow.tags;
  }
  return { kind: "workflow", name: workflow.name, fields };
}

/** The access resource for a request whose id-or-name matched nothing. */
export function unresolvedAccessResource(
  kind: AccessResource["kind"],
  idOrName: string,
): AccessResource {
  return { kind, name: idOrName, fields: { name: idOrName } };
}

async function resolveModel(
  lookup: () => Promise<DefinitionLookupResult | null>,
  idOrName: string,
  kind: ModelResourceKind,
): Promise<ResourceResolution> {
  let result: DefinitionLookupResult | null;
  try {
    result = await lookup();
  } catch (error) {
    return { status: "failed", error };
  }
  if (!result) {
    return {
      status: "missing",
      resource: unresolvedAccessResource(kind, idOrName),
    };
  }
  return {
    status: "found",
    resource: modelAccessResource(result, kind),
    id: result.definition.id,
    name: result.definition.name,
  };
}

/** Resolves a model reference by name, then exact id. */
export function resolveModelTarget(
  definitionRepo: DefinitionRepository,
  idOrName: string,
  kind: ModelResourceKind = "model",
): Promise<ResourceResolution> {
  return resolveModel(
    () => findDefinitionByIdOrName(definitionRepo, idOrName),
    idOrName,
    kind,
  );
}

/** Resolves a model by exact definition id only. */
export function resolveModelTargetById(
  definitionRepo: DefinitionRepository,
  id: string,
  kind: ModelResourceKind = "model",
): Promise<ResourceResolution> {
  return resolveModel(
    () => findDefinitionByIdGlobal(definitionRepo, id),
    id,
    kind,
  );
}

async function resolveWorkflow(
  lookup: () => Promise<Workflow | null>,
  idOrName: string,
  workflowsDir: string | undefined,
  matchesBroken: (
    declared: { name: string | null; id: string | null },
  ) => boolean,
): Promise<ResourceResolution> {
  let workflow: Workflow | null;
  try {
    workflow = await lookup();
  } catch (error) {
    return { status: "failed", error };
  }
  if (workflow) {
    return {
      status: "found",
      resource: workflowAccessResource(workflow),
      id: workflow.id,
      name: workflow.name,
    };
  }
  if (workflowsDir) {
    // A file that fails to parse is invisible to the repository, but the
    // operations still find it by the name or id it declares, so it must be
    // authorized by the name it declares too.
    let broken;
    try {
      broken = await findBrokenWorkflow(workflowsDir, idOrName);
    } catch (error) {
      return { status: "failed", error };
    }
    if (broken?.name && matchesBroken(broken)) {
      return {
        status: "broken",
        resource: workflowAccessResource({ name: broken.name, tags: {} }),
        id: broken.id,
        name: broken.name,
      };
    }
  }
  return {
    status: "missing",
    resource: unresolvedAccessResource("workflow", idOrName),
  };
}

/**
 * Resolves a workflow reference by name, then exact id, then — when
 * `workflowsDir` is given — a workflow file that fails to parse.
 */
export function resolveWorkflowTarget(
  workflowRepo: WorkflowRepository,
  idOrName: string,
  workflowsDir?: string,
): Promise<ResourceResolution> {
  return resolveWorkflow(
    () => findWorkflowByIdOrName(workflowRepo, idOrName),
    idOrName,
    workflowsDir,
    () => true,
  );
}

/** Resolves a workflow by exact id only. */
export function resolveWorkflowTargetById(
  workflowRepo: WorkflowRepository,
  id: string,
  workflowsDir?: string,
): Promise<ResourceResolution> {
  return resolveWorkflow(
    () => findWorkflowById(workflowRepo, id),
    id,
    workflowsDir,
    (declared) => declared.id === id,
  );
}

/**
 * The argument to hand the operation after authorizing `resolution`.
 *
 * A resolved resource is passed by id with `byId`, so the operation looks it
 * up by id only and cannot land on a resource named with that id. A missing
 * one passes the raw string by id only too: the operation reports its own
 * not-found exactly as before, and can only ever act on a resource whose id
 * is the very string that was authorized. A broken workflow file passes the
 * raw string as sent: no parsed workflow matches it, so the operation falls
 * through to the same broken file and reports its load error as before.
 */
export function targetArgument(
  resolution: SettledResolution,
  idOrName: string,
): { idOrName: string; byId: boolean } {
  switch (resolution.status) {
    case "found":
      return { idOrName: resolution.id, byId: true };
    case "broken":
      return { idOrName, byId: false };
    case "missing":
      return { idOrName, byId: true };
  }
}

/** A resolution that did not fail. */
export type SettledResolution = Exclude<
  ResourceResolution,
  { status: "failed" }
>;

/**
 * Authorizes `action` on what `resolution` resolved to, replying to the
 * client when the request cannot proceed: a denial as authorizeOrReject
 * replies, and a failed lookup — after the raw string is authorized, so a
 * denied caller learns nothing more — as `failedCode` with a sanitized
 * message. Returns whether the request may proceed.
 */
export function authorizeResolved(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  action: Action,
  resolution: ResourceResolution,
  rawIdOrName: string,
  kind: AccessResource["kind"],
  ctx: ConnectionContext,
  failedCode: string,
): resolution is SettledResolution {
  const resource = resolution.status === "failed"
    ? unresolvedAccessResource(kind, rawIdOrName)
    : resolution.resource;
  if (
    !authorizeOrReject(socket, requestId, principal, action, resource, ctx)
      .allowed
  ) return false;
  if (resolution.status === "failed") {
    sendError(
      socket,
      requestId,
      failedCode,
      sanitizeErrorForClient(resolution.error),
    );
    return false;
  }
  return true;
}
