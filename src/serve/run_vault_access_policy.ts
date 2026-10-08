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

/**
 * The run-time vault rule for serve runs (swamp-club#2676).
 *
 * Every vault operation a serve run makes — a `vault.get` expression, a
 * sensitive output, a model's `context.vaultService`, a worker's
 * `resolveSecret` — is judged against the grants of the principal that
 * triggered the run. The decision inputs (principal, IdP groups,
 * collectives) are captured once when the run starts; the grants are read
 * from the current policy snapshot on every decision, so a reload or a
 * revocation applies to the run's next vault operation.
 *
 * For vault `N` and action `A`:
 *
 * - (r) a reserved vault is refused unless the principal holds admin on
 *   `access:*`, whatever other grants exist;
 * - (a) with no vault-kind grant in the policy, allowed (today's behaviour);
 * - (b) a vault-kind deny for `A` matching `N` refuses;
 * - an access admin is never vault-scoped and is otherwise allowed;
 * - (c) a principal any vault-kind allow applies to (for any action) is
 *   vault-scoped: allowed only when an allow for `A` matches `N`;
 * - (d) otherwise allowed.
 *
 * Decided with `keyUnknown` (the pre-run check of a sensitive output whose
 * key is generated at write time), a refusal that could change once the key
 * is known — by (b) through a deny conditioned on `key`, or by (c) while an
 * allow for `A` matching `N` that applies to the principal is conditioned on
 * `key` —
 * is reported as undetermined: the put, which knows the key, decides.
 *
 * Data-kind grants play no part at run time. This differs from the request
 * rule for vault requests (which needs an allow), because run reads were
 * never checked before vault grants existed.
 *
 * @module
 */

import type { AccessPrincipal } from "../domain/access/access_decision_service.ts";
import { ActionSchema } from "../domain/access/action.ts";
import type { GrantBasedAccessDecisionService } from "../domain/access/grant_based_access_decision_service.ts";
import {
  type Principal,
  principalToString,
} from "../domain/access/principal.ts";
import type { AuthMode } from "../domain/access/serve_auth_config.ts";
import type { ServerToken } from "../domain/models/access/server_token_model.ts";
import type { AuditEmitter } from "../domain/serve_audit/audit_emitter.ts";
import { buildAuditEvent } from "../domain/serve_audit/audit_event_builder.ts";
import { isReservedVaultName } from "../domain/vaults/vault_name.ts";
import { conditionReferencesField } from "../domain/access/policy_snapshot_loader.ts";
import { resourceSelectorMatches } from "../domain/access/resource_selector.ts";
import {
  type RunTriggeringPrincipal,
  RunVaultAccess,
  type VaultAccessDecision,
  type VaultAccessDenial,
  type VaultAction,
  type VaultDecideOptions,
  type VaultPrincipalPolicy,
} from "../domain/vaults/run_vault_access.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  captureDecisionSubject,
  type ConnectionContext,
  getConnectionCollectives,
  getConnectionGroups,
  getConnectionLoginIdentity,
  vaultKindResource,
} from "./handlers/shared.ts";
import { readServerTokenRecord } from "./token_auth.ts";

const logger = getSwampLogger(["serve", "run-vault-access"]);

/** How long a server token record read for a run's decisions is reused. */
export const TOKEN_REVALIDATION_TTL_MS = 30_000;

/** Which rule decided a run-time vault operation. */
export type RunVaultRule =
  | "reserved"
  | "no-vault-grants"
  | "membership-unavailable"
  | "vault-deny"
  | "access-admin"
  | "vault-allow"
  | "vault-scoped"
  | "key-undetermined"
  | "unscoped";

/** A run-time vault decision, with the rule that made it. */
export interface RunVaultDecision extends VaultAccessDecision {
  readonly rule: RunVaultRule;
  /**
   * Whether the principal's runs are vault-scoped: they read only vaults a
   * vault allow names.
   */
  readonly restricted: boolean;
}

/** The decision service the rule reads, fresh per decision. */
export type RunVaultDecisionService = Pick<
  GrantBasedAccessDecisionService,
  "decide" | "hasAnyGrantForKind" | "snapshot"
>;

function isAccessAdmin(
  service: RunVaultDecisionService,
  principal: AccessPrincipal,
): boolean {
  return service.decide(principal, "admin", {
    kind: "access",
    name: "*",
    fields: {},
  })?.effect === "allow";
}

