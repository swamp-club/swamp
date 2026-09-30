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

import { controlPlaneRecordResource } from "../../domain/access/control_plane_records.ts";
import { isControlPlaneModelType } from "../../domain/models/control_plane_types.ts";
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
  isAuthorized,
  recordAuditedResource,
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

/**
 * The resource fields a model or data resource of `type` carries, as `kind`.
 * Every resource field of the kind is present, empty when the resource has
 * none (tags `{}`, ns `""`): a deny that needs a field the resource lacks
 * fails closed, so an untagged resource must say it has no tags
 * (swamp-club#2675).
 */
function modelTypeFields(
  name: string,
  type: string,
  tags: Record<string, string> | undefined,
  kind: ModelResourceKind,
): Record<string, unknown> {
  const fields: Record<string, unknown> = { name };
  if (kind === "model") {
    fields.modelType = type;
  } else {
    fields.ns = ModelType.getUserNamespace(type) ?? "";
  }
  fields.tags = tags ?? {};
  return fields;
}

/**
 * The access resource for a model definition, authorized as `kind`. A
 * control-plane model (a grant, group, token or worker record) is owned by
 * the access kind instead, whichever kind was asked for (swamp-club#2756).
 */
export function modelAccessResource(
  result: DefinitionLookupResult,
  kind: ModelResourceKind = "model",
): AccessResource {
  if (isControlPlaneModelType(result.type.normalized)) {
    return controlPlaneRecordResource(result.type.normalized);
  }
  const name = result.definition.name;
  return {
    kind,
    name,
    fields: modelTypeFields(
      name,
      result.type.normalized,
      result.definition.tags,
      kind,
    ),
  };
}

/** The access resource for a workflow; its tags are `{}` when it has none. */
export function workflowAccessResource(
  workflow: Pick<Workflow, "name" | "tags">,
): AccessResource {
  return {
    kind: "workflow",
    name: workflow.name,
    fields: { name: workflow.name, tags: workflow.tags ?? {} },
  };
}

/**
 * The access resource for a request whose id-or-name matched nothing. A
 * resource that does not exist has no tags, so its fields say so.
 */
export function unresolvedAccessResource(
  kind: AccessResource["kind"],
  idOrName: string,
): AccessResource {
  const fields: Record<string, unknown> = { name: idOrName };
  if (kind !== "access") fields.tags = {};
  if (kind === "data") fields.ns = "";
  return { kind, name: idOrName, fields };
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
  // The response is audited under the resolved name, not the id the client
  // sent (swamp-club#2603). A string that matched nothing keeps it.
  if (resolution.status !== "missing") {
    recordAuditedResource(socket, requestId, kind, resolution.name, ctx);
  }
  return true;
}

/**
 * What a read by output or run reference resolved to, and every resource the
 * caller must be allowed to read for it (swamp-club#2673). The read is then
 * handed `resolved.reference` and acts on exactly that.
 *
 * A prefix matching several outputs or runs is `ambiguous`: `candidates`
 * holds the owners of each match, in the order of the reference's `ids`, and
 * `narrow` keeps only the matches at the given indexes, so the ambiguity
 * error lists only what the caller may read (swamp-club#2743). Matches with
 * the same owners share one array, so each owner is decided once.
 */
