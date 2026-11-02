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

/** Approve or reject: the two decisions a gate takes. */
export type Decision = "approve" | "reject";

/** The longest reason the page sends with a decision. */
export const MAX_DECISION_REASON_LENGTH = 1024;

/** A gate decided from this page, held until a listing no longer has it. */
export interface DecidedGate {
  decision: Decision;
  /** Who serve recorded as deciding; absent when the reply named no one. */
  decidedBy?: string;
  /** When the reply landed, as an ISO time. */
  decidedAt: string;
}

/** Identifies a gate across listings. */
export function gateKey(g: { runId: string; stepName: string }): string {
  return `${g.runId}\u0000${g.stepName}`;
}

/**
 * Keeps the decided gates a listing still holds. A listing read before the
 * decision landed still has the gate, so it stays settled rather than
 * offering a second decision; the first listing without it lets it go
 * (swamp-club#3697).
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

/** The reason to send: trimmed, capped, and absent when blank. */
export function decisionReason(text: string): string | undefined {
  const trimmed = text.trim().slice(0, MAX_DECISION_REASON_LENGTH);
  return trimmed === "" ? undefined : trimmed;
}

/** The fields of an approve or reject reply the page reads. */
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

/** Records a decision serve accepted. */
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

/** "Approved by user:alice", or "Approved" when no one was named. */
export function decidedLabel(gate: DecidedGate): string {
  const verb = gate.decision === "approve" ? "Approved" : "Rejected";
  return gate.decidedBy ? `${verb} by ${gate.decidedBy}` : verb;
}

/**
 * What happens to the run after a decision serve accepted: an approval may
 * leave other gates pending, resume the run in serve, or leave it for a
 * resume; a rejection ends it.
 */
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
 * The message for a decision serve refused. A gate a fresh listing no
 * longer holds was decided elsewhere (another tab, the CLI, or an earlier
 * click), so that is said instead of the refusal.
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