/**
 * Whether a refusal decided with no key could change once the key is known:
 * a deny decided it and that deny's condition is on `key`, or the principal is
 * vault-scoped and an allow for `action` that applies to it (directly,
 * through a local group or through an IdP group) and matches `vaultName` has
 * a condition on `key`. An allow for another action cannot change the
 * outcome, so it never defers the refusal.
 */
function refusalDependsOnKey(
  service: RunVaultDecisionService,
  principal: AccessPrincipal,
  vaultName: string,
  action: VaultAction,
  refusal: RunVaultDecision,
): boolean {
  const snapshot = service.snapshot;
  const principalKey = principalToString(principal.principal);
  const subjects = [
    principalKey,
    ...snapshot.groupsForPrincipal(principalKey).map((g) => `group:${g}`),
    ...principal.groups.map((g) => `idp-group:${g}`),
  ];
  return snapshot.grantsForSubjects(subjects).some((grant) =>
    grant.resource.kind === "vault" &&
    grant.condition !== undefined &&
    (refusal.rule === "vault-deny"
      ? grant.id === refusal.grantId
      : grant.effect === "allow" && grant.actions.includes(action)) &&
    resourceSelectorMatches(grant.resource, vaultName) &&
    conditionReferencesField(grant.condition, "vault", "key")
  );
}

/**
 * Decides one run-time vault operation by the rule in this module's docs.
 * `principal` is null when the run's decision inputs are unavailable (a
 * resumed run that recorded none, or a revoked token): then every operation
 * is refused once the policy holds any vault grant.
 */
export function decideRunVaultAccess(
  service: RunVaultDecisionService,
  principal: AccessPrincipal | null,
  vaultName: string,
  action: VaultAction,
  secretKey?: string,
  options?: VaultDecideOptions,
): RunVaultDecision {
  const decision = decideKnownKey(
    service,
    principal,
    vaultName,
    action,
    secretKey,
  );
  if (
    options?.keyUnknown === true && !decision.allowed && principal !== null &&
    (decision.rule === "vault-deny" || decision.rule === "vault-scoped") &&
    refusalDependsOnKey(service, principal, vaultName, action, decision)
  ) {
    return {
      allowed: false,
      undetermined: true,
      rule: "key-undetermined",
      restricted: decision.restricted,
      reason:
        `a vault:${vaultName} grant has a condition on the secret key, which is not known yet`,
    };
  }
  return decision;
}

function decideKnownKey(
  service: RunVaultDecisionService,
  principal: AccessPrincipal | null,
  vaultName: string,
  action: VaultAction,
  secretKey?: string,
): RunVaultDecision {
  const admin = principal !== null && isAccessAdmin(service, principal);
  if (isReservedVaultName(vaultName) && !admin) {
    return {
      allowed: false,
      rule: "reserved",
      restricted: false,
      reason:
        `'${vaultName}' is a reserved vault, usable by a serve run only for an access admin`,
    };
  }
  if (!service.snapshot.hasGrantOfKind("vault")) {
    return {
      allowed: true,
      rule: "no-vault-grants",
      restricted: false,
      reason: "the policy holds no vault grant",
    };
  }
  if (principal === null) {
    return {
      allowed: false,
      rule: "membership-unavailable",
      restricted: true,
      reason:
        "the run's triggering principal and memberships are unavailable, so its vault access cannot be decided",
    };
  }
  const decision = service.decide(
    principal,
    action,
    vaultKindResource(vaultName, secretKey),
  );
  if (decision?.effect === "deny") {
    return {
      allowed: false,
      rule: "vault-deny",
      restricted: false,
      grantId: decision.grantId,
      reason:
        `denied by grant ${decision.grantId}; remove or narrow grant ${decision.grantId} to allow it`,
    };
  }
  if (admin) {
    return {
      allowed: true,
      rule: "access-admin",
      restricted: false,
      reason: "the principal is an access admin",
    };
  }
  const scoped = ActionSchema.options.some((a) =>
    service.hasAnyGrantForKind(principal, a, "vault")
  );
  if (scoped) {
    return decision?.effect === "allow"
      ? {
        allowed: true,
        rule: "vault-allow",
        restricted: true,
        grantId: decision.grantId,
        reason: `allowed by grant ${decision.grantId}`,
      }
      : {
        allowed: false,
        rule: "vault-scoped",
        restricted: true,
        reason:
          `the principal holds vault grants and none allows ${action} on vault:${vaultName}; add a vault:${vaultName} allow grant for ${action} to this principal`,
      };
  }
  return {
    allowed: true,
    rule: "unscoped",
    restricted: false,
    reason: "no vault grant applies to the principal",
  };
}

