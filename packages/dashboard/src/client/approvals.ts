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

/** A gate that can still be approved or rejected. */
export interface ApprovalInfo {
  workflowName: string;
  runId: string;
  stepName: string;
  suspendedAt?: string;
  prompt?: string;
  inputs?: Readonly<Record<string, unknown>>;
  /** On a nested workflow's run, the parent that started it. */
  parentRun?: { workflowName: string; runId: string };
  /** Whether that parent still waits on this run. */
  parentWaiting?: boolean;
}

/** A gate past its timeout: it can only be cancelled. */
export interface ExpiredGate {
  workflowId: string;
  workflowName: string;
  runId: string;
  stepName: string;
  suspendedAt: string;
  timeoutSeconds: number;
  expiredAt: string;
  parentRun?: { workflowName: string; runId: string };
  parentWaiting?: boolean;
}

/**
 * Reads one list of a `workflow.approvals` reply by its key. The reply holds
 * more than one list, so it is never read by position.
 */
function listAt<T>(payload: unknown, key: string): T[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as Record<string, unknown>).data;
  if (!data || typeof data !== "object") return [];
  const list = (data as Record<string, unknown>)[key];
  return Array.isArray(list) ? list as T[] : [];
}

/** The gates still waiting for a decision. */
export function pendingApprovals(payload: unknown): ApprovalInfo[] {
  return listAt<ApprovalInfo>(payload, "approvals");
}

/** The gates past their timeout. Empty for a serve that does not list them. */
export function expiredApprovals(payload: unknown): ExpiredGate[] {
  return listAt<ExpiredGate>(payload, "expired");
}
