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
import type { SettingsReloadReport } from "./serve_settings_reload.ts";

/** what started a reload: a signal, a poll, or a caller over the socket */
export interface ServeReloadCaller {
  readonly trigger: string;
  readonly principal?: { readonly kind: string; readonly id: string };
  readonly client?: string;
  readonly sourceIp?: string;
}

const logger = getSwampLogger(["serve", "config-reload-audit"]);

export const SERVE_CONFIG_RELOADED_ACTION = "serve.config.reloaded";

export interface ServeConfigReloadAuditContext {
  readonly auditEmitter?: AuditEmitter;
  readonly instanceId?: string;
}

/** setting names and reasons only; never a value, which may be a secret */
export function serveConfigReloadedDetail(
  trigger: string,
  report: SettingsReloadReport,
): string {
  const fields: [string, string][] = [["trigger", trigger]];
  if (report.applied.length > 0) {
    fields.push(["applied", report.applied.join(",")]);
  }
  if (report.needsRestart.length > 0) {
    fields.push([
      "needs-restart",
      report.needsRestart.map((entry) => entry.setting).join(","),
    ]);
  }
  if (report.overridden.length > 0) {
    fields.push([
      "overridden",
      report.overridden.map((entry) => entry.setting).join(","),
    ]);
  }
  return fields.map(([key, value]) => `${key}=${value}`).join(" ");
}

/**
 * under the policy in force before the reload, so lowering auditing still
 * leaves its own record; an emitter failure never breaks a reload
 */
export function emitServeConfigReloaded(
  ctx: ServeConfigReloadAuditContext,
  context: ServeReloadCaller,
  report: SettingsReloadReport,
): void {
  if (!ctx.auditEmitter) return;
  const principal = context.principal;
  try {
    ctx.auditEmitter.emit(buildAuditEvent({
      instanceId: ctx.instanceId ?? "unknown",
      category: "admin",
      stage: "response",
      outcome: "success",
      action: SERVE_CONFIG_RELOADED_ACTION,
      resourceKind: "server",
      resourceName: ctx.instanceId ?? "unknown",
      principalKind: principal?.kind ?? "system",
      principalId: principal?.id ?? "system",
      initiatedBy: principal ? `${principal.kind}:${principal.id}` : "system",
      // a signal or a poll has no caller, so no client
      ...(context.client !== undefined ? { client: context.client } : {}),
      sourceIp: context.sourceIp ?? "127.0.0.1",
      requestId: crypto.randomUUID(),
      detail: serveConfigReloadedDetail(context.trigger, report),
    }));
  } catch (error) {
    logger.warn("Failed to emit {action} audit event: {error}", {
      action: SERVE_CONFIG_RELOADED_ACTION,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
