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

import type { EventHandlers } from "../../libswamp/stream.ts";
import type {
  ExtensionQualityData,
  ExtensionQualityEvent,
} from "../../libswamp/extensions/quality.ts";
import type { FactorStatus } from "../../domain/extensions/extension_rubric_scorer.ts";
import type { LocalGateFailure } from "../../libswamp/extensions/push.ts";
import type { SwampError } from "../../libswamp/errors.ts";
import type { ReviewFinding } from "../../domain/extensions/extension_review_rules.ts";
import type { SafetyIssue } from "../../domain/extensions/extension_safety_analyzer.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { displayPath } from "../output/display_path.ts";
import {
  buildFindingsReport,
  renderFindingsReport,
  withAcceptance,
} from "./extension_findings_report.ts";

/** Per-run inputs for the stream handlers. */
export interface ExtensionQualityHandlerOptions {
  /** The manifest's directory; the sidecar and declared acceptances are relative to it. */
  manifestDir: string;
  /** The repository directory; log paths under it print relative to `cwd`. */
  repoDir?: string;
  /** The directory the author ran the command in; log paths print openable from it. Defaults to the process cwd. */
  cwd?: string;
}

/**
 * The details a failed run carries, surfaced before the error so the
 * author sees which acceptance or file is at fault, as push does.
 */
function errorDetails(error: SwampError): {
  reviewRuleErrors?: ReviewFinding[];
  safetyErrors?: SafetyIssue[];
} {
  const details = error.details as Record<string, unknown> | undefined;
  return {
    ...(Array.isArray(details?.reviewRuleErrors)
      ? { reviewRuleErrors: details.reviewRuleErrors as ReviewFinding[] }
      : {}),
    ...(Array.isArray(details?.safetyErrors)
      ? { safetyErrors: details.safetyErrors as SafetyIssue[] }
      : {}),
  };
}

function fileAndLine(finding: { file: string; line?: number }): string {
  return finding.line !== undefined
    ? `${finding.file}:${finding.line}`
    : finding.file;
}

/**
 * One line per detail a failed gate carries (the same details push prints
 * when it throws), indented under the gate's message.
 */
function gateFailureDetailLines(failure: LocalGateFailure): string[] {
  const details = failure.details as Record<string, unknown> | undefined;
  const lines: string[] = [];
  const list = (key: string): Record<string, unknown>[] =>
    Array.isArray(details?.[key])
      ? details[key] as Record<string, unknown>[]
      : [];
  for (const f of list("safetyErrors")) {
    const issue = f as unknown as SafetyIssue;
    lines.push(`${fileAndLine(issue)}: ${issue.message}`);
  }
  for (const f of list("reviewRuleErrors")) {
    const finding = f as unknown as ReviewFinding;
    lines.push(
      `[${finding.severity}] ${finding.ruleId} — ${fileAndLine(finding)}: ${
        finding.message.split("\n")[0]
      }`,
    );
  }
  for (const key of ["qualityErrors", "upgradeChainErrors"]) {
    for (const f of list(key)) {
      const output = String(f.output ?? "").trim();
      lines.push(`${String(f.check)}: ${output.split("\n")[0]}`);
    }
  }
  for (const f of list("dependencyTrustErrors")) {
    lines.push(`${String(f.dependency)}: ${String(f.message)}`);
  }
  for (const f of list("mismatches")) {
    lines.push(
      `${String(f.kind)} ${String(f.identifier)} (${String(f.fileName)})`,
    );
  }
  return lines;
}

/**
 * Why a completed run still fails: a gate that would stop a push, or an
 * extension the registry cannot score. Undefined when neither holds.
 */
function qualityFailureMessage(data: ExtensionQualityData): string | undefined {
  const reasons: string[] = [];
  if (data.gateFailures.length > 0) {
    const gates = [...new Set(data.gateFailures.map((f) => f.gate))];
    reasons.push(
      `${data.gateFailures.length} check(s) would block a push (${
        gates.join(", ")
      })`,
    );
  }
  if (!data.registryScorable) {
    reasons.push(
      "the registry cannot score this extension (it uses bare import specifiers)",
    );
  }
  if (reasons.length === 0) return undefined;
  return `Extension quality failed: ${reasons.join("; ")}.`;
}

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function factorMark(status: FactorStatus): string {
  switch (status) {
    case "earned":
      return "✓";
    case "provisional":
      return "~";
    case "partial":
    case "missing":
      return "✗";
  }
}

