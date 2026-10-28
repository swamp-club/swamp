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

  return subjects;
}

/**
 * Each grant's selector in canonical type spelling, computed once. Keyed by
 * the grant object, which is sound because snapshots hold grants that are
 * never changed in place: a reload builds new grant objects.
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
  // A deny also matches the type in any spelling — case, `::` or `.`
  // separators, with or without a leading `@` — so a deny an admin wrote
  // never silently matches nothing. An allow matches only as written: folding
  // it would widen what it grants (swamp-club#3130). Of access resources only
  // control-plane records name a type.
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
  /**
   * Whether an allow grant for `run` also satisfies `approve`. Defaults to
   * true, the original semantics. A deny grant for `run` denies `approve`
   * regardless, so turning this off can only narrow what is allowed.
   */
  readonly runImpliesApprove?: boolean;
  /**
   * Whether an allow grant for `run` also satisfies `signal`. Defaults to
   * true. A deny grant for `run` denies `signal` regardless, so turning this
   * off can only narrow what is allowed.
   */
  readonly runImpliesSignal?: boolean;
  /**
   * Whether an allow grant for `write` also satisfies `tag`. Defaults to
   * true. A deny grant for `write` denies `tag` regardless, so turning this
   * off can only narrow what is allowed (swamp-club#3085).
   */
  readonly writeImpliesTag?: boolean;
}

/**
 * Each action a grant for another action also satisfies, and that action:
 * `run` implies `approve` and `signal`, `write` implies `tag`.
 */
const IMPLYING_ACTION = {
  approve: "run",
  signal: "run",
  tag: "write",
} as const satisfies Partial<Record<Action, Action>>;

/** An action another action implies. */
type ImpliedAction = keyof typeof IMPLYING_ACTION;

/** An action that implies another. */
export type ImplyingAction = (typeof IMPLYING_ACTION)[ImpliedAction];

const IMPLIED_ACTIONS = Object.keys(IMPLYING_ACTION) as ImpliedAction[];

function isImpliedAction(action: Action): action is ImpliedAction {
  return action in IMPLYING_ACTION;
}

/** Whether an allow grant for the implying action satisfies each action. */
type Implications = Readonly<Record<ImpliedAction, boolean>>;

/** An action a grant covers, and the action it is covered through, if any. */
export interface ActionCoverage {
  readonly action: Action;
  readonly impliedBy?: ImplyingAction;
}

/**
 * How a grant matched a requested action: directly, through the action
 * named, or not at all (null).
 */
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
    ...(match !== null && match !== "direct" ? { impliedBy: match } : {}),
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
 * or resource kind, so it never implies `approve` or `signal`.
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

/**
 * The most callers whose read-access fingerprint one snapshot keeps; past
 * it the snapshot's cache starts again.
 */
const MAX_CACHED_FINGERPRINTS = 4096;

export class GrantBasedAccessDecisionService implements AccessDecisionService {
  #snapshot: PolicySnapshot;
  readonly #implications: Implications;
  /** Read-access fingerprints by snapshot, then by caller. */
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

  /**
   * The actions a grant covers under this service's policy: the grant's own
   * actions in order, then `approve` and `signal` when the grant covers them
   * only through `run`, and `tag` when it covers it only through `write`.
   */
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
   * A fingerprint of everything `principal` may read under the current
   * snapshot and serve's `restrictedTypes` (swamp-club#4089; see
   * `read_access_fingerprint.ts`): it changes whenever a read decision for
   * the principal could, and a reload that leaves the principal's groups
   * and grants alone keeps it.
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
      principal.collectives,
      principal.groups,
      restrictedTypes,
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
    // Any action on a control-plane record is managing access, so it is
    // decided as admin (swamp-club#2756).
    if (isControlPlaneRecordResource(resource)) action = "admin";
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
    // Any action on a control-plane record is managing access, so it is
    // explained as admin (swamp-club#2756).
    if (isControlPlaneRecordResource(resource)) action = "admin";
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
    const principalContext = buildPrincipalContext(principal, localGroups);
    for (const grant of snapshot.grantsForSubjects(subjects)) {
      if (grant.effect !== "deny" || grant.resource.kind !== kind) continue;
      const match = grantMatchesAction(grant, action, this.#implications);
      if (!match) continue;
      // A condition is evaluated with no resource fields at all: one that
      // reads any of them — the name included — could hold for some
      // resource, so it refuses; one on the principal alone is decided for
      // this caller.
      if (
        grant.condition &&
        snapshot.evaluateConditionOutcome(
            grant.condition,
            kind,
            {},
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
