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

import type { AccessDecision } from "../../domain/access/access_decision_service.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";

/**
 * The run-time decision a server reports for a concrete vault read or write
 * (swamp-club#2676): what a serve run triggered by the principal may do.
 */
export interface RunVaultAccessReport {
  vault: string;
  action: string;
  allowed: boolean;
  restricted: boolean;
  rule: string;
  reason: string;
  grantId?: string;
  /** Set for a trigger principal, whose scope covers all its runs. */
  triggerScope?: string;
}

export interface AccessCheckResult {
  subject: string;
  action: string;
  resource: string;
  collectives: string[];
  decisions: AccessDecision[];
  /**
   * The server's approval policy. Undefined for a local check, or a server
   * that predates the setting.
   */
  approveRequiresExplicitGrant?: boolean;
  /**
   * The server's signal policy. Undefined for a local check, or a server
   * that predates the setting.
   */
  signalRequiresExplicitGrant?: boolean;
  /** Undefined for a local check, or a server that predates it. */
  runVaultAccess?: RunVaultAccessReport;
}

/**
 * The log line's short tag for a run-time vault decision: the rule for a
 * refusal that is not about scoping (an explicit vault deny, or a reserved
 * vault), else whether the principal's runs are vault-scoped.
 */
function runVaultScopeTag(report: RunVaultAccessReport): string {
  if (!report.allowed && !report.restricted) {
    if (report.rule === "vault-deny") return "vault deny";
    if (report.rule === "reserved") return "reserved vault";
  }
  return report.restricted ? "vault-scoped" : "not vault-scoped";
}

/**
 * The lines explaining a run-time vault decision, or none without one. Run
 * reads are allowed until a vault grant scopes the principal, unlike vault
 * requests, which need an allow — so both are shown. The log line carries a
 * short scope tag; the reason and rule are in the JSON output.
 */
export function runVaultAccessLines(
  report: RunVaultAccessReport | undefined,
): string[] {
  if (!report) return [];
  const verdict = report.allowed ? "ALLOW" : "DENY";
  const scope = runVaultScopeTag(report);
  const lines = [
    `In serve runs: ${verdict} ${report.action} vault ${report.vault} (${scope})`,
  ];
  if (report.triggerScope) {
    lines.push(
      `This is a trigger principal: this applies to ${report.triggerScope}.`,
    );
  }
  return lines;
}

interface ApprovalDecision {
  readonly effect: string;
  readonly impliedBy?: "run";
  /** The action of a listing row; absent on a check of one action. */
  readonly action?: string;
}

/** Marks a decision that covers its action only through a run grant. */
export function impliedMarker(decision: ApprovalDecision): string {
  return decision.impliedBy === "run" ? " [implied by run]" : "";
}

/** An action a run grant implies unless the server requires an explicit grant. */
type RunImpliedAction = "approve" | "signal";

const POLICY_LABEL: Record<RunImpliedAction, string> = {
  approve: "Approval policy",
  signal: "Signal policy",
};

function explicitGrantHint(
  requiresExplicitGrant: boolean | undefined,
  action: RunImpliedAction,
): string {
  return requiresExplicitGrant === false
    ? `Set auth.${action}-requires-explicit-grant on the server to require a grant that names ${action}.`
    : `A server started with --${action}-requires-explicit-grant requires a grant that names ${action}.`;
}

function runImpliedPolicyNote(
  target: RunImpliedAction,
  action: string,
  decisions: readonly ApprovalDecision[],
  requiresExplicitGrant: boolean | undefined,
): string | null {
  if (action !== target) return null;
  if (requiresExplicitGrant === true) {
    return `${
      POLICY_LABEL[target]
    }: this server requires a grant that names ${target}; run grants do not count.`;
  }
  const allowedOnlyThroughRun = decisions.length > 0 &&
    decisions[0].effect === "allow" &&
    decisions.every((d) => d.impliedBy === "run");
  if (!allowedOnlyThroughRun) return null;
  return `Note: ${target} is allowed only through a run grant. ${
    explicitGrantHint(requiresExplicitGrant, target)
  }`;
}

/** A row with no action is a row of an approve listing, as before signal. */
function impliedListingNote(
  target: RunImpliedAction,
  decisions: readonly ApprovalDecision[],
  requiresExplicitGrant: boolean | undefined,
): string | null {
  const hasImpliedAllow = decisions.some((d) =>
    d.effect === "allow" && d.impliedBy === "run" &&
    (d.action === undefined ? target === "approve" : d.action === target)
  );
  if (!hasImpliedAllow) return null;
  return `Note: ${target} rows marked [implied by run] come from run grants. ${
    explicitGrantHint(requiresExplicitGrant, target)
  }`;
}

/**
 * Explains how an approve check was decided, or returns null when there is
 * nothing to add: approve is allowed only through run grants, or the server
 * does not count run grants for approve.
 */