/** Where a run's decision inputs come from. */
export type RunPrincipalInputs =
  | {
    /** A server-token session: memberships re-read from the token record. */
    readonly source: "token";
    readonly principal: Principal;
    readonly tokenBinding: NonNullable<RunTriggeringPrincipal["tokenBinding"]>;
    readonly idpGroups: readonly string[];
    readonly collectives: readonly string[];
  }
  | {
    /**
     * An OAuth session, a service principal (local groups only) or a
     * resumed run's recorded memberships: used as captured.
     */
    readonly source: "session" | "service" | "persisted";
    readonly principal: Principal;
    readonly tokenBinding?: RunTriggeringPrincipal["tokenBinding"];
    readonly idpGroups: readonly string[];
    readonly collectives: readonly string[];
  }
  | {
    /** A resumed run that recorded no triggering principal. */
    readonly source: "missing";
    /** The run's `initiatedBy`, for refusals and audit. */
    readonly label: string;
  };

/** What the run-time policy needs from serve. */
export interface RunVaultPolicyDeps {
  readonly authMode: AuthMode;
  readonly policySnapshotLoader?: {
    readonly decisionService: RunVaultDecisionService;
  };
  /** Reads a server token's record; required for token sessions. */
  readonly readTokenRecord?: (name: string) => Promise<ServerToken>;
  readonly now?: () => number;
  readonly tokenTtlMs?: number;
}

/**
 * {@link VaultPrincipalPolicy} for one serve run: the triggering principal's
 * decision inputs captured at run start, decided per operation against the
 * current policy snapshot.
 */
export class ServeRunVaultPolicy implements VaultPrincipalPolicy {
  readonly principal: string;
  readonly triggeringPrincipal?: RunTriggeringPrincipal;
  readonly #deps: RunVaultPolicyDeps;
  readonly #inputs: RunPrincipalInputs;
  #tokenCheck?: { at: number; principal: Promise<AccessPrincipal | null> };
  #loggedUnavailable = false;

  constructor(deps: RunVaultPolicyDeps, inputs: RunPrincipalInputs) {
    this.#deps = deps;
    this.#inputs = inputs;
    if (inputs.source === "missing") {
      this.principal = inputs.label;
      return;
    }
    this.principal = principalToString(inputs.principal);
    const service = deps.policySnapshotLoader?.decisionService;
    this.triggeringPrincipal = {
      kind: inputs.principal.kind,
      id: inputs.principal.id,
      // Only a server-token session's binding is recorded, so a resume
      // re-checks the token exactly when a live run does; an OAuth session's
      // short-lived login token is never re-checked.
      ...(inputs.tokenBinding &&
          (inputs.source === "token" || inputs.source === "persisted")
        ? { tokenBinding: { ...inputs.tokenBinding } }
        : {}),
      membership: {
        localGroups: [
          ...(service?.snapshot.groupsForPrincipal(this.principal) ?? []),
        ],
        idpGroups: [...inputs.idpGroups],
        collectives: [...inputs.collectives],
      },
    };
  }

  async decide(
    vaultName: string,
    action: VaultAction,
    secretKey?: string,
    options?: VaultDecideOptions,
  ): Promise<VaultAccessDecision> {
    const service = this.#deps.policySnapshotLoader?.decisionService;
    if (!service) {
      return { allowed: false, reason: "no policy snapshot is loaded" };
    }
    const principal = await this.#accessPrincipal();
    const decision = decideRunVaultAccess(
      service,
      principal,
      vaultName,
      action,
      secretKey,
      options,
    );
    if (
      decision.rule === "membership-unavailable" && !this.#loggedUnavailable
    ) {
      this.#loggedUnavailable = true;
      logger.warn(
        "Refusing every vault operation of a run by {principal}: {reason}",
        { principal: this.principal, reason: this.#unavailableReason() },
      );
    }
    return decision;
  }

  #unavailableReason(): string {
    return this.#inputs.source === "missing"
      ? "the run recorded no triggering principal (started on an older release or saved by an older replica)"
      : "its server token is no longer valid";
  }