export type ReferenceAccess<T> =
  | { status: "resolved"; resolved: T; resources: AccessResource[] }
  | {
    status: "ambiguous";
    resolved: T;
    candidates: AccessResource[][];
    narrow: (readable: number[]) => T;
  }
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
  return kinds.map((kind) => ({
    kind,
    name: definitionId,
    fields: modelTypeFields(definitionId, type.normalized, undefined, kind),
  }));
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
 * ambiguous prefix, the owners of each output it matched, looked up once per
 * model id; for an unmatched argument, the raw string as sent.
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
      case "ambiguous": {
        const owners = new Map<string, AccessResource[]>();
        const candidates: AccessResource[][] = [];
        for (const { output, type } of reference.matches) {
          const key = JSON.stringify([type.normalized, output.definitionId]);
          let found = owners.get(key);
          if (!found) {
            found = distinct(
              await outputOwners(
                definitionRepo,
                output.definitionId,
                type,
                kinds,
              ),
            );
            owners.set(key, found);
          }
          candidates.push(found);
        }
        return {
          status: "ambiguous",
          resolved,
          candidates,
          narrow: (readable) => ({
            ...resolved,
            reference: {
              kind: "ambiguous",
              ids: readable.map((i) => reference.ids[i]),
              matches: readable.map((i) => reference.matches[i]),
            },
          }),
        };
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
function runOwners(
  workflowRepo: WorkflowRepository,
  run: WorkflowRun,
): Promise<AccessResource[]> {
  return recordedWorkflowOwners(workflowRepo, run.workflowId, run.workflowName);
}

/**
 * The workflows something recorded as workflow `id` named `name` belongs to,
 * by the rule {@link runOwners} describes.
 */
async function recordedWorkflowOwners(
  workflowRepo: WorkflowRepository,
  id: string,
  name: string,
): Promise<AccessResource[]> {
  const resolution = await resolveRecordedWorkflow(workflowRepo, id, name);
  if (resolution.status === "failed") throw resolution.error;
  const recorded = workflowAccessResource({ name, tags: {} });
  if (resolution.status === "missing") return [recorded];
  return resolution.name === name
    ? [resolution.resource]
    : [recorded, resolution.resource];
}

/**
 * The owner a stored item records: a model or, for workflow-scope data such
 * as workflow reports, a workflow (model type `workflow`).
 */
export interface RecordedOwner {
  readonly modelType: string;
  readonly modelId: string;
  readonly modelName: string;
}

/** The model type workflow-scope data is stored under. */
const WORKFLOW_OWNER_TYPE = "workflow";

/**
 * Complete access resources for items a collection returns, looked up by id
 * and memoized for one request (swamp-club#2675). Items are judged on the
 * resources that own them now — by id, not by the name recorded when they
 * were written — with every resource field present, so conditional denies
 * decide on them. An owner no longer found is judged on its recorded name,
 * as it is today.
 */
export class CanonicalResources {
  readonly #definitionRepo: DefinitionRepository;
  readonly #workflowRepo: WorkflowRepository;
  readonly #definitions = new Map<string, Promise<DefinitionLookupResult[]>>();
  #index: Promise<Map<string, DefinitionLookupResult[]>> | undefined;
  readonly #workflows = new Map<string, Promise<AccessResource[]>>();

  constructor(
    definitionRepo: DefinitionRepository,
    workflowRepo: WorkflowRepository,
  ) {
    this.#definitionRepo = definitionRepo;
    this.#workflowRepo = workflowRepo;
  }

  #definitionsById(id: string): Promise<DefinitionLookupResult[]> {
    // One scan of every definition per request, grouped by id, when the
    // repository offers it; a scan per id would make a collection of N items
    // cost N full scans.
    if (this.#definitionRepo.findAllIncludingAutoGlobal) {
      this.#index ??= this.#definitionRepo.findAllIncludingAutoGlobal().then(
        (all) => {
          const index = new Map<string, DefinitionLookupResult[]>();
          for (const entry of all) {
            const key = entry.definition.id as string;
            const owners = index.get(key);
            if (owners) owners.push(entry);
            else index.set(key, [entry]);
          }
          return index;
        },
      );
      return this.#index.then((index) => index.get(id) ?? []);
    }
    let found = this.#definitions.get(id);
    if (!found) {
      found = findDefinitionsByIdGlobal(this.#definitionRepo, id);
      this.#definitions.set(id, found);
    }
    return found;
  }

  /**
   * A model definition a collection lists, as itself: the definition with
   * that id and name, or — when none has both — every definition with the
   * id, since a copy shares its id.
   */
  async model(
    id: string,
    name: string,
    modelType: string,
  ): Promise<AccessResource[]> {
    const owners = await this.#definitionsById(id);
    const named = owners.filter((o) => o.definition.name === name);
    const chosen = named.length > 0 ? named : owners;
    if (chosen.length > 0) {
      return distinct(chosen.map((o) => modelAccessResource(o, "model")));
    }
    if (isControlPlaneModelType(modelType)) {
      return [controlPlaneRecordResource(modelType)];
    }
    return [{
      kind: "model",
      name,
      fields: modelTypeFields(name, modelType, undefined, "model"),
    }];
  }

  /**
   * Every model owning what is stored under `modelId`, as `kind`. Ids are
   * not unique and a copy shares its original's outputs and data, so each
   * definition declaring the id counts.
   */
  async modelOwners(
    modelId: string,
    modelType: string,
    recordedName: string,
    kind: ModelResourceKind,
  ): Promise<AccessResource[]> {
    const owners = await this.#definitionsById(modelId);
    if (owners.length > 0) {
      return distinct(owners.map((o) => modelAccessResource(o, kind)));
    }
    // An owner no longer found is judged on its recorded type too, so an
    // orphaned token record is never read as plain data.
    if (isControlPlaneModelType(modelType)) {
      return [controlPlaneRecordResource(modelType)];
    }
    return [{
      kind,
      name: recordedName,
      fields: modelTypeFields(recordedName, modelType, undefined, kind),
    }];
  }

  /** The workflows something recorded as workflow `id` named `name` belongs to. */
  workflowOwners(id: string, name: string): Promise<AccessResource[]> {
    const key = JSON.stringify([id, name]);
    let found = this.#workflows.get(key);
    if (!found) {
      found = recordedWorkflowOwners(this.#workflowRepo, id, name);
      this.#workflows.set(key, found);
    }
    return found;
  }

  /**
   * The resources owning a stored data item, as `data`: its models, or for
   * workflow-scope data its workflows — named by the workflow, with the
   * workflow's tags, so it has one identity wherever it is read.
   */
  async dataOwners(owner: RecordedOwner): Promise<AccessResource[]> {
    if (owner.modelType !== WORKFLOW_OWNER_TYPE) {
      return await this.modelOwners(
        owner.modelId,
        owner.modelType,
        owner.modelName,
        "data",
      );
    }
    const workflows = await this.workflowOwners(owner.modelId, owner.modelName);
    return workflows.map((workflow) => ({
      kind: "data",
      name: workflow.name,
      fields: { name: workflow.name, ns: "", tags: workflow.fields.tags ?? {} },
    }));
  }
}

/**
 * Resolves a workflow history read with `resolve` and collects what to
 * authorize: for a run, the workflows it belongs to; for a workflow, that
 * workflow and the workflows of the latest run the read will return; for an
 * ambiguous prefix, the workflows of each run it matched, looked up once per
 * recorded workflow; for an unmatched argument, the raw string as sent.
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
      case "ambiguous": {
        const owners = new Map<string, AccessResource[]>();
        const candidates: AccessResource[][] = [];
        for (const run of reference.runs) {
          const key = JSON.stringify([run.workflowId, run.workflowName]);
          let found = owners.get(key);
          if (!found) {
            found = await runOwners(workflowRepo, run);
            owners.set(key, found);
          }
          candidates.push(found);
        }
        return {
          status: "ambiguous",
          resolved,
          candidates,
          narrow: (readable) => ({
            ...resolved,
            reference: {
              kind: "ambiguous",
              ids: readable.map((i) => reference.ids[i]),
              runs: readable.map((i) => reference.runs[i]),
            },
          }),
        };
      }
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
 * nothing more. An ambiguous prefix keeps only the matches whose owners are
 * all allowed; a refused match is audited but not replied, and when none is
 * allowed the first is replied as a unique prefix of it would be
 * (swamp-club#2743). Returns what the read may proceed with, or null.
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
): T | null {
  if (access.status === "ambiguous") {
    return authorizeAmbiguous(
      socket,
      requestId,
      principal,
      action,
      access,
      ctx,
    );
  }
  const resources = access.status === "failed"
    ? kinds.map((kind) => unresolvedAccessResource(kind, rawArgument))
    : access.resources;
  for (const resource of resources) {
    if (
      !authorizeOrReject(socket, requestId, principal, action, resource, ctx)
        .allowed
    ) return null;
  }
  if (access.status === "failed") {
    sendError(
      socket,
      requestId,
      failedCode,
      sanitizeErrorForClient(access.error),
    );
    return null;
  }
  return access.resolved;
}

/**
 * Keeps the matches of an ambiguous prefix whose owners the caller may all
 * read. Each distinct owner array is decided and audited once, however many
 * matches share it, so a short prefix over a large history cannot flood the
 * audit log. The first match is decided last, so that when no other is
 * readable its refusal is the one replied.
 */
function authorizeAmbiguous<T>(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  action: Action,
  access: Extract<ReferenceAccess<T>, { status: "ambiguous" }>,
  ctx: ConnectionContext,
): T | null {
  const decided = new Map<AccessResource[], boolean>();
  const allows = (resources: AccessResource[]): boolean => {
    let allowed = decided.get(resources);
    if (allowed === undefined) {
      allowed = resources.every((resource) =>
        isAuthorized(socket, requestId, principal, action, resource, ctx)
      );
      decided.set(resources, allowed);
    }
    return allowed;
  };
  // The first match's owners are decided last, and only once: through
  // authorizeOrReject when nothing else is readable, so its refusal is the
  // one replied, and otherwise silently. Matches sharing them follow suit.
  const first = access.candidates[0];
  const others = new Set<number>();
  for (let i = 1; i < access.candidates.length; i++) {
    const owners = access.candidates[i];
    if (owners !== first && allows(owners)) others.add(i);
  }
  if (others.size === 0) {
    for (const resource of first) {
      if (
        !authorizeOrReject(socket, requestId, principal, action, resource, ctx)
          .allowed
      ) return null;
    }
  } else if (!allows(first)) {
    return access.narrow([...others]);
  }
  const readable = access.candidates.flatMap((owners, i) =>
    owners === first || others.has(i) ? [i] : []
  );
  return access.narrow(readable);
}

/** A {@link CanonicalResources} for one request on `ctx`'s repository. */
export function canonicalResources(ctx: ConnectionContext): CanonicalResources {
  return new CanonicalResources(
    ctx.repoContext.definitionRepo,
    ctx.repoContext.workflowRepo,
  );
}
