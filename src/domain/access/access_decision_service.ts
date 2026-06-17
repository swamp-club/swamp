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
}

export interface AccessResource {
  readonly kind: ResourceKind;
  readonly name: string;
  readonly fields: Record<string, unknown>;
}

export interface AccessDecision {
  readonly effect: "allow" | "deny";
  readonly grantId: string;
  readonly subject: Subject;
  readonly condition?: string;
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
}
