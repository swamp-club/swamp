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

// What the Activity page and the sidebar know about serve's audit log.
// Serve has no "is audit on" flag: `audit.subscribe` answers
// `audit_not_configured` when no audit store is set up, and the access
// checks answer `unauthorized` / `access_not_configured` to a principal
// without admin on audit.

/**
 * - disabled: serve runs without an audit log
 * - denied: the signed-in principal may not read it
 * - connecting: subscribing to the live feed
 * - live: the live feed is streaming
 * - paused: the viewer paused the live feed
 * - error: the feed failed for another reason
 */
export type AuditStatus =
  | "disabled"
  | "denied"
  | "connecting"
  | "live"
  | "paused"
  | "error";

export type AuditProblem = "disabled" | "denied" | "error";

const DISABLED_CODES = new Set(["audit_not_configured"]);
const DENIED_CODES = new Set([
  "unauthorized",
  "access_not_configured",
  "forbidden",
]);

/** What an error code from an audit request means for the page. */
export function classifyAuditError(
  code: string | null | undefined,
): AuditProblem {
  if (code && DISABLED_CODES.has(code)) return "disabled";
  if (code && DENIED_CODES.has(code)) return "denied";
  return "error";
}

export function auditStatus(input: {
  liveEnabled: boolean;
  streaming: boolean;
  problem: AuditProblem | null;
}): AuditStatus {
  const { liveEnabled, streaming, problem } = input;
  // Disabled and denied hold whatever the live toggle says: there is
  // nothing to connect to.
  if (problem === "disabled" || problem === "denied") return problem;
  if (streaming) return "live";
  if (!liveEnabled) return "paused";
  if (problem === "error") return "error";
  return "connecting";
}

/**
 * Whether serve has an audit log: false only once serve said it has none,
 * so the sidebar never fades Activity on a guess.
 */
export function auditEnabled(status: AuditStatus): boolean {
  return status !== "disabled";
}
