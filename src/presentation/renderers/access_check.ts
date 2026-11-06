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
 * the run-time decision a server reports for a concrete vault read or write:
 * what a serve run triggered by the principal may do
 */
export interface RunVaultAccessReport {
  vault: string;
  action: string;
  allowed: boolean;
  restricted: boolean;
  rule: string;
  reason: string;
  grantId?: string;
  triggerScope?: string;
}

export interface AccessCheckResult {
  subject: string;
  action: string;
  resource: string;
  collectives: string[];
  client?: string;
  decisions: AccessDecision[];
  method?: string;
  /**
   * The server's approval policy. Undefined for a local check, or a server
   * that predates the setting.
   */
  approveRequiresExplicitGrant?: boolean;
  signalRequiresExplicitGrant?: boolean;
  tagRequiresExplicitGrant?: boolean;
  /** Undefined for a local check, or a server that predates it. */
  runVaultAccess?: RunVaultAccessReport;
}

function runVaultScopeTag(report: RunVaultAccessReport): string {
  if (!report.allowed && !report.restricted) {
    if (report.rule === "vault-deny") return "vault deny";
    if (report.rule === "reserved") return "reserved vault";
  }
  return report.restricted ? "vault-scoped" : "not vault-scoped";
}

/**
 * run reads are allowed until a vault grant scopes the principal, unlike vault
 * requests, which need an allow, so both are shown; the reason and rule are in
 * the JSON output
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
  readonly impliedBy?: "run" | "write";
  readonly action?: string;
}

export function impliedMarker(decision: ApprovalDecision): string {
  return decision.impliedBy ? ` [implied by ${decision.impliedBy}]` : "";
}

/**
 * An action another action's grant implies unless the server requires an
 * explicit grant, and the action that implies it.
 */
const IMPLYING_ACTION = {
  approve: "run",
  signal: "run",
  tag: "write",
} as const;

type ImpliedAction = keyof typeof IMPLYING_ACTION;

const POLICY_LABEL: Record<ImpliedAction, string> = {
  approve: "Approval policy",
  signal: "Signal policy",
  tag: "Tag policy",
};

function explicitGrantHint(
  requiresExplicitGrant: boolean | undefined,
  action: ImpliedAction,
): string {
  return requiresExplicitGrant === false
    ? `Set auth.${action}-requires-explicit-grant on the server to require a grant that names ${action}.`
    : `A server started with --${action}-requires-explicit-grant requires a grant that names ${action}.`;
}

function impliedPolicyNote(
  target: ImpliedAction,
  action: string,
  decisions: readonly ApprovalDecision[],
  requiresExplicitGrant: boolean | undefined,
): string | null {
  if (action !== target) return null;
  const implying = IMPLYING_ACTION[target];
  if (requiresExplicitGrant === true) {
    return `${
      POLICY_LABEL[target]
    }: this server requires a grant that names ${target}; ${implying} grants do not count.`;
  }
  const allowedOnlyThroughImplying = decisions.length > 0 &&
    decisions[0].effect === "allow" &&
    decisions.every((d) => d.impliedBy === implying);
  if (!allowedOnlyThroughImplying) return null;
  return `Note: ${target} is allowed only through a ${implying} grant. ${
    explicitGrantHint(requiresExplicitGrant, target)
  }`;
}

/** A row with no action is a row of an approve listing, as before signal. */
function impliedListingNote(
  target: ImpliedAction,
  decisions: readonly ApprovalDecision[],
  requiresExplicitGrant: boolean | undefined,
): string | null {
  const implying = IMPLYING_ACTION[target];
  const hasImpliedAllow = decisions.some((d) =>
    d.effect === "allow" && d.impliedBy === implying &&
    (d.action === undefined ? target === "approve" : d.action === target)
  );
  if (!hasImpliedAllow) return null;
  return `Note: ${target} rows marked [implied by ${implying}] come from ${implying} grants. ${
    explicitGrantHint(requiresExplicitGrant, target)
  }`;
}

export function approvalPolicyNote(
  action: string,
  decisions: readonly ApprovalDecision[],
  approveRequiresExplicitGrant: boolean | undefined,
): string | null {
  return impliedPolicyNote(
    "approve",
    action,
    decisions,
    approveRequiresExplicitGrant,
  );
}

export function signalPolicyNote(
  action: string,
  decisions: readonly ApprovalDecision[],
  signalRequiresExplicitGrant: boolean | undefined,
): string | null {
  return impliedPolicyNote(
    "signal",
    action,
    decisions,
    signalRequiresExplicitGrant,
  );
}

export function tagPolicyNote(
  action: string,
  decisions: readonly ApprovalDecision[],
  tagRequiresExplicitGrant: boolean | undefined,
): string | null {
  return impliedPolicyNote("tag", action, decisions, tagRequiresExplicitGrant);
}

export function impliedApproveListingNote(
  decisions: readonly ApprovalDecision[],
  approveRequiresExplicitGrant: boolean | undefined,
): string | null {
  return impliedListingNote("approve", decisions, approveRequiresExplicitGrant);
}

export function impliedSignalListingNote(
  decisions: readonly ApprovalDecision[],
  signalRequiresExplicitGrant: boolean | undefined,
): string | null {
  return impliedListingNote("signal", decisions, signalRequiresExplicitGrant);
}

export function impliedTagListingNote(
  decisions: readonly ApprovalDecision[],
  tagRequiresExplicitGrant: boolean | undefined,
): string | null {
  return impliedListingNote("tag", decisions, tagRequiresExplicitGrant);
}

export interface AccessCheckRenderer {
  render(result: AccessCheckResult): void;
}

function formatSubject(subject: AccessDecision["subject"]): string {
  return `${subject.kind}:${subject.name}`;
}

function checkedTarget(result: AccessCheckResult): string {
  return result.method
    ? `${result.resource} method ${result.method}`
    : result.resource;
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
    ) ?? tagPolicyNote(
      result.action,
      result.decisions,
      result.tagRequiresExplicitGrant,
    );

    if (result.decisions.length === 0) {
      writeOutput(
        `DENY (implicit) — no matching grants for ${result.subject} ${result.action} ${
          checkedTarget(result)
        }`,
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
      `${effect} via ${via} (${subject} → ${result.action} → ${
        checkedTarget(result)
      })${impliedMarker(firstDecision)}${
        firstDecision.dependsOn
          ? " (depends on the run)"
          : result.decisions.some((d) => d.effect === "deny" && d.dependsOn)
          ? " (a deny depends on the run)"
          : ""
      }${result.client ? ` as ${result.client}` : ""}`,
    );

    if (result.decisions.length > 1) {
      writeOutput("");
      writeOutput("All matching grants:");
      for (const decision of result.decisions) {
        const e = decision.effect.toUpperCase().padEnd(5);
        const g = decision.grantId.slice(0, 8);
        const s = formatSubject(decision.subject);
        const cond = decision.condition
          ? ` [when: ${decision.condition}]${
            decision.dependsOn ? " (depends on the run)" : ""
          }`
          : "";
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
          ...(result.method ? { method: result.method } : {}),
          collectives: result.collectives,
          ...(result.client !== undefined ? { client: result.client } : {}),
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
          ...(result.tagRequiresExplicitGrant !== undefined
            ? { tagRequiresExplicitGrant: result.tagRequiresExplicitGrant }
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