export function approvalPolicyNote(
  action: string,
  decisions: readonly ApprovalDecision[],
  approveRequiresExplicitGrant: boolean | undefined,
): string | null {
  return runImpliedPolicyNote(
    "approve",
    action,
    decisions,
    approveRequiresExplicitGrant,
  );
}

/**
 * Explains how a signal check was decided, as {@link approvalPolicyNote}
 * does for approve.
 */
export function signalPolicyNote(
  action: string,
  decisions: readonly ApprovalDecision[],
  signalRequiresExplicitGrant: boolean | undefined,
): string | null {
  return runImpliedPolicyNote(
    "signal",
    action,
    decisions,
    signalRequiresExplicitGrant,
  );
}

/**
 * Explains implied approve rows in a permission listing, or returns null when
 * the listing has none that allow.
 */
export function impliedApproveListingNote(
  decisions: readonly ApprovalDecision[],
  approveRequiresExplicitGrant: boolean | undefined,
): string | null {
  return impliedListingNote("approve", decisions, approveRequiresExplicitGrant);
}

/**
 * Explains implied signal rows in a permission listing, or returns null when
 * the listing has none that allow.
 */
export function impliedSignalListingNote(
  decisions: readonly ApprovalDecision[],
  signalRequiresExplicitGrant: boolean | undefined,
): string | null {
  return impliedListingNote("signal", decisions, signalRequiresExplicitGrant);
}

export interface AccessCheckRenderer {
  render(result: AccessCheckResult): void;
}

function formatSubject(subject: AccessDecision["subject"]): string {
  return `${subject.kind}:${subject.name}`;
}

class LogAccessCheckRenderer implements AccessCheckRenderer {
  render(result: AccessCheckResult): void {
    const note = approvalPolicyNote(
      result.action,
      result.decisions,
      result.approveRequiresExplicitGrant,
    ) ?? signalPolicyNote(
      result.action,
      result.decisions,
      result.signalRequiresExplicitGrant,
    );

    if (result.decisions.length === 0) {
      writeOutput(
        `DENY (implicit) — no matching grants for ${result.subject} ${result.action} ${result.resource}`,
      );
      if (note) writeOutput(note);
      const runLines = runVaultAccessLines(result.runVaultAccess);
      if (runLines.length > 0) {
        writeOutput("");
        for (const line of runLines) writeOutput(line);
      }
      return;
    }

    const firstDecision = result.decisions[0];
    const effect = firstDecision.effect.toUpperCase();
    const via = `grant ${firstDecision.grantId.slice(0, 8)}…`;
    const subject = formatSubject(firstDecision.subject);
    writeOutput(
      `${effect} via ${via} (${subject} → ${result.action} → ${result.resource})${
        impliedMarker(firstDecision)
      }`,
    );

    if (result.decisions.length > 1) {
      writeOutput("");
      writeOutput("All matching grants:");
      for (const decision of result.decisions) {
        const e = decision.effect.toUpperCase().padEnd(5);
        const g = decision.grantId.slice(0, 8);
        const s = formatSubject(decision.subject);
        const cond = decision.condition ? ` [when: ${decision.condition}]` : "";
        writeOutput(`  ${e}  ${g}…  via ${s}${cond}${impliedMarker(decision)}`);
      }
    }

    if (note) {
      writeOutput("");
      writeOutput(note);
    }
    const runLines = runVaultAccessLines(result.runVaultAccess);
    if (runLines.length > 0) {
      writeOutput("");
      for (const line of runLines) writeOutput(line);
    }
  }
}

class JsonAccessCheckRenderer implements AccessCheckRenderer {
  render(result: AccessCheckResult): void {
    const finalEffect = result.decisions.length > 0
      ? result.decisions[0].effect
      : "deny";
    writeOutput(
      JSON.stringify(
        {
          subject: result.subject,
          action: result.action,
          resource: result.resource,
          collectives: result.collectives,
          effect: finalEffect,
          matchingGrants: result.decisions,
          ...(result.approveRequiresExplicitGrant !== undefined
            ? {
              approveRequiresExplicitGrant: result.approveRequiresExplicitGrant,
            }
            : {}),
          ...(result.signalRequiresExplicitGrant !== undefined
            ? {
              signalRequiresExplicitGrant: result.signalRequiresExplicitGrant,
            }
            : {}),
          ...(result.runVaultAccess
            ? { runVaultAccess: result.runVaultAccess }
            : {}),
        },
        null,
        2,
      ),
    );
  }
}

export function createAccessCheckRenderer(
  mode: OutputMode,
): AccessCheckRenderer {
  switch (mode) {
    case "json":
      return new JsonAccessCheckRenderer();
    case "log":
      return new LogAccessCheckRenderer();
  }
}
