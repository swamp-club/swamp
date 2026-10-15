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
  CONTROL_PLANE_STORED_TYPES,
  isControlPlaneModelType,
} from "../models/control_plane_types.ts";

/**
 * Every stored type name data retention never deletes: the control-plane
 * types (server tokens, grants, groups, enrollment tokens, workers, step
 * leases, pending dispatches, fleet probes), each bare and with its `@`
 * prefix, since the access commands store grants and groups as
 * `@swamp/grant` and `@swamp/group`. Deleting a grant or token would lock
 * users out; token GC, worker GC and bookkeeping reap these records.
 */
export const RETENTION_EXEMPT_MODEL_TYPES: readonly string[] =
  CONTROL_PLANE_STORED_TYPES;

/**
 * True when data of this model type is never deleted by data retention.
 * Normalizes the type first, so any spelling of a control-plane type
 * matches.
 */
export function isRetentionExempt(modelType: string): boolean {
  return isControlPlaneModelType(modelType);
}
