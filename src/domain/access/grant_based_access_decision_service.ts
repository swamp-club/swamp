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

import type { Ceiling } from "./ceiling.ts";
import type { DelegationLookup } from "./delegation_directory.ts";
import { getLogger } from "@logtape/logtape";
import type { Grant } from "../models/access/grant_model.ts";
import type {
  AccessDecision,
  AccessDecisionService,
  AccessPrincipal,
  AccessResource,
} from "./access_decision_service.ts";
import type { Action } from "./action.ts";
import { clientConditionValue, integrationOfClient } from "./client.ts";
import type { IntegrationLookup } from "./integration_directory.ts";
import type { ConditionOutcome, PolicySnapshot } from "./policy_snapshot.ts";
import { principalToString } from "./principal.ts";
import { isControlPlaneRecordResource } from "./control_plane_records.ts";
import type { PrincipalContext } from "./principal_context.ts";
import { readAccessFingerprint } from "./read_access_fingerprint.ts";
import type { Subject } from "./subject.ts";
import {
  canonicalTypePattern,
  namesTypePath,
  type ResourceKind,
  resourceSelectorMatches,
  typePatternMatchesIgnoringAt,
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

  for (const collective of accessPrincipal.collectives) {
    subjects.push(`collective:${collective}`);
  }

  return subjects;
}

/**
 * keyed by the grant object, sound because snapshots never change grants in
 * place; a reload builds new grant objects
 */
const canonicalPatterns = new WeakMap<Grant, string | null>();

function canonicalPatternOf(grant: Grant): string | null {
  if (!canonicalPatterns.has(grant)) {
    canonicalPatterns.set(grant, canonicalTypePattern(grant.resource.pattern));
  }
  return canonicalPatterns.get(grant) ?? null;
}

function grantMatchesResource(grant: Grant, resource: AccessResource): boolean {
  if (grant.resource.kind !== resource.kind) {
    return false;
  }
  if (resourceSelectorMatches(grant.resource, resource.name)) {
    return true;
  }
  const modelType = resource.fields.modelType;
  if (typeof modelType !== "string") return false;
  // For model resources, also match against the extension type so that
  // namespace-scoped grants like model:@scope/* cover model instances
  // whose type falls under that namespace.
  if (
    resource.kind === "model" &&
    resourceSelectorMatches(grant.resource, modelType)
  ) {
    return true;
  }
  // a deny matches the type in any spelling so it never silently matches
  // nothing; an allow matches only as written, since folding would widen it
  if (
    grant.effect === "deny" &&
    (resource.kind === "model" || isControlPlaneRecordResource(resource))
  ) {
    const canonical = canonicalPatternOf(grant);
    if (canonical === null) return false;
    // Only a pattern written as a type path ignores the `@`; one that may be
    // written for model names folds case and separators only.
    return namesTypePath(grant.resource.pattern)
      ? typePatternMatchesIgnoringAt(canonical, modelType)
      : resourceSelectorMatches(
        { kind: resource.kind, pattern: canonical },
        modelType,
      );
  }
  return false;
}

export interface GrantBasedAccessDecisionServiceOptions {
  readonly runImpliesApprove?: boolean;
  readonly runImpliesSignal?: boolean;
  readonly writeImpliesTag?: boolean;
  /** absent, every integration is unknown and so refused */
  readonly integrations?: IntegrationLookup;
  /** absent, every delegation is unknown and so refused */
  readonly delegations?: DelegationLookup;
  /**
   * only for explaining what an integration's ceiling allows a person, where no
   * delegation exists; serve never sets it
   */
  readonly explainWithoutDelegation?: boolean;
}

const IMPLYING_ACTION = {
  approve: "run",
  signal: "run",
  tag: "write",
} as const satisfies Partial<Record<Action, Action>>;

type ImpliedAction = keyof typeof IMPLYING_ACTION;

export type ImplyingAction = (typeof IMPLYING_ACTION)[ImpliedAction];