  #accessPrincipal(): Promise<AccessPrincipal | null> {
    const inputs = this.#inputs;
    if (inputs.source === "missing") return Promise.resolve(null);
    // A live token session and a resumed run that recorded a token both
    // revalidate the token record; any other source is used as captured.
    if (
      inputs.source !== "token" &&
      !(inputs.source === "persisted" && inputs.tokenBinding)
    ) {
      return Promise.resolve({
        principal: inputs.principal,
        groups: inputs.idpGroups,
        collectives: inputs.collectives,
      });
    }
    const now = (this.#deps.now ?? Date.now)();
    const ttl = this.#deps.tokenTtlMs ?? TOKEN_REVALIDATION_TTL_MS;
    if (this.#tokenCheck && now - this.#tokenCheck.at < ttl) {
      return this.#tokenCheck.principal;
    }
    const principal = this.#revalidateToken(inputs);
    this.#tokenCheck = { at: now, principal };
    return principal;
  }

  /**
   * Null unless the token `inputs` is bound to still exists, is not revoked,
   * and is the same mint for the same principal. Expiry alone does not cut a
   * run off: it was authorized when it started (an expired token is deleted
   * by token GC after its grace period, and from then on it is refused). A
   * live token session takes its memberships from the record; a resumed run
   * keeps the memberships it recorded at run start (an OAuth session's IdP
   * groups and collectives are not on the token record).
   */
  async #revalidateToken(
    inputs: Exclude<RunPrincipalInputs, { source: "missing" }>,
  ): Promise<AccessPrincipal | null> {
    const read = this.#deps.readTokenRecord;
    const binding = inputs.tokenBinding;
    if (!read || !binding) return null;
    let record: ServerToken;
    try {
      record = await read(binding.name);
    } catch {
      return null;
    }
    if (
      record.state !== "active" ||
      record.createdAt !== binding.createdAt ||
      record.principalId !== binding.principalId ||
      record.principalId !== principalToString(inputs.principal)
    ) {
      return null;
    }
    return inputs.source === "token"
      ? {
        principal: inputs.principal,
        groups: record.groups,
        collectives: record.collectives,
      }
      : {
        principal: inputs.principal,
        groups: inputs.idpGroups,
        collectives: inputs.collectives,
      };
  }
}

/** What a serve run's vault scope needs from the connection context. */
export interface RunVaultScopeContext extends RunVaultPolicyDeps {
  readonly auditEmitter?: AuditEmitter;
  readonly instanceId?: string;
}

/** The run-time policy's view of a serve connection context. */
export function runVaultScopeContext(
  ctx: Pick<
    ConnectionContext,
    | "authConfig"
    | "policySnapshotLoader"
    | "repoContext"
    | "auditEmitter"
    | "instanceId"
  >,
): RunVaultScopeContext {
  return {
    authMode: ctx.authConfig.mode,
    policySnapshotLoader: ctx.policySnapshotLoader,
    readTokenRecord: (name) => readServerTokenRecord(ctx.repoContext, name),
    auditEmitter: ctx.auditEmitter,
    instanceId: ctx.instanceId,
  };
}

/**
 * Captures, at run start, the decision inputs of the principal behind a
 * request on `socket`: a server-token session re-reads its memberships from
 * the token record (with a short cache); an OAuth session keeps the IdP
 * groups and collectives of the session. Null without a principal.
 */
export function captureRunPrincipal(
  socket: WebSocket,
  principal: Principal | null,
): RunPrincipalInputs | null {
  if (!principal) return null;
  const idpGroups = [...getConnectionGroups(socket)];
  const collectives = [...getConnectionCollectives(socket)];
  const token = captureDecisionSubject(socket, principal).token;
  if (token && getConnectionLoginIdentity(socket) === undefined) {
    return {
      source: "token",
      principal,
      tokenBinding: token,
      idpGroups,
      collectives,
    };
  }
  return {
    source: "session",
    principal,
    ...(token ? { tokenBinding: token } : {}),
    idpGroups,
    collectives,
  };
}

/**
 * The scope for a run a request on `socket` starts, or `undefined` when no
 * policy applies.
 */
export function requestRunVaultScope(
  ctx: Parameters<typeof runVaultScopeContext>[0],
  socket: WebSocket,
  principal: Principal | null,
  runId?: string,
): ServeRunVaultScope | undefined {
  const inputs = captureRunPrincipal(socket, principal);
  if (!inputs) return undefined;
  return createRunVaultScope(runVaultScopeContext(ctx), inputs, runId);
}

