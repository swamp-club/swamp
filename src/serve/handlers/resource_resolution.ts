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
  findDefinitionsByIdGlobal,
} from "../../domain/models/model_lookup.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import {
  findWorkflowById,
  findWorkflowByIdOrName,
} from "../../domain/workflows/workflow_lookup.ts";
import {
  findBrokenWorkflow,
  type OutputIdReference,
  type OutputReference,
  type RunReference,
} from "../../libswamp/mod.ts";
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

/**
 * Resolves a model recorded as `id` and `name` — a run's resource. Ids are not
 * guaranteed unique, so the definition with both is preferred; if none has
 * both, the model was renamed since, and it is found by id alone.
 */
export async function resolveRecordedModel(
  definitionRepo: DefinitionRepository,
  id: string,
  name: string,
  kind: ModelResourceKind = "model",
): Promise<ResourceResolution> {
  const exact = await resolveModel(
    () => findDefinitionByIdGlobal(definitionRepo, id, name),
    id,
    kind,
  );
  return exact.status === "missing"
    ? await resolveModelTargetById(definitionRepo, id, kind)
    : exact;
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
 * Resolves a workflow recorded as `id` and `name` — a run's workflow. Ids are
 * not guaranteed unique, so the workflow with both is preferred; if none has
 * both, it was renamed since, and it is found by id alone.
 */
export async function resolveRecordedWorkflow(
  workflowRepo: WorkflowRepository,
  id: string,
  name: string,
): Promise<ResourceResolution> {
  const exact = await resolveWorkflow(
    () => findWorkflowById(workflowRepo, id, name),
    id,
    undefined,
    () => false,
  );
  return exact.status === "missing"
    ? await resolveWorkflowTargetById(workflowRepo, id)
    : exact;
}

/**
 * The argument to hand the operation after authorizing `resolution`.
 *
 * A resolved resource is passed by its id with `byId` and its authorized name
 * as `expectedName`: the operation accepts only a resource with both, so it
 * cannot land on a resource named with that id, nor on another file that
 * declares the same id (ids are not guaranteed unique). A broken workflow
 * file that declares an id is passed the same way. A missing resource passes
 * the raw string by id only: the operation reports its own not-found as
 * before, and can only ever act on a resource whose id is the very string
 * that was authorized. A broken file with no readable id passes the raw
 * string as sent: no parsed workflow matches it, so the operation reaches the
 * same broken file.
 */
export function targetArgument(
  resolution: SettledResolution,
  idOrName: string,
): { idOrName: string; byId: boolean; expectedName?: string } {
  switch (resolution.status) {
    case "found":
      return {
        idOrName: resolution.id,
        byId: true,
        expectedName: resolution.name,
      };
    case "broken":
      return resolution.id
        ? { idOrName: resolution.id, byId: true, expectedName: resolution.name }
        : { idOrName, byId: false };
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

/**
 * What a read by output or run reference resolved to, and every resource the
 * caller must be allowed to read for it (swamp-club#2673). The read is then
 * handed `resolved.reference` and acts on exactly that.
 */
export type ReferenceAccess<T> =
  | { status: "resolved"; resolved: T; resources: AccessResource[] }
  | { status: "failed"; error: unknown };

type AnyOutputReference =
  | OutputReference<{ definitionId: string }>
  | OutputIdReference<{ definitionId: string }>;

/**
 * The resources that own what is stored under an output's model: every
 * definition declaring its definition id, since ids are not unique and a copy
 * shares the original's outputs and data. An output whose model was deleted
 * has no owner left to name, so it is authorized on its definition id.
 */
async function outputOwners(
  definitionRepo: DefinitionRepository,
  definitionId: string,
  type: ModelType,
  kinds: ModelResourceKind[],
): Promise<AccessResource[]> {
  const owners = await findDefinitionsByIdGlobal(definitionRepo, definitionId);
  if (owners.length > 0) {
    return owners.flatMap((owner) =>
      kinds.map((kind) => modelAccessResource(owner, kind))
    );
  }
  return kinds.map((kind) => {
    const fields: Record<string, unknown> = { name: definitionId };
    if (kind === "model") {
      fields.modelType = type.normalized;
    } else {
      const ns = ModelType.getUserNamespace(type.normalized);
      if (ns) fields.ns = ns;
    }
    return { kind, name: definitionId, fields };
  });
}

/** Drops resources that repeat an earlier one exactly. */
function distinct(resources: AccessResource[]): AccessResource[] {
  const seen = new Set<string>();
  return resources.filter((resource) => {
    const key = JSON.stringify([resource.kind, resource.name, resource.fields]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Resolves an output read with `resolve` and collects what to authorize, as
 * each of `kinds`: for an output, every model that owns it; for a model, that
 * model and every owner of the latest output the read will return; for an
 * ambiguous or unmatched argument, the raw string as sent.
 */
export async function resolveOutputAccess<
  T extends { reference: AnyOutputReference },
>(
  definitionRepo: DefinitionRepository,
  resolve: () => Promise<T>,
  rawArgument: string,
  kinds: ModelResourceKind[],
): Promise<ReferenceAccess<T>> {
  try {
    const resolved = await resolve();
    const reference = resolved.reference;
    let resources: AccessResource[];
    switch (reference.kind) {
      case "output":
        resources = await outputOwners(
          definitionRepo,
          reference.match.output.definitionId,
          reference.match.type,
          kinds,
        );
        break;
      case "model": {
        const named = kinds.map((kind) => modelAccessResource(reference, kind));
        const owners = reference.latest
          ? await outputOwners(
            definitionRepo,
            reference.latest.definitionId,
            reference.type,
            kinds,
          )
          : [];
        resources = [...named, ...owners];
        break;
      }
      default:
        resources = kinds.map((kind) =>
          unresolvedAccessResource(kind, rawArgument)
        );
    }
    return { status: "resolved", resolved, resources: distinct(resources) };
  } catch (error) {
    return { status: "failed", error };
  }
}

/**
 * The workflows a run belongs to: the workflow recorded on it, by its
 * recorded name, and — when a workflow with the recorded id now goes by
 * another name — that workflow too. The recorded name always counts, so a
 * run is judged on the workflow that made it even if that workflow was
 * deleted or renamed, or a copy now shares its id.
 */
async function runOwners(
  workflowRepo: WorkflowRepository,
  run: WorkflowRun,
): Promise<AccessResource[]> {
  const resolution = await resolveRecordedWorkflow(
    workflowRepo,
    run.workflowId,
    run.workflowName,
  );
  if (resolution.status === "failed") throw resolution.error;
  const recorded = workflowAccessResource({
    name: run.workflowName,
    tags: {},
  });
  if (resolution.status === "missing") return [recorded];
  return resolution.name === run.workflowName
    ? [resolution.resource]
    : [recorded, resolution.resource];
}

/**
 * Resolves a workflow history read with `resolve` and collects what to
 * authorize: for a run, the workflows it belongs to; for a workflow, that
 * workflow and the workflows of the latest run the read will return; for an
 * ambiguous or unmatched argument, the raw string as sent.
 */
export async function resolveRunAccess<T extends { reference: RunReference }>(
  workflowRepo: WorkflowRepository,
  resolve: () => Promise<T>,
  rawArgument: string,
): Promise<ReferenceAccess<T>> {
  try {
    const resolved = await resolve();
    const reference = resolved.reference;
    let resources: AccessResource[];
    switch (reference.kind) {
      case "run":
        resources = await runOwners(workflowRepo, reference.run);
        break;
      case "workflow":
        resources = [
          workflowAccessResource(reference.workflow),
          ...(reference.latest
            ? await runOwners(workflowRepo, reference.latest)
            : []),
        ];
        break;
      default:
        resources = [unresolvedAccessResource("workflow", rawArgument)];
    }
    return { status: "resolved", resolved, resources: distinct(resources) };
  } catch (error) {
    return { status: "failed", error };
  }
}

/**
 * Authorizes `action` on every resource `access` collected, stopping at the
 * first denial, which is replied as authorizeOrReject replies. A failed
 * lookup is replied as `failedCode` with a sanitized message, after the raw
 * argument is authorized as each of `kinds`, so a refused caller learns
 * nothing more. Returns whether the read may proceed.
 */
export function authorizeReferenceAccess<T>(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  action: Action,
  access: ReferenceAccess<T>,
  rawArgument: string,
  kinds: AccessResource["kind"][],
  ctx: ConnectionContext,
  failedCode: string,
): access is Extract<ReferenceAccess<T>, { status: "resolved" }> {
  const resources = access.status === "failed"
    ? kinds.map((kind) => unresolvedAccessResource(kind, rawArgument))
    : access.resources;
  for (const resource of resources) {
    if (
      !authorizeOrReject(socket, requestId, principal, action, resource, ctx)
        .allowed
    ) return false;
  }
  if (access.status === "failed") {
    sendError(
      socket,
      requestId,
      failedCode,
      sanitizeErrorForClient(access.error),
    );
    return false;
  }
  return true;
}
