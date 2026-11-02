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
  readonly scope?: "kind";
  // a request whose method cannot be known, which any method of a scoped allow
  // could have made; set only by datastore commit authorization
  readonly anyMethod?: true;
}

/**
 * a kind-level check reads no resource, so a condition needing a resource field
 * decides nothing; a check that reads resources must authorize those resources
 * instead
 */
export function kindResource(kind: ResourceKind): AccessResource {
  return { kind, name: "*", fields: { name: "*" }, scope: "kind" };
}

export interface AccessDecision {
  readonly effect: "allow" | "deny";
  readonly grantId: string;
  readonly subject: Subject;
  readonly condition?: string;
  readonly impliedBy?: "run" | "write";
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
   * any applicable deny for the kind and action refuses the operation, whatever
   * its pattern or condition, since it reaches every resource
   */
  decideAll(
    principal: AccessPrincipal,
    action: Action,
    kind: ResourceKind,
  ): AccessDecision | null;
}
