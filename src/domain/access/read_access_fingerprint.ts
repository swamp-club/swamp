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
 * changes whenever a read decision for the principal could, else stays the
 * same; inputs are the principal, its client, its groups, its read or admin
 * grants reduced to decision fields, and the restricted types. A SHA-256 digest
 */

import { createHash } from "node:crypto";
import type { Grant } from "../models/access/grant_model.ts";
import type { AccessPrincipal } from "./access_decision_service.ts";
import type { Action } from "./action.ts";
import { principalToString } from "./principal.ts";

/**
 * bumped when the inputs change shape or the same inputs decide differently, so
 * a copy filtered under the old rule resets
 */
const FINGERPRINT_FORMAT = 4;

const READ_ACTIONS: readonly Action[] = ["read", "admin"];

export function readAccessFingerprint(
  principal: AccessPrincipal,
  localGroups: readonly string[],
  grants: readonly Grant[],
  restrictedTypes: readonly string[],
): string {
  const canonical = JSON.stringify([
    FINGERPRINT_FORMAT,
    principalToString(principal.principal),
    [...principal.collectives].sort(),
    [...principal.groups].sort(),
    [...localGroups].sort(),
    grants
      .filter((grant) =>
        grant.actions.some((action) => READ_ACTIONS.includes(action))
      )
      .map(decisionFields)
      .sort(compareJson),
    [...new Set(restrictedTypes)].sort(),
    principal.client ?? null,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

function decisionFields(grant: Grant): string {
  return JSON.stringify([
    grant.id,
    grant.state,
    grant.subject.kind,
    grant.subject.name,
    grant.effect,
    [...grant.actions].sort(),
    grant.resource.kind,
    grant.resource.pattern,
    grant.methods === undefined ? null : [...grant.methods].sort(),
    grant.condition ?? null,
  ]);
}

function compareJson(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
