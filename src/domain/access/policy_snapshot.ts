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

import type { Grant } from "../models/access/grant_model.ts";
import type { Group } from "../models/access/group_model.ts";
import type { PrincipalContext } from "./principal_context.ts";
import { principalToString } from "./principal.ts";
import type { ResourceKind } from "./resource_selector.ts";
import { subjectToString } from "./subject.ts";

export type ConditionEvaluator = (
  condition: string,
  resourceKind: ResourceKind,
  resourceFields: Record<string, unknown>,
  principalContext: PrincipalContext,
) => boolean;

function alwaysFalse(): boolean {
  return false;
}

export class PolicySnapshot {
  readonly #grantsBySubject: Map<string, Grant[]>;
  readonly #groupsByPrincipal: Map<string, string[]>;
  readonly #evaluateCondition: ConditionEvaluator;

  constructor(
    grants: readonly Grant[],
    groups: readonly Group[],
    evaluateCondition?: ConditionEvaluator,
  ) {
    this.#evaluateCondition = evaluateCondition ?? alwaysFalse;

    this.#grantsBySubject = new Map();
    for (const grant of grants) {
      const key = subjectToString(grant.subject);
      const existing = this.#grantsBySubject.get(key);
      if (existing) {
        existing.push(grant);
      } else {
        this.#grantsBySubject.set(key, [grant]);
      }
    }

    this.#groupsByPrincipal = new Map();
    for (const group of groups) {
      for (const member of group.members) {
        const key = principalToString(member);
        const existing = this.#groupsByPrincipal.get(key);
        if (existing) {
          existing.push(group.name);
        } else {
          this.#groupsByPrincipal.set(key, [group.name]);
        }
      }
    }
  }

  grantsForSubjects(subjects: readonly string[]): Grant[] {
    const result: Grant[] = [];
    for (const subject of subjects) {
      const grants = this.#grantsBySubject.get(subject);
      if (grants) {
        result.push(...grants);
      }
    }
    return result;
  }

  groupsForPrincipal(principalKey: string): readonly string[] {
    return this.#groupsByPrincipal.get(principalKey) ?? [];
  }

  evaluateCondition(
    condition: string,
    resourceKind: ResourceKind,
    resourceFields: Record<string, unknown>,
    principalContext: PrincipalContext,
  ): boolean {
    return this.#evaluateCondition(
      condition,
      resourceKind,
      resourceFields,
      principalContext,
    );
  }

  static empty(): PolicySnapshot {
    return new PolicySnapshot([], []);
  }
}