const IMPLIED_ACTIONS = Object.keys(IMPLYING_ACTION) as ImpliedAction[];

function isImpliedAction(action: Action): action is ImpliedAction {
  return action in IMPLYING_ACTION;
}

type Implications = Readonly<Record<ImpliedAction, boolean>>;

export interface ActionCoverage {
  readonly action: Action;
  readonly impliedBy?: ImplyingAction;
}

type ActionMatch = "direct" | ImplyingAction | null;

function grantMatchesAction(
  grant: Grant,
  action: Action,
  implications: Implications,
): ActionMatch {
  if (grant.actions.includes(action)) return "direct";
  if (!isImpliedAction(action)) return null;
  const implying = IMPLYING_ACTION[action];
  if (!grant.actions.includes(implying)) return null;
  return grant.effect === "deny" || implications[action] ? implying : null;
}

function grantMatchesMethods(
  grant: Grant,
  resource: AccessResource,
): boolean {
  if (!grant.methods || grant.methods.length === 0) return true;
  const methodName = resource.fields.methodName;
  // a scoped allow covers only requests for its methods; a scoped deny refuses
  // a request that names no method, so it cannot be stepped around
  if (typeof methodName !== "string") {
    return grant.effect === "deny" || resource.anyMethod === true;
  }
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
  client: string | undefined,
): ConditionOutcome {
  if (!grant.condition) {
    return "match";
  }
  // The name is known by definition, even where a caller passes no fields.
  const outcome = snapshot.evaluateConditionOutcome(
    grant.condition,
    resource.kind,
    // set last so no resource field can stand in for it
    {
      name: resource.name,
      ...resource.fields,
      client: clientConditionValue(client),
    },
    principalContext,
    resource.pending,
  );
  // A kind-level check touches no resource, so a condition on resource
  // fields decides nothing there.
  return outcome === "missing-field" && resource.scope === "kind"
    ? "undecided"
    : outcome;
}

interface MatchedGrant {
  readonly grant: Grant;
  readonly match: ActionMatch;
}

function toDecision(
  grant: Grant,
  match: ActionMatch,
  dependsOn?: readonly string[],
): AccessDecision {
  return {
    effect: grant.effect,
    grantId: grant.id,
    subject: grant.subject,
    condition: grant.condition,
    ...(match !== null && match !== "direct" ? { impliedBy: match } : {}),
    ...(dependsOn ? { dependsOn } : {}),
  };
}

/**
 * computed, never stored, so no reconcile loop, reload or fleet version skew
 * can remove it
 */
export const SERVICE_TRIGGER_DEFAULT_GRANT_ID =
  "builtin:service-trigger-default";

/**
 * a service principal may run a workflow unless a deny matches; it covers no
 * other action or kind, so it never implies approve or signal
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

function budgetExceededSubject(accessPrincipal: AccessPrincipal): Subject {
  return {
    kind: accessPrincipal.principal.kind === "service" ? "service" : "user",
    name: accessPrincipal.principal.id,
  };
}

export const INTEGRATION_CEILING_GRANT_ID = "builtin:integration-ceiling";
export const INTEGRATION_UNKNOWN_GRANT_ID = "builtin:integration-unknown";
export const INTEGRATION_REVOKED_GRANT_ID = "builtin:integration-revoked";
export const DELEGATION_REQUIRED_GRANT_ID = "builtin:delegation-required";
export const DELEGATION_ENDED_GRANT_ID = "builtin:delegation-ended";
export const DELEGATION_CEILING_GRANT_ID = "builtin:delegation-ceiling";

/** no grant is behind these, so naming one would mislead */
export function integrationRefusalReason(grantId: string): string | undefined {
  switch (grantId) {
    case INTEGRATION_CEILING_GRANT_ID:
      return "above the integration's ceiling";
    case INTEGRATION_UNKNOWN_GRANT_ID:
      return "the integration is not registered";
    case INTEGRATION_REVOKED_GRANT_ID:
      return "the integration was revoked";
    default:
      return undefined;
  }
}

