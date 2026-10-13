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
 * The behavior spelling of audit filters (swamp-club#3334). Audit events are
 * stored with the model spelling (`model.method.run`, resource kind `model`),
 * and swamp keeps writing it. A filter, alert rule or policy rule written with
 * the behavior spelling is read in the model spelling when it is matched, so
 * both spellings select the same events. Nothing here rewrites a stored event
 * or the serve config file a rule was read from.
 */

import {
  BEHAVIOR_AUDIT_ACTION_PREFIX,
  BEHAVIOR_AUDIT_RESOURCE_PREFIX,
  canonicalResourceKind,
  MODEL_AUDIT_ACTION_PREFIX,
  MODEL_AUDIT_RESOURCE_PREFIX,
  replacePrefix,
} from "../terminology/behavior_aliases.ts";

/** An audit action in the stored spelling: `behavior.` becomes `model.`. */
export function canonicalAuditAction(action: string): string {
  return replacePrefix(
    action,
    BEHAVIOR_AUDIT_ACTION_PREFIX,
    MODEL_AUDIT_ACTION_PREFIX,
  );
}

/**
 * An audit resource filter (`<kind>:<name>`) in the stored spelling:
 * `behavior:` becomes `model:`.
 */
export function canonicalAuditResource(resource: string): string {
  return replacePrefix(
    resource,
    BEHAVIOR_AUDIT_RESOURCE_PREFIX,
    MODEL_AUDIT_RESOURCE_PREFIX,
  );
}

/** An audit resource kind in the stored spelling: `behavior` becomes `model`. */
export function canonicalAuditResourceKind(kind: string): string {
  return canonicalResourceKind(kind);
}

/** `value` passed through `canonical` when it is set. */
export function canonicalOptional(
  value: string | undefined,
  canonical: (value: string) => string,
): string | undefined {
  return value === undefined ? undefined : canonical(value);
}
