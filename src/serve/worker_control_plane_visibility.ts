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
  normalizeModelTypeName,
} from "../domain/models/control_plane_types.ts";
import { FLEET_PROBE_MODEL_TYPE } from "../domain/models/worker/fleet_probe_model.ts";
import type { ActiveDispatch } from "./dispatch_registry.ts";

/**
 * only the fleet probe may read its own swamp/fleet-probe records from a
 * worker; no other control-plane type is readable, even if later made
 * dispatchable
 */
const WORKER_READABLE_CONTROL_PLANE_TYPES: readonly string[] = [
  FLEET_PROBE_MODEL_TYPE.normalized,
];

/**
 * every control-plane type is hidden in any spelling, except an allowlisted
 * type read by a dispatch of that same type; with no resolved dispatch all are
 * hidden
 */
export function isHiddenFromWorker(
  type: string,
  dispatch: ActiveDispatch | null,
): boolean {
  if (!isControlPlaneModelType(type)) return false;
  if (dispatch === null) return true;
  const key = normalizeModelTypeName(type);
  return !(
    key !== null &&
    WORKER_READABLE_CONTROL_PLANE_TYPES.includes(key) &&
    normalizeModelTypeName(dispatch.modelType.normalized) === key
  );
}

export function workerHiddenStoredTypes(
  dispatch: ActiveDispatch | null,
): string[] {
  return CONTROL_PLANE_STORED_TYPES.filter((type) =>
    isHiddenFromWorker(type, dispatch)
  );
}