/**
 * The vault scope a serve run executes in. `runId` is filled once the run
 * has one, so a refusal is audited with it.
 */
export interface ServeRunVaultScope {
  readonly access: RunVaultAccess;
  runId?: string;
}

/**
 * The scope for a run triggered with `inputs`, or `undefined` when no
 * policy applies (authorization is off, or no snapshot is loaded).
 */
export function createRunVaultScope(
  ctx: RunVaultScopeContext,
  inputs: RunPrincipalInputs,
  runId?: string,
): ServeRunVaultScope | undefined {
  if (ctx.authMode === "none" || !ctx.policySnapshotLoader) return undefined;
  const policy = new ServeRunVaultPolicy(ctx, inputs);
  const scope: { access?: RunVaultAccess; runId?: string } = { runId };
  scope.access = RunVaultAccess.create({
    policy,
    onDenied: (denial) =>
      emitRunVaultDenial(ctx, inputs, policy.principal, denial, scope.runId),
  });
  return scope as ServeRunVaultScope;
}

/** The scope for a scheduled or webhook run of service principal `service`. */
export function serviceRunVaultScope(
  ctx: RunVaultScopeContext,
  service: Principal,
): ServeRunVaultScope | undefined {
  return createRunVaultScope(ctx, {
    source: "service",
    principal: service,
    idpGroups: [],
    collectives: [],
  });
}

/**
 * The scope a resume of `run` executes in: always the principal that
 * triggered the run, never the resumer, with the memberships it recorded. A
 * run whose triggering session held a server token is held to that token as
 * a live run is: once it is revoked or expired, every vault operation is
 * refused while the policy holds a vault grant. A run that recorded no
 * principal is refused every vault operation once the policy holds a vault
 * grant.
 */
export function resumeRunVaultScope(
  ctx: RunVaultScopeContext,
  run: {
    readonly id: string;
    readonly initiatedBy?: string;
    readonly triggeringPrincipal?: RunTriggeringPrincipal;
  },
): ServeRunVaultScope | undefined {
  const recorded = run.triggeringPrincipal;
  return createRunVaultScope(
    ctx,
    recorded
      ? {
        source: "persisted",
        principal: { kind: recorded.kind, id: recorded.id },
        ...(recorded.tokenBinding
          ? { tokenBinding: recorded.tokenBinding }
          : {}),
        idpGroups: recorded.membership.idpGroups,
        collectives: recorded.membership.collectives,
      }
      : {
        source: "missing",
        label: run.initiatedBy ?? "an unrecorded principal",
      },
    run.id,
  );
}

/**
 * Audits a refused run-time vault operation as a socket-free serve event,
 * shaped like a trigger denial: category secrets, outcome denied, with the
 * decision. Audit must never break a run, so a failure is logged and dropped.
 */
export function emitRunVaultDenial(
  ctx: Pick<RunVaultScopeContext, "auditEmitter" | "instanceId">,
  inputs: RunPrincipalInputs,
  principalLabel: string,
  denial: VaultAccessDenial,
  runId: string | undefined,
): void {
  if (!ctx.auditEmitter) return;
  const principal = inputs.source === "missing" ? undefined : inputs.principal;
  const detail = [
    runId !== undefined ? `run=${runId}` : undefined,
    denial.workflow !== undefined ? `workflow=${denial.workflow}` : undefined,
    `reason=${denial.reason}`,
  ].filter((part): part is string => part !== undefined).join(" ");
  try {
    ctx.auditEmitter.emit(buildAuditEvent({
      instanceId: ctx.instanceId ?? "unknown",
      category: "secrets",
      stage: "response",
      outcome: "denied",
      action: `vault.${denial.action}`,
      resourceKind: "vault",
      resourceName: denial.vaultName,
      principalKind: principal?.kind ?? "unknown",
      principalId: principal?.id ?? principalLabel,
      initiatedBy: principalLabel,
      // As emitSystemAuditEvent and trigger denials: loopback, random id.
      sourceIp: "127.0.0.1",
      requestId: runId ?? crypto.randomUUID(),
      detail,
      decision: {
        action: denial.action,
        resourceKind: "vault",
        resourceName: denial.vaultName,
        effect: "deny",
        grantId: denial.grantId ?? null,
        principalGroups: inputs.source === "missing" ? [] : [
          ...inputs.idpGroups,
        ],
      },
    }));
  } catch (error) {
    logger.warn("Failed to emit run vault denial audit event: {error}", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
