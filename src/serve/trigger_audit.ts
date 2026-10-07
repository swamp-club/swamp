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

import {
  type Principal,
  principalToString,
} from "../domain/access/principal.ts";
import type { AuditEmitter } from "../domain/serve_audit/audit_emitter.ts";
import type { AuditOutcome } from "../domain/serve_audit/audit_event.ts";
import { buildAuditEvent } from "../domain/serve_audit/audit_event_builder.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type {
  ScheduledExecutionEvent,
  ScheduledRunAuthorizer,
} from "../libswamp/workflows/scheduled_execution.ts";
import {
  SCHEDULER_PRINCIPAL,
  WEBHOOK_PRINCIPAL,
} from "../domain/access/service_principal.ts";
import type { WebhookEvent, WebhookRunAuthorizer } from "./webhook.ts";
import type { WebhookRejectionCoalescer } from "./webhook_audit_coalescer.ts";
import type {
  TriggerAuthorization,
  TriggerAuthorizer,
} from "./trigger_authorizer.ts";

const logger = getSwampLogger(["serve", "trigger-audit"]);

/** Source address recorded for runs serve starts itself (cron fires). */
export const LOCAL_SOURCE_IP = "127.0.0.1";

export interface TriggerAuditContext {
  readonly auditEmitter?: AuditEmitter;
  readonly instanceId?: string;
}

/** One scheduled or webhook trigger event, attributed to a service principal. */
export interface TriggerAudit {
  readonly principal: Principal;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly workflowName: string;
  readonly sourceIp: string;
  /** key=value pairs, rendered in order. Undefined values are dropped. */
  readonly detail: Readonly<
    Record<string, string | number | boolean | undefined>
  >;
}

