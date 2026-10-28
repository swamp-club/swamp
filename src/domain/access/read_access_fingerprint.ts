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
 * A fingerprint of what one principal may read (swamp-club#4089). Serve
 * sends it with every datastore API reply, and a team member's serve-mode
 * copy resets when it changes, so a widened or narrowed grant refreshes
 * what the copy holds.
 *
 * It changes whenever any read decision for the principal could change,
 * and stays the same otherwise. Serve's read filter decides only `read`
 * and `admin` (an undecided resource is allowed for an admin), and no
 * other action implies either, so the inputs are:
 *
 * - the principal, and the collectives and IdP groups it authenticated
 *   with: grant conditions read them, and the groups pick its grants;
 * - its groups in the snapshot;
 * - every grant for those subjects that names `read` or `admin`, reduced
 *   to the fields a decision reads.
 * - serve's restricted behavior types (`--restricted-model-types`), which
 *   only an admin may read: a restart with another list changes what a
 *   member may read without changing a grant. Control-plane types are code
 *   constants, so they change only with a release, which bumps the format.
 *
 * Grants of other subjects, timestamps, authorship and the snapshot's
 * version are left out, so a reload that does not touch the principal
 * keeps it. It is a SHA-256 digest, so it does not spell out the grants.
 *
 * @module
 */

import { createHash } from "node:crypto";
import type { Grant } from "../models/access/grant_model.ts";
import type { AccessPrincipal } from "./access_decision_service.ts";
import type { Action } from "./action.ts";
import { principalToString } from "./principal.ts";

/** Bumped when the inputs change shape, so old and new never compare equal. */
const FINGERPRINT_FORMAT = 2;

/** The actions serve's read filter decides. */
const READ_ACTIONS: readonly Action[] = ["read", "admin"];

/**
 * The read-access fingerprint of `principal`, whose groups in the policy
 * snapshot are `localGroups` and whose subjects hold `grants`, under serve's
 * `restrictedTypes`: a lowercase hex SHA-256 digest.
 * `GrantBasedAccessDecisionService.readAccessFingerprint` resolves the
 * groups and grants as its decisions do.
 */
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
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The fields of `grant` a decision reads, as a JSON string in a fixed
 * order: its id, state, subject, effect, actions, selector, methods and
 * condition.
 */
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
