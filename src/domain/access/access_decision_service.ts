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

import type { Action } from "./action.ts";
import type { Principal } from "./principal.ts";
import type { ResourceKind } from "./resource_selector.ts";
import type { Subject } from "./subject.ts";

export interface AccessPrincipal {
  readonly principal: Principal;
  readonly collectives: readonly string[];
  readonly groups: readonly string[];
}

export interface AccessResource {
  readonly kind: ResourceKind;
  readonly name: string;
  readonly fields: Record<string, unknown>;
  /**
   * `kind` when the check is on the kind itself rather than on resources of
   * it (see {@link kindResource}). Absent for a resource.
   */
  readonly scope?: "kind";
}

/**
 * A check on a resource kind as a whole — an extension, datastore or type
 * endpoint that reads no resource of the kind. A condition that needs a
 * resource field decides nothing here, since no resource is touched; a check
 * that reads resources must authorize those resources instead
 * (swamp-club#2675).
 */
export function kindResource(kind: ResourceKind): AccessResource {
  return { kind, name: "*", fields: { name: "*" }, scope: "kind" };
}

export interface AccessDecision {
  readonly effect: "allow" | "deny";
  readonly grantId: string;
  readonly subject: Subject;
  readonly condition?: string;
  /**
   * Set when the grant matched `approve` or `signal` only because it grants
   * `run`, not because it names the action itself.
   */
  readonly impliedBy?: "run";
}

export interface AccessDecisionService {
  decide(
    principal: AccessPrincipal,
    action: Action,
    resource: AccessResource,
  ): AccessDecision | null;

  explain(
    principal: AccessPrincipal,
    action: Action,
    resource: AccessResource,
  ): AccessDecision[];

  hasAnyGrantForKind(
    principal: AccessPrincipal,
    action: Action,
    kind: ResourceKind,
  ): boolean;

  /**
   * Decides an operation over every resource of `kind` that cannot be
   * filtered per resource (garbage collection, prune, summarise). Any
   * applicable deny for the kind and action refuses it, whatever its pattern
   * or condition, since the operation reaches every resource.
   */
  decideAll(
    principal: AccessPrincipal,
    action: Action,
    kind: ResourceKind,
  ): AccessDecision | null;
}
