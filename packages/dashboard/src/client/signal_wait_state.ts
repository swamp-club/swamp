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

/** What a wait for a signal needs next. */
export type SignalWaitState = "open" | "signalled" | "expired";

/** The receipt of the signal that settled a wait. */
export interface SignalReceiptInfo {
  id: string;
  submittedBy: string;
  receivedAt: string;
}

/** A wait for a signal as the dashboard lists it. */
export interface SignalWaitRow {
  waitId: string;
  /**
   * `open`: nothing has answered it. `signalled`: a signal settled it and
   * the run has not been resumed. `expired`: its deadline passed, and a
   * resume fails the step.
   */
  state: SignalWaitState;
  workflowName: string;
  runId: string;
  stepName: string;
  deadline: string;
  /** The payload schema a signal has to match; only an open wait has one. */
  schema?: unknown;
  /** Set on a signalled wait. */
  receipt?: SignalReceiptInfo;
  /** A signalled wait whose run nothing else holds back: it can be resumed. */
  awaitingResume: boolean;
  /** The CLI command that moves the wait on. */
  command: string;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> =>
      typeof v === "object" && v !== null
    )
    : [];
}

function baseOf(
  item: Record<string, unknown>,
): Omit<SignalWaitRow, "state" | "awaitingResume"> | undefined {
  const waitId = text(item.waitId);
  const workflowName = text(item.workflowName);
  const runId = text(item.runId);
  const stepName = text(item.stepName);
  if (!waitId || !workflowName || !runId || !stepName) return undefined;
  return {
    waitId,
    workflowName,
    runId,
    stepName,
    deadline: text(item.deadline) ?? "",
    command: text(item.nextCommand) ?? "",
  };
}

function receiptOf(value: unknown): SignalReceiptInfo | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const signal = value as Record<string, unknown>;
  const id = text(signal.id);
  if (!id) return undefined;
  return {
    id,
    submittedBy: text(signal.submittedBy) ?? "unknown",
    receivedAt: text(signal.receivedAt) ?? "",
  };
}

/**
 * The rows to list from a `workflow.waits` reply asked for with
 * `includeSignalled`: open waits first, then signalled ones, then expired
 * ones, each group in the order serve sent it. A reply that is missing,
 * such as one refused to a caller who may read no workflow, lists nothing.
 * An entry without the fields a row needs is left out.
 */
export function signalWaitRows(payload: unknown): SignalWaitRow[] {
  if (typeof payload !== "object" || payload === null) return [];
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return [];
  const listed = data as { waits?: unknown; signalled?: unknown };

  const open: SignalWaitRow[] = [];
  const expired: SignalWaitRow[] = [];
  for (const item of records(listed.waits)) {
    const base = baseOf(item);
    if (!base) continue;
    if (item.expired === true) {
      expired.push({ ...base, state: "expired", awaitingResume: false });
    } else {
      open.push({
        ...base,
        state: "open",
        awaitingResume: false,
        ...(item.schema !== undefined ? { schema: item.schema } : {}),
      });
    }
  }

  const signalled: SignalWaitRow[] = [];
  for (const item of records(listed.signalled)) {
    const base = baseOf(item);
    const receipt = receiptOf(item.signal);
    if (!base || !receipt) continue;
    signalled.push({
      ...base,
      state: "signalled",
      receipt,
      awaitingResume: item.awaitingResume === true,
    });
  }

  return [...open, ...signalled, ...expired];
}
