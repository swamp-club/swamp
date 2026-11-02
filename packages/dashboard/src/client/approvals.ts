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

export interface ApprovalInfo {
  workflowName: string;
  runId: string;
  stepName: string;
  suspendedAt?: string;
  prompt?: string;
  inputs?: Readonly<Record<string, unknown>>;
  initiatedBy?: string;
  /**
   * Whether this viewer holds `approve` on the gate's workflow. Absent from
   * a serve that does not say; serve decides on the request either way.
   */
  canDecide?: boolean;
  parentRun?: { workflowName: string; runId: string };
  parentWaiting?: boolean;
}

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
 * the shared listing; `expired` is absent from replies of serve versions that
 * do not list expired gates
 */
export interface ApprovalsReply {
  data?: { approvals?: ApprovalInfo[]; expired?: ExpiredGate[] };
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

export function pendingApprovals(payload: unknown): ApprovalInfo[] {
  return listAt<ApprovalInfo>(payload, "approvals");
}

export function expiredApprovals(payload: unknown): ExpiredGate[] {
  return listAt<ExpiredGate>(payload, "expired");
}
