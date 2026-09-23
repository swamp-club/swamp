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
import type {
  AccessDecision,
  AccessDecisionService,
  AccessPrincipal,
  AccessResource,
} from "./access_decision_service.ts";
import type { Action } from "./action.ts";
import type { PolicySnapshot } from "./policy_snapshot.ts";
import { principalToString } from "./principal.ts";
import type { PrincipalContext } from "./principal_context.ts";
import {
  type ResourceKind,
  resourceSelectorMatches,
} from "./resource_selector.ts";

export const MAX_AGGREGATE_CONDITIONS = 100;

const logger = getLogger([
  "swamp",
  "domain",
  "access",
  "decision-service",
]);

function resolveSubjects(
  accessPrincipal: AccessPrincipal,
  localGroups: readonly string[],
): string[] {
  const subjects: string[] = [];

  subjects.push(
    `${accessPrincipal.principal.kind}:${accessPrincipal.principal.id}`,
  );

  for (const groupName of localGroups) {
    subjects.push(`group:${groupName}`);
  }

  for (const group of accessPrincipal.groups) {
    subjects.push(`idp-group:${group}`);
  }

  return subjects;
}

function grantMatchesResource(grant: Grant, resource: AccessResource): boolean {
  if (grant.resource.kind !== resource.kind) {
    return false;
  }
  if (resourceSelectorMatches(grant.resource, resource.name)) {
    return true;
  }
  // For model resources, also match against the extension type so that
  // namespace-scoped grants like model:@scope/* cover model instances
  // whose type falls under that namespace.
  if (
    resource.kind === "model" &&
    typeof resource.fields.modelType === "string"
  ) {
    return resourceSelectorMatches(grant.resource, resource.fields.modelType);
  }
  return false;
}

export interface GrantBasedAccessDecisionServiceOptions {
  /**
   * Whether an allow grant for `run` also satisfies `approve`. Defaults to
   * true, the original semantics. A deny grant for `run` denies `approve`
   * regardless, so turning this off can only narrow what is allowed.
   */
  readonly runImpliesApprove?: boolean;
}

/** An action a grant covers, and whether it is covered only through `run`. */
export interface ActionCoverage {
  readonly action: Action;
  readonly impliedBy?: "run";
}

/** How a grant matched a requested action, or null when it did not. */
type ActionMatch = "direct" | "implied-by-run" | null;

function grantMatchesAction(
  grant: Grant,
  action: Action,
  runImpliesApprove: boolean,
): ActionMatch {
  if (grant.actions.includes(action)) return "direct";
  if (action === "approve" && grant.actions.includes("run")) {
    if (grant.effect === "deny" || runImpliesApprove) return "implied-by-run";
  }
  return null;
}

function grantMatchesMethods(
  grant: Grant,
  resource: AccessResource,
): boolean {
  if (!grant.methods || grant.methods.length === 0) return true;
  const methodName = resource.fields.methodName;
  if (typeof methodName !== "string") return true;
  return grant.methods.includes(methodName);
}

function buildPrincipalContext(
  accessPrincipal: AccessPrincipal,
  localGroups: readonly string[],
): PrincipalContext {
  return {
    sub: accessPrincipal.principal.id,
    groups: [...localGroups],
    collectives: [...accessPrincipal.collectives],
  };
}

function evaluateGrant(
  grant: Grant,
  snapshot: PolicySnapshot,
  resource: AccessResource,
  principalContext: PrincipalContext,
): boolean {
  if (!grant.condition) {
    return true;
  }
  return snapshot.evaluateCondition(
    grant.condition,
    resource.kind,
    resource.fields,
    principalContext,
  );
}

interface MatchedGrant {
  readonly grant: Grant;
  readonly match: ActionMatch;
}

function toDecision(grant: Grant, match: ActionMatch): AccessDecision {
  return {
    effect: grant.effect,
    grantId: grant.id,
    subject: grant.subject,
    condition: grant.condition,
    ...(match === "implied-by-run" ? { impliedBy: "run" as const } : {}),
  };
}

export class GrantBasedAccessDecisionService implements AccessDecisionService {
  #snapshot: PolicySnapshot;
  readonly #runImpliesApprove: boolean;

  constructor(
    snapshot: PolicySnapshot,
    options: GrantBasedAccessDecisionServiceOptions = {},
  ) {
    this.#snapshot = snapshot;
    this.#runImpliesApprove = options.runImpliesApprove ?? true;
  }

  get runImpliesApprove(): boolean {
    return this.#runImpliesApprove;
  }

