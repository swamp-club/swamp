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
 * The access resources grants are judged against, built from the resources
 * they name: a model definition, a workflow, a vault, or a name that matches
 * nothing. Serve requests and the local `swamp access check` build them here,
 * so both judge a resource by the same fields (swamp-club#3224).
 */

import { controlPlaneRecordResource } from "./control_plane_records.ts";
import type { AccessResource } from "./access_decision_service.ts";
import { isControlPlaneModelType } from "../models/control_plane_types.ts";
import type { DefinitionLookupResult } from "../models/model_lookup.ts";
import { ModelType } from "../models/model_type.ts";
import type { Workflow } from "../workflows/workflow.ts";

/** Which resource kind a model reference is authorized as. */
export type ModelResourceKind = "model" | "data";

/**
 * The resource fields a model or data resource of `type` carries, as `kind`.
 * Every resource field of the kind is present, empty when the resource has
 * none (tags `{}`, ns `""`): a deny that needs a field the resource lacks
 * fails closed, so an untagged resource must say it has no tags
 * (swamp-club#2675).
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
 * The access resource for a model definition, authorized as `kind`. A
 * control-plane model (a grant, group, token or worker record) is owned by
 * the access kind instead, whichever kind was asked for (swamp-club#2756).
 */
export function modelAccessResource(
  result: DefinitionLookupResult,
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

/**
 * The vault resource `vault:<name>` (swamp-club#2676). `key` is the secret a
 * request names; without one a `key` condition sees "".
 */
export function vaultKindResource(name: string, key?: string): AccessResource {
  return {
    kind: "vault",
    name,
    fields: { name, ...(key !== undefined ? { key } : {}) },
  };
}
