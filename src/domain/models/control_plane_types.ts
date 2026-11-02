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

import { ModelType } from "./model_type.ts";

/**
 * control-plane records live beside user models but are never user data: hidden
 * from discovery, treated as live by prune, owned by the access kind when
 * served, unreadable from expressions
 */
export const CONTROL_PLANE_MODEL_TYPES: readonly string[] = [
  "swamp/enrollment-token",
  "swamp/worker",
  "swamp/step-lease",
  "swamp/pending-dispatch",
  "swamp/fleet-probe",
  "swamp/server-token",
  "swamp/grant",
  "swamp/group",
];

/**
 * ModelType keeps a leading @ and access commands write @swamp/grant, so an
 * exclusion that compares stored types as strings must name both forms
 */
export const CONTROL_PLANE_STORED_TYPES: readonly string[] =
  CONTROL_PLANE_MODEL_TYPES.flatMap((type) => [type, `@${type}`]);

/**
 * ModelType normalizes first, so whitespace and separators are trimmed before
 * the @ is found; the result is a fixed point, so authorization can compare any
 * two spellings by this key
 */
export function normalizeModelTypeName(type: string): string | null {
  let normalized: string;
  try {
    normalized = ModelType.create(type).normalized;
  } catch {
    // Blank, or only separators ("/", "::", "."): not a model type.
    return null;
  }
  const stripped = normalized.replace(/^[@/]+/, "");
  return stripped.length > 0 ? stripped : null;
}

export function isControlPlaneModelType(type: string): boolean {
  const normalized = normalizeModelTypeName(type);
  return normalized !== null && CONTROL_PLANE_MODEL_TYPES.includes(normalized);
}
