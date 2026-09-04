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
import type { AuditCategory } from "../domain/serve_audit/audit_event.ts";
import { buildAuditEvent } from "../domain/serve_audit/audit_event_builder.ts";
import type { Principal } from "../domain/access/principal.ts";

export interface AuditedOptions {
  readonly emitter: AuditEmitter | undefined;
  readonly instanceId: string;
  readonly category: AuditCategory;
  readonly action: string;
  readonly resourceKind: string;
  readonly resourceName: string;
  readonly principal: Principal | null;
  readonly requestId: string;
}

export function audited(
  handler: Promise<void>,
  options: AuditedOptions,
): Promise<void> {
  if (!options.emitter) return handler;

  return handler.then(() => {
    options.emitter!.emit(buildAuditEvent({
      instanceId: options.instanceId,
      category: options.category,
      stage: "response",
      outcome: "success",
      action: options.action,
      resourceKind: options.resourceKind,
      resourceName: options.resourceName,
      principalKind: options.principal?.kind,
      principalId: options.principal?.id,
      requestId: options.requestId,
    }));
  }, (error: unknown) => {
    options.emitter!.emit(buildAuditEvent({
      instanceId: options.instanceId,
      category: options.category,
      stage: "response",
      outcome: "failure",
      action: options.action,
      resourceKind: options.resourceKind,
      resourceName: options.resourceName,
      principalKind: options.principal?.kind,
      principalId: options.principal?.id,
      requestId: options.requestId,
      detail: error instanceof Error ? error.message : String(error),
    }));
    throw error;
  });
}
