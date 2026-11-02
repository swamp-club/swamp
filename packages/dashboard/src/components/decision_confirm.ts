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

export type Decision = "approve" | "reject";

export const MAX_DECISION_REASON_LENGTH = 1024;

export interface DecidedGate {
  decision: Decision;
  decidedBy?: string;
  decidedAt: string;
}

export function gateKey(g: { runId: string; stepName: string }): string {
  return `${g.runId}\u0000${g.stepName}`;
}

/**
 * a listing read before the decision landed still has the gate, so it stays
 * settled rather than offering a second decision; the first listing without it
 * lets it go
 */
export function pruneDecided(
  decided: ReadonlyMap<string, DecidedGate>,
  listed: ReadonlySet<string>,
): ReadonlyMap<string, DecidedGate> {
  let changed = false;
  const kept = new Map<string, DecidedGate>();
  for (const [key, gate] of decided) {
    if (listed.has(key)) kept.set(key, gate);
    else changed = true;
  }
  return changed ? kept : decided;
}

export function decisionReason(text: string): string | undefined {
  const trimmed = text.trim().slice(0, MAX_DECISION_REASON_LENGTH);
  return trimmed === "" ? undefined : trimmed;
}

interface DecisionReply {
  decidedBy?: unknown;
  allGatesDecided?: unknown;
  autoResumed?: unknown;
}

function replyData(reply: unknown): DecisionReply {
  const data = reply && typeof reply === "object"
    ? (reply as { data?: unknown }).data
    : undefined;
  return data && typeof data === "object" ? data as DecisionReply : {};
}

export function decidedGate(
  decision: Decision,
  reply: unknown,
  decidedAt: string,
): DecidedGate {
  const { decidedBy } = replyData(reply);
  return {
    decision,
    ...(typeof decidedBy === "string" && decidedBy !== "" ? { decidedBy } : {}),
    decidedAt,
  };
}

export function decidedLabel(gate: DecidedGate): string {
  const verb = gate.decision === "approve" ? "Approved" : "Rejected";
  return gate.decidedBy ? `${verb} by ${gate.decidedBy}` : verb;
}

export function decisionOutcome(decision: Decision, reply: unknown): string {
  if (decision === "reject") return "the run is rejected";
  const { allGatesDecided, autoResumed } = replyData(reply);
  if (autoResumed === true) return "serve is resuming the run";
  if (allGatesDecided === false) {
    return "other gates on this run are still pending";
  }
  return "the run waits for Resume under Awaiting resume";
}

/**
 * a gate a fresh listing does not hold was decided elsewhere (another tab, the
 * CLI, an earlier click), so say that instead of the refusal
 */
export function refusalMessage(
  decision: Decision,
  error: string,
  stillListed: boolean,
): string {
  if (!stillListed) {
    return "This gate was already decided; the run is shown where it now is";
  }
  return `${decision === "approve" ? "Approve" : "Reject"} failed: ${error}`;
}
