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

import { controlPlaneRecordResource } from "./control_plane_records.ts";
import type { AccessResource } from "./access_decision_service.ts";
import type { Action } from "./action.ts";
import { isControlPlaneModelType } from "../models/control_plane_types.ts";
import { parsePrincipal } from "./principal.ts";
import type { DefinitionOwner } from "../definitions/repositories.ts";
import { ModelType } from "../models/model_type.ts";
import type { Workflow } from "../workflows/workflow.ts";

export type ModelResourceKind = "model" | "data";

export const RUN_CONDITION_FIELD = "run";

export interface RunConditionValue {
  readonly initiator: {
    readonly kind: string;
    readonly id: string;
    /** a person's id, empty for a service: no person started it, and no id is empty */
    readonly sub: string;
  };
  readonly serveDriven: boolean;
}

/** undefined when the run names no usable initiator, so conditions on it fail closed */
export function runConditionValue(
  run: { readonly initiatedBy?: string; readonly serveDriven: boolean },
): RunConditionValue | undefined {
  if (run.initiatedBy === undefined) return undefined;
  let kind: string;
  let id: string;
  try {
    ({ kind, id } = parsePrincipal(run.initiatedBy));
  } catch {
    return undefined;
  }
  return {
    initiator: { kind, id, sub: kind === "user" ? id : "" },
    serveDriven: run.serveDriven,
  };
}

export function withRunCondition(
  resource: AccessResource,
  run: { readonly initiatedBy?: string; readonly serveDriven: boolean },
): AccessResource {
  const value = runConditionValue(run);
  const { pending: _pending, ...decided } = resource;
  return value === undefined ? decided : {
    ...decided,
    fields: { ...resource.fields, [RUN_CONDITION_FIELD]: value },
  };
}

/** for an approve decision made before the run is read */
export function withRunPending(resource: AccessResource): AccessResource {
  return { ...resource, pending: [RUN_CONDITION_FIELD] };
}

/** an explanation names no run, so it says which decisions depend on one */
export function explainedForAction(
  resource: AccessResource,
  action: Action,
): AccessResource {
  return action === "approve" && resource.kind === "workflow" &&
      !(RUN_CONDITION_FIELD in resource.fields)
    ? withRunPending(resource)
    : resource;
}

/**
 * every resource field of the kind is present, empty when none: a deny needing
 * a field the resource lacks fails closed, so an untagged resource must say it
 * has no tags
 */
export function modelTypeFields(
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
 * a control-plane model is owned by the access kind, whichever kind was asked
 * for
 */
export function modelAccessResource(
  result: DefinitionOwner,
  kind: ModelResourceKind = "model",
): AccessResource {
  if (isControlPlaneModelType(result.type.normalized)) {
    return controlPlaneRecordResource(result.type.normalized, {
      name: result.definition.name,
      tags: result.definition.tags,
    });
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

export function workflowAccessResource(
  workflow: Pick<Workflow, "name" | "tags">,
): AccessResource {
  return {
    kind: "workflow",
    name: workflow.name,
    fields: { name: workflow.name, tags: workflow.tags ?? {} },
  };
}

export function unresolvedAccessResource(
  kind: AccessResource["kind"],
  idOrName: string,
): AccessResource {
  const fields: Record<string, unknown> = { name: idOrName };
  if (kind !== "access") fields.tags = {};
  if (kind === "data") fields.ns = "";
  return { kind, name: idOrName, fields };
}

export const VAULT_METHODS = [
  "get",
  "describe",
  "inspect",
  "list-keys",
  "read-secret",
  "audit-trail",
  "search",
  "put",
  "delete",
  "annotate",
  "create",
  "edit",
  "migrate",
] as const;

export type VaultMethod = typeof VAULT_METHODS[number];

export function isVaultMethod(value: string): value is VaultMethod {
  return (VAULT_METHODS as readonly string[]).includes(value);
}

export function vaultKindResource(
  name: string,
  key?: string,
  methodName?: VaultMethod,
): AccessResource {
  return {
    kind: "vault",
    name,
    fields: {
      name,
      ...(key !== undefined ? { key } : {}),
      ...(methodName !== undefined ? { methodName } : {}),
    },
  };
}

export function tagsChanged(
  before: Readonly<Record<string, string>> | undefined,
  after: Readonly<Record<string, string>> | undefined,
): boolean {
  const a = before ?? {};
  const b = after ?? {};
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return true;
  return keys.some((key) => !Object.hasOwn(b, key) || a[key] !== b[key]);
}
