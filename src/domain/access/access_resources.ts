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
import { isControlPlaneModelType } from "../models/control_plane_types.ts";
import type { DefinitionOwner } from "../definitions/repositories.ts";
import { ModelType } from "../models/model_type.ts";
import type { Workflow } from "../workflows/workflow.ts";

export type ModelResourceKind = "model" | "data";

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

export function vaultKindResource(name: string, key?: string): AccessResource {
  return {
    kind: "vault",
    name,
    fields: { name, ...(key !== undefined ? { key } : {}) },
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
