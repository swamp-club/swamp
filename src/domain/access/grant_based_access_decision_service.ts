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
import type { ConditionOutcome, PolicySnapshot } from "./policy_snapshot.ts";
import { principalToString } from "./principal.ts";
import type { PrincipalContext } from "./principal_context.ts";
import type { Subject } from "./subject.ts";
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
): ConditionOutcome {
  if (!grant.condition) {
    return "match";
  }
  // The name is known by definition, even where a caller passes no fields.
  const outcome = snapshot.evaluateConditionOutcome(
    grant.condition,
    resource.kind,
    { name: resource.name, ...resource.fields },
    principalContext,
  );
  // A kind-level check touches no resource, so a condition on resource
  // fields decides nothing there.
  return outcome === "missing-field" && resource.scope === "kind"
    ? "error"
    : outcome;
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

/**
 * Grant id reported for the built-in allow that lets a service principal run
 * a workflow when no grant decides the request. It is computed, never stored,
 * so no reconcile loop, reload or fleet version skew can remove it.
 */
export const SERVICE_TRIGGER_DEFAULT_GRANT_ID =
  "builtin:service-trigger-default";

/**
 * The built-in decision for scheduled and webhook runs: a service principal
 * may `run` a workflow unless a deny grant matches. It covers no other action
 * or resource kind, so it never implies `approve`.
 */
function serviceTriggerDefault(
  accessPrincipal: AccessPrincipal,
  action: Action,
  resource: AccessResource,
): AccessDecision | null {
  if (
    accessPrincipal.principal.kind !== "service" || action !== "run" ||
    resource.kind !== "workflow"
  ) {
    return null;
  }
  return {
    effect: "allow",
    grantId: SERVICE_TRIGGER_DEFAULT_GRANT_ID,
    subject: { kind: "service", name: accessPrincipal.principal.id },
  };
}

/** The subject a synthetic decision is attributed to. */
function budgetExceededSubject(accessPrincipal: AccessPrincipal): Subject {
  return {
    kind: accessPrincipal.principal.kind === "service" ? "service" : "user",
    name: accessPrincipal.principal.id,
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
    // A deny whose condition could not be evaluated decides nothing, but it
    // must not let the service trigger default allow what it meant to stop.
    let denyUndecided = false;

    for (const { grant, match } of denies) {
      if (grant.condition) {
        conditionsEvaluated++;
        if (conditionsEvaluated > MAX_AGGREGATE_CONDITIONS) {
          logger
            .warn`Aggregate condition budget exceeded (${conditionsEvaluated} > ${MAX_AGGREGATE_CONDITIONS}) for principal ${principalKey} action ${action} on ${resource.kind}:${resource.name} — denying`;
          return {
            effect: "deny",
            grantId: "aggregate-budget-exceeded",
            subject: budgetExceededSubject(principal),
          };
        }
      }
      const outcome = evaluateGrant(
        grant,
        snapshot,
        resource,
        principalContext,
      );
      // A deny that needs a field the resource does not carry fails closed
      // (swamp-club#2675).
      if (outcome === "match" || outcome === "missing-field") {
        return toDecision(grant, match);
      }
      if (outcome === "error") denyUndecided = true;
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
            subject: budgetExceededSubject(principal),
          };
        }
      }
      if (
        evaluateGrant(grant, snapshot, resource, principalContext) === "match"
      ) {
        return toDecision(grant, match);
      }
    }

    return denyUndecided
      ? null
      : serviceTriggerDefault(principal, action, resource);
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
    let denyUndecided = false;
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
          // Unexamined grants may include a deny; do not report the default.
          denyUndecided = true;
          break;
        }
      }
      const outcome = evaluateGrant(
        grant,
        snapshot,
        resource,
        principalContext,
      );
      if (outcome === "error" && grant.effect === "deny") denyUndecided = true;
      if (
        outcome === "match" ||
        (outcome === "missing-field" && grant.effect === "deny")
      ) {
        if (grant.effect === "deny") {
          denyDecisions.push(toDecision(grant, match));
        } else {
          allowDecisions.push(toDecision(grant, match));
        }
      }
    }

    if (
      denyDecisions.length === 0 && allowDecisions.length === 0 &&
      !denyUndecided
    ) {
      const builtin = serviceTriggerDefault(principal, action, resource);
      if (builtin) return [builtin];
    }
    return [...denyDecisions, ...allowDecisions];
  }

  decideAll(
    principal: AccessPrincipal,
    action: Action,
    kind: ResourceKind,
  ): AccessDecision | null {
    const snapshot = this.#snapshot;
    const principalKey = principalToString(principal.principal);
    const localGroups = snapshot.groupsForPrincipal(principalKey);
    const subjects = resolveSubjects(principal, localGroups);
    for (const grant of snapshot.grantsForSubjects(subjects)) {
      if (grant.effect !== "deny" || grant.resource.kind !== kind) continue;
      const match = grantMatchesAction(grant, action, this.#runImpliesApprove);
      if (match) return toDecision(grant, match);
    }
    return this.decide(principal, action, {
      kind,
      name: "*",
      fields: { name: "*" },
    });
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
