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

import {
  CONTROL_PLANE_MODEL_TYPES,
  normalizeModelTypeName,
} from "../models/control_plane_types.ts";
import type { AccessResource } from "./access_decision_service.ts";

/**
 * The access resource a control-plane record is authorized as, whatever
 * request reaches it: the `access` kind, named by the record's normalized
 * model type (e.g. `access:swamp/grant`). The full type is the name so it
 * never collides with the access resources access requests use
 * (`access:grant`, `access:group`, `access:*`, `access:<request type>`),
 * and a trailing-`*` selector such as `access:*` or `access:swamp/*` covers
 * it. The fields are the record's own — its model's name, type and tags — so
 * a condition naming one grant or token still decides on that record
 * (swamp-club#2756).
 */
export function controlPlaneRecordResource(
  type: string,
  record: { name: string; tags?: Record<string, string> },
): AccessResource {
  const name = normalizeModelTypeName(type);
  if (name === null) throw new Error("Model type cannot be empty");
  return {
    kind: "access",
    name,
    fields: { name: record.name, modelType: name, tags: record.tags ?? {} },
  };
}

/**
 * Whether `resource` is a control-plane record resource. Every action on one
 * is decided as `admin`: reading, writing or running a grant, token or
 * worker record is managing access (swamp-club#2756).
 */
export function isControlPlaneRecordResource(
  resource: AccessResource,
): boolean {
  return resource.kind === "access" &&
    CONTROL_PLANE_MODEL_TYPES.includes(resource.name);
}