const MAX_CACHED_FINGERPRINTS = 4096;

export class GrantBasedAccessDecisionService implements AccessDecisionService {
  #snapshot: PolicySnapshot;
  readonly #implications: Implications;
  readonly #integrations: IntegrationLookup | undefined;
  readonly #delegations: DelegationLookup | undefined;
  readonly #explainWithoutDelegation: boolean;
  readonly #fingerprints = new WeakMap<PolicySnapshot, Map<string, string>>();

  constructor(
    snapshot: PolicySnapshot,
    options: GrantBasedAccessDecisionServiceOptions = {},
  ) {
    this.#snapshot = snapshot;
    this.#implications = {
      approve: options.runImpliesApprove ?? true,
      signal: options.runImpliesSignal ?? true,
      tag: options.writeImpliesTag ?? true,
    };
    this.#integrations = options.integrations;
    this.#delegations = options.delegations;
    this.#explainWithoutDelegation = options.explainWithoutDelegation === true;
  }

  /**
   * the consented ceiling of the delegation an integration client acts under,
   * or the refusal's grant id; a delegation for another integration, or one
   * named without an integration client, is refused
   */
  #consentedCeiling(
    principal: AccessPrincipal,
    integrationId: string | undefined,
  ): { ceiling: Ceiling | undefined } | { refusal: string } {
    if (principal.delegation === undefined) {
      if (integrationId === undefined) return { ceiling: undefined };
      return this.#explainWithoutDelegation
        ? { ceiling: undefined }
        : { refusal: DELEGATION_REQUIRED_GRANT_ID };
    }
    if (integrationId === undefined) {
      return { refusal: DELEGATION_REQUIRED_GRANT_ID };
    }
    const standing = this.#delegations?.standingOf(principal.delegation) ??
      { kind: "unknown" as const };
    if (
      standing.kind !== "standing" ||
      this.#delegations?.recordOf(principal.delegation)?.integrationId !==
        integrationId
    ) {
      return { refusal: DELEGATION_ENDED_GRANT_ID };
    }
    return { ceiling: standing.ceiling };
  }

  /** explicit, never null: sites fall back to an admin check on a null */
  #integrationRefusal(
    principal: AccessPrincipal,
    action: Action,
    resource: Pick<AccessResource, "kind" | "name">,
  ): AccessDecision | null {
    const integration = integrationOfClient(principal.client);
    const refuse = (grantId: string): AccessDecision => ({
      effect: "deny",
      grantId,
      subject: budgetExceededSubject(principal),
    });
    if (integration.kind === "none") {
      return principal.delegation === undefined
        ? null
        : refuse(DELEGATION_REQUIRED_GRANT_ID);
    }
    if (integration.kind === "malformed") {
      return refuse(INTEGRATION_UNKNOWN_GRANT_ID);
    }
    const standing = this.#integrations?.standingOf(integration.id) ??
      { kind: "unknown" as const };
    if (standing.kind === "unknown") {
      return refuse(INTEGRATION_UNKNOWN_GRANT_ID);
    }
    if (standing.kind === "revoked") {
      return refuse(INTEGRATION_REVOKED_GRANT_ID);
    }
    if (
      resource.kind !== "workflow" ||
      !standing.ceiling.allows(action, resource.name)
    ) return refuse(INTEGRATION_CEILING_GRANT_ID);
    const consented = this.#consentedCeiling(principal, integration.id);
    if ("refusal" in consented) return refuse(consented.refusal);
    return consented.ceiling === undefined ||
        consented.ceiling.allows(action, resource.name)
      ? null
      : refuse(DELEGATION_CEILING_GRANT_ID);
  }

  /** for showing a person's grants: what a ceiling could never let through */
  grantUsableThroughClient(
    principal: AccessPrincipal,
    grant: Grant,
    action: Action,
  ): boolean {
    const integration = integrationOfClient(principal.client);
    if (integration.kind === "none") return principal.delegation === undefined;
    if (integration.kind === "malformed") return false;
    const standing = this.#integrations?.standingOf(integration.id);
    if (
      standing?.kind !== "active" || grant.resource.kind !== "workflow" ||
      !standing.ceiling.overlaps(action, grant.resource)
    ) return false;
    const consented = this.#consentedCeiling(principal, integration.id);
    if ("refusal" in consented) return false;
    return consented.ceiling === undefined ||
      consented.ceiling.overlaps(action, grant.resource);
  }

  get runImpliesApprove(): boolean {
    return this.#implications.approve;
  }

  get runImpliesSignal(): boolean {
    return this.#implications.signal;
  }

  get writeImpliesTag(): boolean {
    return this.#implications.tag;
  }

  actionsCoveredBy(grant: Grant): ActionCoverage[] {
    const covered: ActionCoverage[] = grant.actions.map((action) => ({
      action,
    }));
    for (const action of IMPLIED_ACTIONS) {
      const match = grantMatchesAction(grant, action, this.#implications);
      if (match !== null && match !== "direct") {
        covered.push({ action, impliedBy: match });
      }
    }
    return covered;
  }

  get snapshot(): PolicySnapshot {
    return this.#snapshot;
  }

  set snapshot(snapshot: PolicySnapshot) {
    this.#snapshot = snapshot;
  }

  /**
   * changes whenever a read decision for the principal could; a reload that
   * leaves the principal's groups and grants alone keeps it
   */
  readAccessFingerprint(
    principal: AccessPrincipal,
    restrictedTypes: readonly string[],
  ): string {
    const snapshot = this.#snapshot;
    let cache = this.#fingerprints.get(snapshot);
    if (cache === undefined) {
      cache = new Map();
      this.#fingerprints.set(snapshot, cache);
    }
    const principalKey = principalToString(principal.principal);
    const key = JSON.stringify([
      principalKey,
      [...principal.collectives].sort(),
      [...principal.groups].sort(),
      [...restrictedTypes].sort(),
      principal.client ?? null,
      principal.delegation ?? null,
    ]);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const localGroups = snapshot.groupsForPrincipal(principalKey);
    const fingerprint = readAccessFingerprint(
      principal,
      localGroups,
      snapshot.grantsForSubjects(resolveSubjects(principal, localGroups)),
      restrictedTypes,
    );
    if (cache.size >= MAX_CACHED_FINGERPRINTS) cache.clear();
    cache.set(key, fingerprint);
    return fingerprint;
  }

  decide(
    principal: AccessPrincipal,
    action: Action,
    resource: AccessResource,
  ): AccessDecision | null {
    // any action on a control-plane record is managing access, so it is decided
    // as admin
    if (isControlPlaneRecordResource(resource)) action = "admin";
    const refusal = this.#integrationRefusal(principal, action, resource);
    if (refusal) return refusal;
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
      const match = grantMatchesAction(grant, action, this.#implications);
      if (!match) continue;
      if (!grantMatchesMethods(grant, resource)) continue;
      if (grant.effect === "deny") {
        denies.push({ grant, match });
      } else {
        allows.push({ grant, match });
      }
    }

    let conditionsEvaluated = 0;
    let pendingAllow: AccessDecision | undefined;
    // a deny undecided on a kind must not let the service trigger default allow
    // what it meant to stop
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
        principal.client,
      );
      // authorization fails closed: a deny that cannot be evaluated refuses
      if (
        outcome === "match" || outcome === "missing-field" ||
        outcome === "error"
      ) {
        return toDecision(grant, match);
      }
      if (outcome === "undecided") denyUndecided = true;
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
      const outcome = evaluateGrant(
        grant,
        snapshot,
        resource,
        principalContext,
        principal.client,
      );
      if (outcome === "match") return toDecision(grant, match);
      if (outcome === "pending") {
        pendingAllow ??= toDecision(grant, match, resource.pending);
      }
    }

    if (pendingAllow) return pendingAllow;
    return denyUndecided
      ? null
      : serviceTriggerDefault(principal, action, resource);
  }

  explain(
    principal: AccessPrincipal,
    action: Action,
    resource: AccessResource,
  ): AccessDecision[] {
    // any action on a control-plane record is managing access, so it is
    // explained as admin
    if (isControlPlaneRecordResource(resource)) action = "admin";
    const refusal = this.#integrationRefusal(principal, action, resource);
    if (refusal) return [refusal];
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
    const pendingAllows: AccessDecision[] = [];
    const pendingDenies: AccessDecision[] = [];
    for (const grant of candidates) {
      if (!grantMatchesResource(grant, resource)) continue;
      const match = grantMatchesAction(grant, action, this.#implications);
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
        principal.client,
      );
      if (outcome === "undecided" && grant.effect === "deny") {
        denyUndecided = true;
      }
      if (outcome === "pending") {
        const decision = toDecision(grant, match, resource.pending);
        if (grant.effect === "deny") pendingDenies.push(decision);
        else pendingAllows.push(decision);
      }
      if (
        outcome === "match" ||
        ((outcome === "missing-field" || outcome === "error") &&
          grant.effect === "deny")
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
      pendingAllows.length === 0 && pendingDenies.length === 0 &&
      !denyUndecided
    ) {
      const builtin = serviceTriggerDefault(principal, action, resource);
      if (builtin) return [builtin];
    }
    return [
      ...denyDecisions,
      ...allowDecisions,
      ...pendingAllows,
      ...pendingDenies,
    ];
  }

  decideAll(
    principal: AccessPrincipal,
    action: Action,
    kind: ResourceKind,
  ): AccessDecision | null {
    const refusal = this.#integrationRefusal(principal, action, {
      kind,
      name: "*",
    });
    if (refusal) return refusal;
    const snapshot = this.#snapshot;
    const principalKey = principalToString(principal.principal);
    const localGroups = snapshot.groupsForPrincipal(principalKey);
    const subjects = resolveSubjects(principal, localGroups);
    const principalContext = buildPrincipalContext(principal, localGroups);
    for (const grant of snapshot.grantsForSubjects(subjects)) {
      if (grant.effect !== "deny" || grant.resource.kind !== kind) continue;
      const match = grantMatchesAction(grant, action, this.#implications);
      if (!match) continue;
      // evaluated with no resource fields: a condition reading any, name
      // included, could hold for some resource so it refuses; one on the
      // principal alone is decided for this caller
      if (
        grant.condition &&
        snapshot.evaluateConditionOutcome(
            grant.condition,
            kind,
            { client: clientConditionValue(principal.client) },
            principalContext,
          ) === "no-match"
      ) continue;
      return toDecision(grant, match);
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
    const integration = integrationOfClient(principal.client);
    if (integration.kind === "malformed") return false;
    const consented = this.#consentedCeiling(
      principal,
      integration.kind === "integration" ? integration.id : undefined,
    );
    if ("refusal" in consented) return false;
    if (integration.kind === "integration") {
      const standing = this.#integrations?.standingOf(integration.id);
      if (
        standing?.kind !== "active" || kind !== "workflow" ||
        !standing.ceiling.allowsSomewhere(action) ||
        (consented.ceiling !== undefined &&
          !consented.ceiling.allowsSomewhere(action))
      ) return false;
    }
    const snapshot = this.#snapshot;
    const principalKey = principalToString(principal.principal);
    const localGroups = snapshot.groupsForPrincipal(principalKey);
    const subjects = resolveSubjects(principal, localGroups);
    const candidates = snapshot.grantsForSubjects(subjects);

    for (const grant of candidates) {
      if (grant.effect !== "allow") continue;
      if (grant.resource.kind !== kind) continue;
      if (!grantMatchesAction(grant, action, this.#implications)) {
        continue;
      }
      return true;
    }
    return false;
  }
}
