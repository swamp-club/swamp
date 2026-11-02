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
 * audit events are stored in the model spelling; behavior-spelled filters and
 * rules are read as model spelling when matched, and nothing rewrites stored
 * events or config
 */

import {
  BEHAVIOR_AUDIT_ACTION_PREFIX,
  BEHAVIOR_AUDIT_RESOURCE_PREFIX,
  canonicalResourceKind,
  MODEL_AUDIT_ACTION_PREFIX,
  MODEL_AUDIT_RESOURCE_PREFIX,
  replacePrefix,
} from "../terminology/behavior_aliases.ts";

export function canonicalAuditAction(action: string): string {
  return replacePrefix(
    action,
    BEHAVIOR_AUDIT_ACTION_PREFIX,
    MODEL_AUDIT_ACTION_PREFIX,
  );
}

export function canonicalAuditResource(resource: string): string {
  return replacePrefix(
    resource,
    BEHAVIOR_AUDIT_RESOURCE_PREFIX,
    MODEL_AUDIT_RESOURCE_PREFIX,
  );
}

export function canonicalAuditResourceKind(kind: string): string {
  return canonicalResourceKind(kind);
}

export function canonicalOptional(
  value: string | undefined,
  canonical: (value: string) => string,
): string | undefined {
  return value === undefined ? undefined : canonical(value);
}
