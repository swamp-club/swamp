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

import { getLogger } from "@logtape/logtape";
import type { Grant } from "../models/access/grant_model.ts";
import type { Group } from "../models/access/group_model.ts";
import type { PrincipalContext } from "./principal_context.ts";
import { principalToString } from "./principal.ts";
import type { ResourceKind } from "./resource_selector.ts";
import { subjectToString } from "./subject.ts";
import { MissingConditionFieldError } from "./condition_fields.ts";

const logger = getLogger(["swamp", "domain", "access", "policy-snapshot"]);

export type ConditionEvaluator = (
  condition: string,
  resourceKind: ResourceKind,
  resourceFields: Record<string, unknown>,
  principalContext: PrincipalContext,
) => boolean;

function alwaysFalse(): boolean {
  return false;
}

/**
 * How a grant condition evaluated. `missing-field` means the condition needs
 * a resource field the resource does not carry (swamp-club#2675).
 */
export type ConditionOutcome = "match" | "no-match" | "missing-field" | "error";

export class PolicySnapshot {
  readonly #grantsBySubject: Map<string, Grant[]>;
  readonly #groupsByPrincipal: Map<string, string[]>;
  readonly #evaluateCondition: ConditionEvaluator;
  /** Resource kinds some grant names, computed once per snapshot. */
  readonly #grantKinds: ReadonlySet<ResourceKind>;

  constructor(
    grants: readonly Grant[],
    groups: readonly Group[],
    evaluateCondition?: ConditionEvaluator,
  ) {
    this.#evaluateCondition = evaluateCondition ?? alwaysFalse;

    this.#grantKinds = new Set(grants.map((grant) => grant.resource.kind));
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

  /**
   * Whether any grant in the snapshot, for any subject, names `kind`
   * (swamp-club#2676). Computed once when the snapshot is built.
   */
  hasGrantOfKind(kind: ResourceKind): boolean {
    return this.#grantKinds.has(kind);
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
    return this.evaluateConditionOutcome(
      condition,
      resourceKind,
      resourceFields,
      principalContext,
    ) === "match";
  }

  /**
   * Like {@link evaluateCondition}, but tells a condition that evaluated
   * false apart from one that could not be evaluated. A caller that would
   * otherwise allow by default must not read an error as "no match".
   */
  evaluateConditionOutcome(
    condition: string,
    resourceKind: ResourceKind,
    resourceFields: Record<string, unknown>,
    principalContext: PrincipalContext,
  ): ConditionOutcome {
    const deadline = Date.now() + 100;
    try {
      const result = this.#evaluateCondition(
        condition,
        resourceKind,
        resourceFields,
        principalContext,
      );
      if (Date.now() > deadline) {
        logger.warn`Condition evaluation exceeded 100ms deadline: ${condition}`;
      }
      return result ? "match" : "no-match";
    } catch (error) {
      if (error instanceof MissingConditionFieldError) {
        logger
          .debug`Condition ${condition} needs missing field(s) ${
          error.fields.join(", ")
        }`;
        return "missing-field";
      }
      // A tag the resource does not carry, or a variable it lacks, is an
      // expected outcome of a tag condition, not a fault: log it quietly.
      if (
        error instanceof Error &&
        (error.message.startsWith("Unknown variable:") ||
          error.message.startsWith("No such key:"))
      ) {
        logger.debug`Condition evaluation skipped for ${condition}: ${error}`;
      } else {
        logger.warn`Condition evaluation failed for ${condition}: ${error}`;
      }
      return "error";
    }
  }

  static empty(): PolicySnapshot {
    return new PolicySnapshot([], []);
  }
}
