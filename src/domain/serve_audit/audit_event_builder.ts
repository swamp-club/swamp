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
  type AuditCategory,
  type AuditEvent,
  type AuditOutcome,
  type AuditStage,
  createAuditEvent,
} from "./audit_event.ts";

const ABSOLUTE_PATH_PATTERN =
  /(?:^|[\s"'`(])\/(?:opt|home|var|tmp|etc|usr|root|Users|private|proc|sys|mnt|srv|run)\//;

const WINDOWS_PATH_PATTERN = /[A-Z]:\\/i;

const SWAMP_INTERNAL_PATH_PATTERN = /\/.swamp\//;

function sanitize(value: string): string {
  if (
    ABSOLUTE_PATH_PATTERN.test(value) ||
    WINDOWS_PATH_PATTERN.test(value) ||
    SWAMP_INTERNAL_PATH_PATTERN.test(value)
  ) {
    return "[redacted]";
  }
  return value;
}

export interface AuditEventInput {
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
}

export function buildAuditEvent(input: AuditEventInput): AuditEvent {
  return createAuditEvent({
    instanceId: input.instanceId,
    category: input.category,
    stage: input.stage,
    outcome: input.outcome,
    action: sanitize(input.action),
    resourceKind: input.resourceKind,
    resourceName: sanitize(input.resourceName),
    principalKind: input.principalKind,
    principalId: input.principalId,
    initiatedBy: input.initiatedBy,
    sourceIp: input.sourceIp,
    requestId: input.requestId,
    methodName: input.methodName,
    detail: input.detail ? sanitize(input.detail) : undefined,
  });
}
