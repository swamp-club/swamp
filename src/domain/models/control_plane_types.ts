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
 * The built-in model types swamp's control plane stores its own records
 * under: access control (grants, groups, server tokens) and the worker fleet
 * (enrollment tokens, workers, step leases, pending dispatches, fleet
 * probes). Their definitions and data live in the repository beside user
 * models, but they are never user data: they are hidden from discovery,
 * treated as live by prune, owned by the `access` kind when served
 * (swamp-club#2756), and unreadable from expressions.
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
 * Every `type_normalized` value a control-plane record can be stored under:
 * each type bare and with its `@` prefix. ModelType keeps a leading `@`, and
 * the access commands write grants and groups as `@swamp/grant` and
 * `@swamp/group`, so an exclusion that compares stored types as strings must
 * name both forms (swamp-club#2756).
 */
export const CONTROL_PLANE_STORED_TYPES: readonly string[] =
  CONTROL_PLANE_MODEL_TYPES.flatMap((type) => [type, `@${type}`]);

/**
 * The normalized form of a model type string, as ModelType normalizes it,
 * with a leading `@` dropped; null for a string that normalizes to nothing.
 */
export function normalizeModelTypeName(type: string): string | null {
  const stripped = type.startsWith("@") ? type.slice(1) : type;
  try {
    return ModelType.create(stripped).normalized;
  } catch {
    // Blank, or only separators ("/", "::", "."): not a model type.
    return null;
  }
}

/**
 * Whether `type` names a control-plane model type. The type is normalized
 * first, so casing, separator and `@` variants of a control-plane type all
 * match.
 */
export function isControlPlaneModelType(type: string): boolean {
  const normalized = normalizeModelTypeName(type);
  return normalized !== null && CONTROL_PLANE_MODEL_TYPES.includes(normalized);
}
