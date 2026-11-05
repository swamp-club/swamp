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

import type { AuditEvent } from "../../domain/serve_audit/audit_event.ts";

export const AUDIT_CSV_HEADER =
  "id,timestamp,instanceId,category,action,stage,outcome,principalKind,principalId,initiatedBy,client,sourceIp,requestId,resourceKind,resourceName,decision.effect,decision.grantId,detail";

export function formatAuditCsvRow(e: AuditEvent): string {
  const fields = [
    e.id,
    e.timestamp,
    e.instanceId,
    e.category,
    e.action,
    e.stage,
    e.outcome,
    e.principalKind,
    e.principalId,
    e.initiatedBy,
    e.client ?? "",
    e.sourceIp,
    e.requestId,
    e.resourceKind,
    e.resourceName,
    e.decision?.effect ?? "",
    e.decision?.grantId ?? "",
    e.detail ?? "",
  ];
  return fields.map((f) => {
    let s = String(f);
    if (/^[=+\-@\t\r]/.test(s)) {
      s = `\t${s}`;
    }
    if (
      s.includes(",") || s.includes('"') || s.includes("\n")
    ) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }).join(",");
}
