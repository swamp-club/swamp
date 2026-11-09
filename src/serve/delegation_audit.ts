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

import { integrationClient } from "../domain/access/client.ts";
import type { AuditEmitter } from "../domain/serve_audit/audit_emitter.ts";
import type { AuditOutcome } from "../domain/serve_audit/audit_event.ts";
import { buildAuditEvent } from "../domain/serve_audit/audit_event_builder.ts";
import type { DelegationRecord } from "../domain/models/access/delegation_model.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { DelegationAuditRecord } from "./delegation_routes.ts";

const logger = getSwampLogger(["serve", "delegation-audit"]);

const FAILURES = new Set(["refused", "club_end_failed"]);

function outcomeOf(event: DelegationAuditRecord): AuditOutcome {
  if (FAILURES.has(event.action)) {
    return event.action === "refused" ? "denied" : "failure";
  }
  if (event.action === "consent_result" && event.outcome !== "approved") {
    return "denied";
  }
  return "success";
}

/**
 * what a reader needs to follow one link across serve and swamp-club, and
 * nothing that could act as it: ids and outcomes only, never a token, secret or
 * consent URL
 */
export function delegationAuditDetail(
  record: DelegationRecord,
  outcome: string,
  extra?: string,
): string {
  const parts = [
    `outcome=${outcome}`,
    `request=${record.club.requestId}`,
    ...(record.club.linkId ? [`link=${record.club.linkId}`] : []),
    `external=${record.external.platform}/${record.external.teamId}/${record.external.userId}`,
    ...(extra ? [extra] : []),
  ];
  return parts.join(" ");
}

export function createDelegationAuditor(
  ctx: { auditEmitter?: Pick<AuditEmitter, "emit">; instanceId?: string },
): (event: DelegationAuditRecord) => void {
  return (event) => {
    if (!ctx.auditEmitter) return;
    const record = event.record;
    const person = record.person;
    try {
      ctx.auditEmitter.emit(buildAuditEvent({
        instanceId: ctx.instanceId ?? "unknown",
        category: "auth",
        stage: "response",
        outcome: outcomeOf(event),
        action: `delegation.${event.action}`,
        resourceKind: "delegation",
        resourceName: record.id,
        principalKind: person ? "user" : "integration",
        principalId: person ? person.sub : record.integrationId,
        initiatedBy: person?.username ??
          integrationClient(record.integrationId),
        actor: person
          ? {
            email: person.email,
            ...(person.username ? { username: person.username } : {}),
          }
          : undefined,
        client: integrationClient(record.integrationId),
        delegation: record.id,
        sourceIp: "server",
        requestId: crypto.randomUUID(),
        detail: delegationAuditDetail(record, event.outcome, event.detail),
      }));
    } catch (error) {
      logger.warn("Failed to emit a delegation audit event: {error}", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