  /**
   * The actions a grant covers under this service's policy: the grant's own
   * actions in order, then `approve` when the grant covers it only through
   * `run`.
   */
  actionsCoveredBy(grant: Grant): ActionCoverage[] {
    const covered: ActionCoverage[] = grant.actions.map((action) => ({
      action,
    }));
    if (
      grantMatchesAction(grant, "approve", this.#runImpliesApprove) ===
        "implied-by-run"
    ) {
      covered.push({ action: "approve", impliedBy: "run" });
    }
    return covered;
  }

  get snapshot(): PolicySnapshot {
    return this.#snapshot;
  }

  set snapshot(snapshot: PolicySnapshot) {
    this.#snapshot = snapshot;
  }

  decide(
    principal: AccessPrincipal,
    action: Action,
    resource: AccessResource,
  ): AccessDecision | null {
    const snapshot = this.#snapshot;
    const principalKey = principalToString(principal.principal);
    const localGroups = snapshot.groupsForPrincipal(principalKey);
    const subjects = resolveSubjects(principal, localGroups);
    const candidates = snapshot.grantsForSubjects(subjects);
    const principalContext = buildPrincipalContext(principal, localGroups);

    const denies: MatchedGrant[] = [];
    const allows: MatchedGrant[] = [];
    for (const grant of candidates) {
      if (!grantMatchesResource(grant, resource)) continue;
      const match = grantMatchesAction(grant, action, this.#runImpliesApprove);
      if (!match) continue;
      if (!grantMatchesMethods(grant, resource)) continue;
      if (grant.effect === "deny") {
        denies.push({ grant, match });
      } else {
        allows.push({ grant, match });
      }
    }

    let conditionsEvaluated = 0;

    for (const { grant, match } of denies) {
      if (grant.condition) {
        conditionsEvaluated++;
        if (conditionsEvaluated > MAX_AGGREGATE_CONDITIONS) {
          logger
            .warn`Aggregate condition budget exceeded (${conditionsEvaluated} > ${MAX_AGGREGATE_CONDITIONS}) for principal ${principalKey} action ${action} on ${resource.kind}:${resource.name} — denying`;
          return {
            effect: "deny",
            grantId: "aggregate-budget-exceeded",
            subject: { kind: "user", name: principal.principal.id },
          };
        }
      }
      if (evaluateGrant(grant, snapshot, resource, principalContext)) {
        return toDecision(grant, match);
      }
    }

    for (const { grant, match } of allows) {
      if (grant.condition) {
        conditionsEvaluated++;
        if (conditionsEvaluated > MAX_AGGREGATE_CONDITIONS) {
          logger
            .warn`Aggregate condition budget exceeded (${conditionsEvaluated} > ${MAX_AGGREGATE_CONDITIONS}) for principal ${principalKey} action ${action} on ${resource.kind}:${resource.name} — denying`;
          return {
            effect: "deny",
            grantId: "aggregate-budget-exceeded",
            subject: { kind: "user", name: principal.principal.id },
          };
        }
      }
      if (evaluateGrant(grant, snapshot, resource, principalContext)) {
        return toDecision(grant, match);
      }
    }

    return null;
  }

  explain(
    principal: AccessPrincipal,
    action: Action,
    resource: AccessResource,
  ): AccessDecision[] {
    const snapshot = this.#snapshot;
    const principalKey = principalToString(principal.principal);
    const localGroups = snapshot.groupsForPrincipal(principalKey);
    const subjects = resolveSubjects(principal, localGroups);
    const candidates = snapshot.grantsForSubjects(subjects);
    const principalContext = buildPrincipalContext(principal, localGroups);

    let conditionsEvaluated = 0;
    const denyDecisions: AccessDecision[] = [];
    const allowDecisions: AccessDecision[] = [];
    for (const grant of candidates) {
      if (!grantMatchesResource(grant, resource)) continue;
      const match = grantMatchesAction(grant, action, this.#runImpliesApprove);
      if (!match) continue;
      if (!grantMatchesMethods(grant, resource)) continue;
      if (grant.condition) {
        conditionsEvaluated++;
        if (conditionsEvaluated > MAX_AGGREGATE_CONDITIONS) {
          logger
            .warn`Aggregate condition budget exceeded (${conditionsEvaluated} > ${MAX_AGGREGATE_CONDITIONS}) for principal ${principalKey} action ${action} on ${resource.kind}:${resource.name} — truncating explain`;
          break;
        }
      }
      if (evaluateGrant(grant, snapshot, resource, principalContext)) {
        if (grant.effect === "deny") {
          denyDecisions.push(toDecision(grant, match));
        } else {
          allowDecisions.push(toDecision(grant, match));
        }
      }
    }

    return [...denyDecisions, ...allowDecisions];
  }

  hasAnyGrantForKind(
    principal: AccessPrincipal,
    action: Action,
    kind: ResourceKind,
  ): boolean {
    const snapshot = this.#snapshot;
    const principalKey = principalToString(principal.principal);
    const localGroups = snapshot.groupsForPrincipal(principalKey);
    const subjects = resolveSubjects(principal, localGroups);
    const candidates = snapshot.grantsForSubjects(subjects);

    for (const grant of candidates) {
      if (grant.effect !== "allow") continue;
      if (grant.resource.kind !== kind) continue;
      if (!grantMatchesAction(grant, action, this.#runImpliesApprove)) {
        continue;
      }
      return true;
    }
    return false;
  }
}