function renderDetail(detail: TriggerAudit["detail"]): string {
  return Object.entries(detail)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

/**
 * Emits a trigger event in the execution category. Audit must never break a
 * run or a webhook response, so an emitter failure is logged and dropped.
 */
export function emitTriggerAuditEvent(
  ctx: TriggerAuditContext,
  audit: TriggerAudit,
): void {
  if (!ctx.auditEmitter) return;
  try {
    ctx.auditEmitter.emit(buildAuditEvent({
      instanceId: ctx.instanceId ?? "unknown",
      category: "execution",
      stage: "response",
      outcome: audit.outcome,
      action: audit.action,
      resourceKind: "workflow",
      resourceName: audit.workflowName,
      principalKind: audit.principal.kind,
      principalId: audit.principal.id,
      initiatedBy: principalToString(audit.principal),
      sourceIp: audit.sourceIp,
      requestId: crypto.randomUUID(),
      detail: renderDetail(audit.detail),
    }));
  } catch (error) {
    logger.warn("Failed to emit {action} audit event: {error}", {
      action: audit.action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Emits the access denial for a refused trigger run, shaped like the
 * WebSocket path's denials (category access, action run, with the decision).
 */
export function emitTriggerDenial(
  ctx: TriggerAuditContext,
  principal: Principal,
  authorization: TriggerAuthorization,
  sourceIp: string,
  detail: TriggerAudit["detail"],
): void {
  if (!ctx.auditEmitter) return;
  try {
    ctx.auditEmitter.emit(buildAuditEvent({
      instanceId: ctx.instanceId ?? "unknown",
      category: "access",
      stage: "response",
      outcome: "denied",
      action: "run",
      resourceKind: authorization.resource.kind,
      resourceName: authorization.resource.name,
      principalKind: principal.kind,
      principalId: principal.id,
      initiatedBy: principalToString(principal),
      sourceIp,
      requestId: crypto.randomUUID(),
      detail: renderDetail({ ...detail, reason: authorization.reason }),
      decision: {
        action: "run",
        resourceKind: authorization.resource.kind,
        resourceName: authorization.resource.name,
        effect: authorization.decision?.effect ?? "deny",
        grantId: authorization.decision?.grantId ?? null,
        principalGroups: [],
      },
    }));
  } catch (error) {
    logger.warn("Failed to emit trigger denial audit event: {error}", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Maps scheduler events to audit events: a run that starts is a
 * `workflow.schedule.fire`, a fire that does not run is a
 * `workflow.schedule.skipped`. An overlap skip is a failure (the fire was
 * lost); a dedup skip is a success (another instance ran it). Refusals are
 * audited by the authorizer, which holds the decision.
 */
export function auditScheduledEvent(
  ctx: TriggerAuditContext,
  event: ScheduledExecutionEvent,
): void {
  switch (event.kind) {
    case "schedule_started":
      emitTriggerAuditEvent(ctx, {
        principal: SCHEDULER_PRINCIPAL,
        action: "workflow.schedule.fire",
        outcome: "success",
        workflowName: event.workflowName,
        sourceIp: LOCAL_SOURCE_IP,
        detail: {
          run: event.runId,
          fireTime: event.fireTime,
          replayed: event.replayed || undefined,
        },
      });
      return;
    case "schedule_skipped":
      emitTriggerAuditEvent(ctx, {
        principal: SCHEDULER_PRINCIPAL,
        action: "workflow.schedule.skipped",
        outcome: event.dedupSkip ? "success" : "failure",
        workflowName: event.workflowName,
        sourceIp: LOCAL_SOURCE_IP,
        detail: {
          fireTime: event.fireTime,
          reason: event.dedupSkip ? "dedup" : "overlap",
        },
      });
      return;
  }
}

/**
 * The scheduler's authorizer: decides as the scheduler principal and audits
 * each refusal with its decision.
 */
export function createScheduledRunAuthorizer(
  authorize: TriggerAuthorizer,
  ctx: TriggerAuditContext,
): ScheduledRunAuthorizer {
  return async (request) => {
    const authorization = await authorize(
      SCHEDULER_PRINCIPAL,
      request.workflowName,
    );
    if (!authorization.allowed) {
      emitTriggerDenial(
        ctx,
        SCHEDULER_PRINCIPAL,
        authorization,
        LOCAL_SOURCE_IP,
        {
          fireTime: request.fireTime?.toISOString(),
          replayed: request.replayed || undefined,
        },
      );
    }
    return authorization;
  };
}

/**
 * Maps webhook events to audit events: a run that starts is a
 * `workflow.webhook.fire`, a delivery refused before queueing is a
 * `workflow.webhook.rejected`, coalesced so unauthenticated traffic cannot
 * flood the audit log. Refusals are audited by the authorizer.
 */
export function auditWebhookEvent(
  ctx: TriggerAuditContext,
  event: WebhookEvent,
  coalescer: WebhookRejectionCoalescer,
): void {
  switch (event.kind) {
    case "webhook_started":
      emitTriggerAuditEvent(ctx, {
        principal: WEBHOOK_PRINCIPAL,
        action: "workflow.webhook.fire",
        outcome: "success",
        workflowName: event.workflowName,
        sourceIp: event.sourceIp ?? "unknown",
        detail: {
          route: event.route,
          run: event.runId,
          replayed: event.replayed || undefined,
        },
      });
      return;
    case "webhook_rejected": {
      const admission = coalescer.admit(event.route, event.reason);
      if (!admission.emit) return;
      emitTriggerAuditEvent(ctx, {
        principal: WEBHOOK_PRINCIPAL,
        action: "workflow.webhook.rejected",
        outcome: "failure",
        workflowName: event.workflowName,
        sourceIp: event.sourceIp ?? "unknown",
        detail: {
          route: event.route,
          reason: event.reason,
          suppressed: admission.suppressed || undefined,
        },
      });
      return;
    }
  }
}

/**
 * The webhook service's authorizer: decides as the webhook principal and
 * audits each refusal with its decision.
 */
export function createWebhookRunAuthorizer(
  authorize: TriggerAuthorizer,
  ctx: TriggerAuditContext,
): WebhookRunAuthorizer {
  return async (request) => {
    const authorization = await authorize(
      WEBHOOK_PRINCIPAL,
      request.workflowIdOrName,
    );
    if (!authorization.allowed) {
      emitTriggerDenial(
        ctx,
        WEBHOOK_PRINCIPAL,
        authorization,
        request.sourceIp ?? "unknown",
        { route: request.route, replayed: request.replayed || undefined },
      );
    }
    return authorization;
  };
}
