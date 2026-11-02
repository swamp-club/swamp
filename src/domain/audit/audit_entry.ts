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

export type AuditSource = "swamp" | "direct";

export type AuditStatus = "success" | "error" | "user_error";

export interface AuditEntry {
  readonly timestamp: string;
  readonly source: AuditSource;
  readonly summary: string;
  readonly status: AuditStatus;
  readonly sessionId?: string;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly error?: string;
}

export interface AuditEntryData {
  timestamp: string;
  source: AuditSource;
  summary: string;
  status: AuditStatus;
  sessionId?: string;
  durationMs?: number;
  exitCode?: number;
  error?: string;
}

export function createSwampAuditEntry(
  timestamp: string,
  summary: string,
  status: AuditStatus,
  durationMs?: number,
): AuditEntry {
  return { timestamp, source: "swamp", summary, status, durationMs };
}

export function createDirectAuditEntry(
  timestamp: string,
  summary: string,
  sessionId: string | undefined,
  failure?: { exitCode?: number; error?: string },
): AuditEntry {
  return {
    timestamp,
    source: "direct",
    summary,
    status: failure ? "error" : "success",
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(failure?.exitCode !== undefined ? { exitCode: failure.exitCode } : {}),
    ...(failure?.error ? { error: failure.error } : {}),
  };
}

export function auditEntryToData(entry: AuditEntry): AuditEntryData {
  const data: AuditEntryData = {
    timestamp: entry.timestamp,
    source: entry.source,
    summary: entry.summary,
    status: entry.status,
  };
  if (entry.sessionId !== undefined) {
    data.sessionId = entry.sessionId;
  }
  if (entry.durationMs !== undefined) {
    data.durationMs = entry.durationMs;
  }
  if (entry.exitCode !== undefined) {
    data.exitCode = entry.exitCode;
  }
  if (entry.error) {
    data.error = entry.error;
  }
  return data;
}
