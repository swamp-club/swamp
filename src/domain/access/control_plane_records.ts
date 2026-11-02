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
 * authorized as the access kind named by the full normalized model type, so it
 * never collides with access request resources and a trailing-* selector covers
 * it; fields are the record's own
 */
export function controlPlaneRecordResource(
  type: string,
  record: { name: string; tags?: Record<string, string> },
): AccessResource {
  const name = normalizeModelTypeName(type);
  if (name === null) throw new Error("Behavior type cannot be empty");
  return {
    kind: "access",
    name,
    fields: { name: record.name, modelType: name, tags: record.tags ?? {} },
  };
}

/**
 * every action on a control-plane record is decided as admin: reading, writing
 * or running one is managing access
 */
export function isControlPlaneRecordResource(
  resource: AccessResource,
): boolean {
  return resource.kind === "access" &&
    CONTROL_PLANE_MODEL_TYPES.includes(resource.name);
}
