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

import type { AuditEmitter } from "../domain/serve_audit/audit_emitter.ts";
import { buildAuditEvent } from "../domain/serve_audit/audit_event_builder.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { WebhookEndpointDiff, WebhookRouteChange } from "./webhook.ts";

const logger = getSwampLogger(["serve", "webhook-route-audit"]);

export const WEBHOOK_ROUTES_APPLIED_ACTION = "webhook.routes.applied";

// keeps one event bounded when a deploy touches many route files
const MAX_LISTED = 50;

export interface WebhookRouteAuditContext {
  readonly auditEmitter?: AuditEmitter;
  readonly instanceId?: string;
}

/** carries routes, files and schemes only; never a secret or a refusal text */
export interface WebhookRoutesAppliedAudit {
  readonly context: {
    readonly trigger: string;
    readonly principal?: { readonly kind: string; readonly id: string };
    readonly client?: string;
    readonly sourceIp?: string;
  };
  readonly diff: WebhookEndpointDiff;
  readonly refused: ReadonlyArray<
    { readonly file: string; readonly route?: string }
  >;
  readonly kept: ReadonlyArray<
    { readonly file: string; readonly route: string; readonly reason: string }
  >;
  readonly directoryError?: string;
  readonly outcome: "success" | "failure";
}

function sourceLabel(change: WebhookRouteChange): string {
  return change.source === "file" ? `file:${change.file ?? ""}` : change.source;
}

function list(items: readonly string[]): string | undefined {
  if (items.length === 0) return undefined;
  const shown = items.slice(0, MAX_LISTED).join(",");
  return items.length > MAX_LISTED
    ? `${shown},+${items.length - MAX_LISTED} more`
    : shown;
}

export function webhookRoutesAppliedDetail(
  audit: WebhookRoutesAppliedAudit,
): string {
  const changes = (items: readonly WebhookRouteChange[]) =>
    list(items.map((c) => `${c.route}(${sourceLabel(c)})`));
  const fields: [string, string | undefined][] = [
    ["trigger", audit.context.trigger],
    ["added", changes(audit.diff.added)],
    ["changed", changes(audit.diff.changed)],
    ["removed", changes(audit.diff.removed)],
    [
      "kept",
      list(audit.kept.map((k) => `${k.route}(file:${k.file},${k.reason})`)),
    ],
    [
      "refused",
      list(
        audit.refused.map((r) =>
          r.route !== undefined
            ? `${r.route}(file:${r.file})`
            : `file:${r.file}`
        ),
      ),
    ],
    [
      "directory",
      audit.directoryError !== undefined ? "unusable" : undefined,
    ],
  ];
  return fields
    .filter((field): field is [string, string] => field[1] !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

/** audit must never break a reload or a poll, so an emitter failure is dropped */
export function emitWebhookRoutesApplied(
  ctx: WebhookRouteAuditContext,
  audit: WebhookRoutesAppliedAudit,
): void {
  if (!ctx.auditEmitter) return;
  const principal = audit.context.principal;
  try {
    ctx.auditEmitter.emit(buildAuditEvent({
      instanceId: ctx.instanceId ?? "unknown",
      category: "admin",
      stage: "response",
      outcome: audit.outcome,
      action: WEBHOOK_ROUTES_APPLIED_ACTION,
      resourceKind: "server",
      resourceName: ctx.instanceId ?? "unknown",
      principalKind: principal?.kind ?? "system",
      principalId: principal?.id ?? "system",
      initiatedBy: principal ? `${principal.kind}:${principal.id}` : "system",
      // a poll or a signal has no caller, so no client
      ...(audit.context.client !== undefined
        ? { client: audit.context.client }
        : {}),
      sourceIp: audit.context.sourceIp ?? "127.0.0.1",
      requestId: crypto.randomUUID(),
      detail: webhookRoutesAppliedDetail(audit),
    }));
  } catch (error) {
    logger.warn("Failed to emit {action} audit event: {error}", {
      action: WEBHOOK_ROUTES_APPLIED_ACTION,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
