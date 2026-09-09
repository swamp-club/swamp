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

import type {
  AuditCategory,
  AuditEvent,
} from "../../domain/serve_audit/audit_event.ts";

const DEVICE_VENDOR = "SwampClub";
const DEVICE_PRODUCT = "SwampServe";
const CEF_VERSION = "0";
const DEVICE_VERSION = "1.0";

const SEVERITY_MAP: Record<AuditCategory, number> = {
  secrets: 10,
  admin: 7,
  auth: 6,
  access: 6,
  execution: 5,
  data: 3,
  system: 3,
};

const ACTION_LABELS: Record<string, string> = {
  "vault.read-secret": "Vault secret read",
  "vault.put-secret": "Vault secret write",
  "vault.delete-secret": "Vault secret delete",
  "auth.login": "User login",
  "auth.logout": "User logout",
  "access.grant.create": "Access grant created",
  "access.grant.delete": "Access grant deleted",
  "instance.start": "Instance started",
  "instance.stop": "Instance stopped",
  "instance.join": "Instance joined cluster",
  "instance.leave": "Instance left cluster",
  "health.transition": "Health state changed",
};

function escapeHeader(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function escapeExtension(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/=/g, "\\=")
    .replace(/\n/g, "\\n");
}

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/\./g, " ");
}

export interface CefFormatOptions {
  readonly namespace?: string;
}

export function formatCefLine(
  event: AuditEvent,
  options?: CefFormatOptions,
): string {
  const severity = SEVERITY_MAP[event.category] ?? 5;
  const name = actionLabel(event.action);

  const header = [
    `CEF:${CEF_VERSION}`,
    escapeHeader(DEVICE_VENDOR),
    escapeHeader(DEVICE_PRODUCT),
    escapeHeader(DEVICE_VERSION),
    escapeHeader(event.action),
    escapeHeader(name),
    String(severity),
  ].join("|");

  const extensions: string[] = [
    `src=${escapeExtension(`${event.principalKind}:${event.principalId}`)}`,
    `dst=${escapeExtension(`${event.resourceKind}:${event.resourceName}`)}`,
    `outcome=${escapeExtension(event.outcome)}`,
    `rt=${escapeExtension(event.timestamp)}`,
    `cs3=${escapeExtension(event.instanceId)}`,
    `cs3Label=instanceId`,
  ];

  if (options?.namespace) {
    extensions.push(`cs1=${escapeExtension(options.namespace)}`);
    extensions.push("cs1Label=namespace");
  }

  if (event.decision?.grantId) {
    extensions.push(`cs2=${escapeExtension(event.decision.grantId)}`);
    extensions.push("cs2Label=grantId");
  }

  if (event.sourceIp) {
    extensions.push(`spt=${escapeExtension(event.sourceIp)}`);
  }

  return `${header}|${extensions.join(" ")}`;
}
