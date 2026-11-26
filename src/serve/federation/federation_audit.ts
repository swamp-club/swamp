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

import type { AuditEmitter } from "../../domain/serve_audit/audit_emitter.ts";
import type {
  AuditCategory,
  AuditOutcome,
} from "../../domain/serve_audit/audit_event.ts";
import { buildAuditEvent } from "../../domain/serve_audit/audit_event_builder.ts";
import {
  type Principal,
  principalToString,
} from "../../domain/access/principal.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { WebhookRejectionCoalescer } from "../webhook_audit_coalescer.ts";

const logger = getSwampLogger(["serve", "federation", "audit"]);

export const FEDERATION_AUDIT_ACTIONS = {
  join: "federation.member.join",
  checkInRejected: "federation.member.check_in.rejected",
} as const;

export type JoinRefusalReason = "invalid_token" | "name_taken" | "rate_limited";

export type CheckInRefusalReason =
  | "unauthorized"
  | "instance_limit"
  | "rate_limited";

const CHECK_IN_ROUTE = "federation-check-in";
const JOIN_ROUTE = "federation-join";

export interface FederationAuditOptions {
  /** read per event, since serve may build its emitter after the hub */
  readonly auditEmitter: () => AuditEmitter | undefined;
  readonly instanceId?: string;
  readonly coalescer?: WebhookRejectionCoalescer;
}

interface FederationCaller {
  readonly principal: Principal | null;
  readonly sourceIp: string;
  readonly client?: string;
}

interface FederationAuditEvent {
  readonly category: AuditCategory;
  readonly outcome: AuditOutcome;
  readonly action: string;
  readonly resourceName: string;
  readonly caller: FederationCaller;
  readonly detail?: string;
}

/** names members and reasons only; a join token or credential never reaches an event */
export class FederationAudit {
  readonly #options: FederationAuditOptions;
  readonly #coalescer: WebhookRejectionCoalescer;

  constructor(options: FederationAuditOptions) {
    this.#options = options;
    this.#coalescer = options.coalescer ?? new WebhookRejectionCoalescer();
  }

  joined(sourceIp: string, memberName: string): void {
    this.#emit({
      category: "auth",
      outcome: "success",
      action: FEDERATION_AUDIT_ACTIONS.join,
      resourceName: memberName,
      caller: { principal: null, sourceIp },
    });
  }

  /**
   * memberName is the name a token claimed, when it had the token's shape;
   * rate-limited refusals are coalesced, so a flood cannot grow the trail
   */
  joinRefused(
    sourceIp: string,
    reason: JoinRefusalReason,
    memberName?: string,
  ): void {
    let detail = `reason=${reason}`;
    if (reason === "rate_limited") {
      const admission = this.#coalescer.admit(JOIN_ROUTE, reason);
      if (!admission.emit) return;
      if (admission.suppressed > 0) {
        detail = `${detail} suppressed=${admission.suppressed}`;
      }
    }
    this.#emit({
      category: "auth",
      outcome: "failure",
      action: FEDERATION_AUDIT_ACTIONS.join,
      resourceName: memberName ?? "unknown",
      caller: { principal: null, sourceIp },
      detail,
    });
  }

  /** coalesced per reason, since a stopped member's instances keep calling */
  checkInRefused(sourceIp: string, reason: CheckInRefusalReason): void {
    const admission = this.#coalescer.admit(CHECK_IN_ROUTE, reason);
    if (!admission.emit) return;
    this.#emit({
      category: "auth",
      outcome: "failure",
      action: FEDERATION_AUDIT_ACTIONS.checkInRejected,
      resourceName: "check-in",
      caller: { principal: null, sourceIp },
      detail: admission.suppressed > 0
        ? `reason=${reason} suppressed=${admission.suppressed}`
        : `reason=${reason}`,
    });
  }

  #emit(event: FederationAuditEvent): void {
    const emitter = this.#options.auditEmitter();
    if (emitter === undefined) return;
    const principal = event.caller.principal;
    try {
      emitter.emit(buildAuditEvent({
        instanceId: this.#options.instanceId ?? "unknown",
        category: event.category,
        stage: "response",
        outcome: event.outcome,
        action: event.action,
        resourceKind: "federation-member",
        resourceName: event.resourceName,
        principalKind: principal?.kind ?? "anonymous",
        principalId: principal?.id ?? "anonymous",
        initiatedBy: principal === null
          ? "anonymous"
          : principalToString(principal),
        ...(event.caller.client !== undefined
          ? { client: event.caller.client }
          : {}),
        sourceIp: event.caller.sourceIp,
        requestId: crypto.randomUUID(),
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
      }));
    } catch (error) {
      logger.warn("Failed to emit {action} audit event: {error}", {
        action: event.action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
