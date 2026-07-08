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
import { resourceSelectorMatches } from "./resource_selector.ts";

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

  for (const collective of accessPrincipal.collectives) {
    subjects.push(`idp-group:${collective}`);
  }

  return subjects;
}

function grantMatchesResource(grant: Grant, resource: AccessResource): boolean {
  if (grant.resource.kind !== resource.kind) {
    return false;
  }
  return resourceSelectorMatches(grant.resource, resource.name);
}

function grantMatchesAction(grant: Grant, action: Action): boolean {
  return grant.actions.includes(action);
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

function toDecision(grant: Grant): AccessDecision {
  return {
    effect: grant.effect,
    grantId: grant.id,
    subject: grant.subject,
    condition: grant.condition,
  };
}

export class GrantBasedAccessDecisionService implements AccessDecisionService {
  #snapshot: PolicySnapshot;

  constructor(snapshot: PolicySnapshot) {
    this.#snapshot = snapshot;
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

    const denies: Grant[] = [];
    const allows: Grant[] = [];
    for (const grant of candidates) {
      if (!grantMatchesResource(grant, resource)) continue;
      if (!grantMatchesAction(grant, action)) continue;
      if (grant.effect === "deny") {
        denies.push(grant);
      } else {
        allows.push(grant);
      }
    }

    let conditionsEvaluated = 0;

    for (const grant of denies) {
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
        return toDecision(grant);
      }
    }

    for (const grant of allows) {
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
        return toDecision(grant);
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
    const decisions: AccessDecision[] = [];
    for (const grant of candidates) {
      if (!grantMatchesResource(grant, resource)) continue;
      if (!grantMatchesAction(grant, action)) continue;
      if (grant.condition) {
        conditionsEvaluated++;
        if (conditionsEvaluated > MAX_AGGREGATE_CONDITIONS) {
          logger
            .warn`Aggregate condition budget exceeded (${conditionsEvaluated} > ${MAX_AGGREGATE_CONDITIONS}) for principal ${principalKey} action ${action} on ${resource.kind}:${resource.name} — truncating explain`;
          break;
        }
      }
      if (evaluateGrant(grant, snapshot, resource, principalContext)) {
        decisions.push(toDecision(grant));
      }
    }

    return decisions;
  }
}
