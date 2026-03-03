// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

/**
 * Source of an audit timeline entry.
 * - "swamp": command was executed through swamp CLI
 * - "direct": command was executed directly via bash (not through swamp)
 */
export type AuditSource = "swamp" | "direct";

/**
 * Status of an audit entry.
 */
export type AuditStatus = "success" | "error" | "user_error";

/**
 * Unified audit timeline entry.
 * Merges telemetry data (swamp commands) with hook-captured bash commands.
 */
export interface AuditEntry {
  readonly timestamp: string;
  readonly source: AuditSource;
  readonly summary: string;
  readonly status: AuditStatus;
  readonly sessionId?: string;
  readonly durationMs?: number;
  /** Exit code, present only for failed commands */
  readonly exitCode?: number;
  /** Error message, present only for failed commands */
  readonly error?: string;
}

/**
 * Data transfer object for AuditEntry.
 */
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

/**
 * Creates an AuditEntry from a swamp telemetry record.
 */
export function createSwampAuditEntry(
  timestamp: string,
  summary: string,
  status: AuditStatus,
  durationMs?: number,
): AuditEntry {
  return { timestamp, source: "swamp", summary, status, durationMs };
}

/**
 * Creates an AuditEntry from a direct bash command.
 */
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

/**
 * Converts an AuditEntry to its data representation.
 */
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
