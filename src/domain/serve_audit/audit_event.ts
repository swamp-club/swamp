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

export type AuditCategory =
  | "auth"
  | "access"
  | "execution"
  | "secrets"
  | "admin"
  | "data"
  | "system";

export type AuditStage = "request" | "response";

export type AuditOutcome = "success" | "failure" | "denied";

export interface AuditDecision {
  readonly action: string;
  readonly resourceKind: string;
  readonly resourceName: string;
  readonly effect: "allow" | "deny";
  readonly grantId: string | null;
  readonly principalGroups: readonly string[];
}

export interface AuditEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly instanceId: string;
  readonly category: AuditCategory;
  readonly stage: AuditStage;
  readonly outcome: AuditOutcome;
  readonly action: string;
  readonly resourceKind: string;
  readonly resourceName: string;
  readonly principalKind: string;
  readonly principalId: string;
  readonly initiatedBy: string;
  readonly sourceIp: string;
  readonly requestId: string;
  readonly methodName?: string;
  readonly detail?: string;
  readonly version?: number;
  readonly sequence?: number;
  readonly digest?: string;
  readonly decision?: AuditDecision;
}

export type ChainedAuditEvent = AuditEvent & {
  readonly version: 1;
  readonly sequence: number;
  readonly digest: string;
};

export function createAuditEvent(
  fields: Omit<AuditEvent, "id" | "timestamp">,
): AuditEvent {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...fields,
  };
}