/** Renderer interface that also reports pass/fail to the CLI. */
export interface ExtensionQualityRenderer
  extends Renderer<ExtensionQualityEvent> {
  passed(): boolean;
  failureMessage(): string;
  handlers(
    options?: ExtensionQualityHandlerOptions,
  ): EventHandlers<ExtensionQualityEvent>;
}

class LogExtensionQualityRenderer implements ExtensionQualityRenderer {
  private _passed = true;
  private _failureMessage = "";

  passed(): boolean {
    return this._passed;
  }

  failureMessage(): string {
    return this._failureMessage;
  }

  handlers(
    options?: ExtensionQualityHandlerOptions,
  ): EventHandlers<ExtensionQualityEvent> {
    const logger = getSwampLogger(["extension", "quality"]);
    const manifestDir = options?.manifestDir ?? "";
    const repoDir = options?.repoDir;
    const cwd = options?.cwd ?? Deno.cwd();
    return {
      packaging: () => {
        logger.info("Packaging extension for quality scoring...");
      },
      cache_hit: (e) => {
        logger.info`Cache hit — reusing previously packaged tarball (${
          e.hash.slice(0, 12)
        })`;
      },
      scoring: () => {
        logger.info("Scoring extension against Swamp Club quality rubric...");
      },
      completed: (e) => {
        const { score, archiveSize, findings } = e.data;
        const provisional = score.provisionalPoints > 0
          ? ` (+${score.provisionalPoints} pending server verification)`
          : "";
        const passStatus = score.allPassed
          ? "all factors earned"
          : "some factors missing";
        logger.info(
          `Rubric v${score.rubricVersion} — ${score.earnedPoints}/${score.maxClientEarnablePoints} points (${score.percentage}%${provisional}, ${passStatus})`,
        );
        for (const factor of score.factors) {
          const mark = factorMark(factor.status);
          const pts = `${factor.earnedPoints}/${factor.maxPoints}`;
          logger.info`  ${mark} ${factor.id} [${pts}] — ${factor.label}`;
          if (factor.id === "fast-check") {
            logger
              .info`      ℹ This factor is deprecated and will be removed in a future release.`;
          }
          if (
            factor.status !== "earned" && factor.status !== "provisional" &&
            factor.remediation
          ) {
            logger.info`      → ${factor.remediation}`;
          }
        }
        const { dependencyTrustResult } = e.data;
        if (dependencyTrustResult.audited.length > 0) {
          for (const dep of dependencyTrustResult.audited) {
            const mark = dep.passed ? "✓" : "✗";
            const parts: string[] = [];
            if (dep.registry === "jsr") {
              parts.push("jsr (trusted)");
            } else {
              if (dep.license) parts.push(dep.license);
              if (dep.weeklyDownloads !== null) {
                parts.push(`${formatDownloads(dep.weeklyDownloads)}/week`);
              }
              if (dep.publishedAgo) parts.push(dep.publishedAgo);
            }
            const detail = parts.length > 0 ? ` — ${parts.join(", ")}` : "";
            logger.info`      ${mark} ${dep.name}@${dep.version}${detail}`;
          }
        } else {
          logger.info`      No npm/jsr dependencies to audit`;
        }
        if (dependencyTrustResult.errors.length > 0) {
          logger.error`Dependency trust blockers (push blocked):`;
          for (const err of dependencyTrustResult.errors) {
            logger.error`  ${err.dependency}: ${err.message}`;
          }
        }
        if (dependencyTrustResult.warnings.length > 0) {
          logger.warn`Dependency trust warnings (non-blocking):`;
          for (const w of dependencyTrustResult.warnings) {
            logger.warn`  ${w.dependency}: ${w.message}`;
          }
        }
        renderFindingsReport(
          logger,
          buildFindingsReport(
            {
              safetyWarnings: findings.safetyWarnings,
              reviewWarnings: findings.reviewRulesResult.warnings,
              acceptances: findings.acceptances,
            },
            manifestDir,
          ),
          {
            manifestDir,
            display: (path) =>
              displayPath(
                path,
                cwd,
                repoDir !== undefined ? [repoDir, manifestDir] : [manifestDir],
              ),
          },
        );
        logger.info`Packaged archive: ${archiveSize} bytes`;
        const { gateFailures, excludedFromArchive, registryScorable } = e.data;
        if (gateFailures.length > 0) {
          logger.error`Checks that would block a push:`;
          for (const failure of gateFailures) {
            logger.error`  ${failure.gate}: ${failure.message}`;
            for (const line of gateFailureDetailLines(failure)) {
              logger.error`      ${line}`;
            }
          }
        }
        if (excludedFromArchive.length > 0) {
          logger
            .warn`The rubric above scores the archive without the ${excludedFromArchive.length} file(s) a check rejected:`;
          for (const file of excludedFromArchive) {
            logger.warn`  ${file}`;
          }
        }
        if (!registryScorable) {
          logger
            .error`The registry cannot score this extension: it uses bare import specifiers, so it would publish unscored. The rubric above resolves the import map locally; the registry does not.`;
        }
        const failure = qualityFailureMessage(e.data);
        if (failure) {
          this._passed = false;
          this._failureMessage = failure;
          throw new UserError(failure);
        }
      },
      error: (e) => {
        const { reviewRuleErrors, safetyErrors } = errorDetails(e.error);
        if (reviewRuleErrors) {
          logger.error`Extension review rule errors:`;
          for (const f of reviewRuleErrors) {
            const summary = f.message.split("\n")[0];
            logger
              .error`  [${f.severity}] ${f.ruleId} — ${
              fileAndLine(f)
            }: ${summary}`;
          }
        }
        if (safetyErrors) {
          logger.error`Safety errors:`;
          for (const f of safetyErrors) {
            logger.error`  ${fileAndLine(f)}: ${f.message}`;
          }
        }
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonExtensionQualityRenderer implements ExtensionQualityRenderer {
  private _passed = true;
  private _failureMessage = "";

  passed(): boolean {
    return this._passed;
  }

  failureMessage(): string {
    return this._failureMessage;
  }

  handlers(
    options?: ExtensionQualityHandlerOptions,
  ): EventHandlers<ExtensionQualityEvent> {
    const manifestDir = options?.manifestDir ?? "";
    return {
      packaging: () => {},
      cache_hit: () => {},
      scoring: () => {},
      completed: (e) => {
        const {
          score,
          cacheHash,
          archiveSize,
          cacheHit,
          dependencyTrustResult,
          findings,
          gateFailures,
          excludedFromArchive,
          registryScorable,
        } = e.data;
        // `status` is the run's outcome, matching the exit code: a failed
        // check or an extension the registry cannot score fails the run
        // whatever the rubric says. `allPassed` stays the rubric's own.
        const failure = qualityFailureMessage(e.data);
        console.log(JSON.stringify(
          {
            status: failure || !score.allPassed ? "failed" : "passed",
            rubricVersion: score.rubricVersion,
            earnedPoints: score.earnedPoints,
            maxEarnablePoints: score.maxEarnablePoints,
            maxClientEarnablePoints: score.maxClientEarnablePoints,
            provisionalPoints: score.provisionalPoints,
            percentage: score.percentage,
            allPassed: score.allPassed,
            factors: score.factors,
            dependencyTrust: {
              passed: dependencyTrustResult.passed,
              audited: dependencyTrustResult.audited,
              errors: dependencyTrustResult.errors,
              warnings: dependencyTrustResult.warnings,
            },
            cacheHash,
            archiveSize,
            cacheHit,
            registryScorable,
            gateFailures,
            excludedFromArchive,
            warnings: withAcceptance(findings.safetyWarnings, manifestDir),
            reviewRuleWarnings: withAcceptance(
              findings.reviewRulesResult.warnings,
              manifestDir,
            ),
            ...buildFindingsReport(
              {
                safetyWarnings: findings.safetyWarnings,
                reviewWarnings: findings.reviewRulesResult.warnings,
                acceptances: findings.acceptances,
              },
              manifestDir,
            ),
          },
          null,
          2,
        ));
        if (failure) {
          this._passed = false;
          this._failureMessage = failure;
          throw new UserError(failure);
        }
      },
      error: (e) => {
        const { reviewRuleErrors, safetyErrors } = errorDetails(e.error);
        if (reviewRuleErrors) {
          console.log(JSON.stringify({ reviewRuleErrors }, null, 2));
        }
        if (safetyErrors) {
          console.log(JSON.stringify({ safetyErrors }, null, 2));
        }
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createExtensionQualityRenderer(
  mode: OutputMode,
): ExtensionQualityRenderer {
  switch (mode) {
    case "json":
      return new JsonExtensionQualityRenderer();
    case "log":
      return new LogExtensionQualityRenderer();
  }
}
