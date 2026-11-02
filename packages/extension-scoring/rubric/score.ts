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

/**
 * The extension quality rubric: the factor table and the one score both the
 * CLI and the registry compose from it. Pure; each side gathers the inputs
 * its own way (the CLI from the archive it is about to push, the registry
 * from the version it stored).
 */

import type { AnalysisFactors } from "./analysis.ts";
import type {
  PrivateSourceStanding,
  RepositoryEvidence,
} from "./repository.ts";
import { parseVcsUrl } from "./repository.ts";
import {
  DEPENDENCY_TRUST_MAX_POINTS,
  NOT_AUDITED_FIX,
  type NotAuditedFix,
} from "../dependency_audit/points.ts";

/**
 * The rubric's version. Every score records it; a rule change that can move
 * a score bumps it so stored scores say which rules made them. v5: one
 * shared scorer for the CLI and the registry (swamp-club#3781). v6: a
 * non-exact dependency spec costs the loose point only when no valid lock
 * fixed its version (swamp-club#3970); a v2 archive is audited exact-only,
 * and code from outside npm and JSR is not audited (swamp-club#4018).
 * #3970 and #4018 share v6 by decision on #4018: the dependency rules of
 * that release are one version, and the registry rescores under it once
 * both are in (#3973, #3980).
 */
export const RUBRIC_VERSION = 6;

/**
 * Status of one scorecard row.
 *   earned      → all points
 *   partial     → some points
 *   missing     → none
 *   pending     → not scored yet (a version the registry has not analysed)
 *   provisional → before publish, a factor only the registry can award and
 *                 that it is expected to; it earns nothing until the
 *                 registry awards it
 */
export type FactorStatus =
  | "earned"
  | "partial"
  | "missing"
  | "pending"
  | "provisional";

/** Whether a factor is scored per version or once for the package. */
export type FactorCategory = "per-version" | "per-package";

/** One row of the scorecard. */
export interface RubricFactor {
  id: string;
  label: string;
  earnedPoints: number;
  maxPoints: number;
  status: FactorStatus;
  category: FactorCategory;
  /** How to earn the missing points; absent on an earned, pending or provisional row. */
  remediation?: string;
}

/** The dependency audit's result, as the `dependency-trust` row needs it. */
export interface DependencyTrustInput {
  /** From {@link dependencyTrustEarnedPoints}, or the points a stored score recorded. */
  earnedPoints: number;
  blockerCount: number;
  notAuditedCount: number;
  /** The distinct fixes the unaudited dependencies need; empty when unknown. */
  notAuditedFixes: readonly NotAuditedFix[];
  looseCount: number;
}

/** A per-version input that may not have been measured. */
export type VersionAnalysis = {
  [K in keyof AnalysisFactors]: AnalysisFactors[K] | null;
};

/** Everything the rubric scores. A null per-version input reads as pending. */
export interface RubricInputs {
  /**
   * The rubric version the per-version inputs were computed under. Rows a
   * later version added are left out of an older score, as the registry
   * shows versions it scored before them. A fresh score passes
   * {@link RUBRIC_VERSION}.
   */
  scoredWith: number;
  /** What the README and `deno doc` said; null when the version was never analysed. */
  analysis: VersionAnalysis | null;
  /** The declared license is a valid SPDX expression. */
  licenseDeclared: boolean | null;
  dependencyTrust: DependencyTrustInput | null;
  /** No secret-unsafe-docs finding is left unaccepted. */
  secretSafeDocs: boolean | null;
  description: string | undefined;
  platforms: readonly string[];
  repository: RepositoryEvidence;
  /**
   * Why `deno doc` could not analyse the source, or null when it could.
   * Only the remediation text reads it; the analysis already scores the
   * documentation factors 0.
   */
  docAnalysisError: string | null;
}

/** A composed score. */
export interface RubricScore {
  rubricVersion: number;
  factors: RubricFactor[];
  earnedPoints: number;
  /** Every row's points, provisional ones included. */
  maxPoints: number;
  /** Points of provisional rows, pending the registry; not in `earnedPoints`. */
  provisionalPoints: number;
  /**
   * floor(earned × 100 / max), within 0 to 100: the registry's formula, so
   * provisional points count as not earned yet.
   */
  percentage: number;
}

/** A letter grade. */
export type ScoreGrade = "A" | "B" | "C" | "D" | "F";

/** The grade for a percentage. */
export function gradeForPercentage(percentage: number): ScoreGrade {
  const clamped = clampPercentage(percentage);
  if (clamped >= 90) return "A";
  if (clamped >= 75) return "B";
  if (clamped >= 60) return "C";
  if (clamped >= 40) return "D";
  return "F";
}

/**
 * The percentage the registry shows if it awards every provisional row:
 * floor((earned + provisional) × 100 / max), within 0 to 100. Equals
 * `percentage` when nothing is provisional.
 */
export function percentageIfProvisionalEarned(
  score: Pick<RubricScore, "earnedPoints" | "maxPoints" | "provisionalPoints">,
): number {
  return percentageOf(
    score.earnedPoints + score.provisionalPoints,
    score.maxPoints,
  );
}

function percentageOf(earned: number, max: number): number {
  return max === 0 ? 0 : clampPercentage(Math.floor((earned * 100) / max));
}

const RICH_README_MIN_LENGTH = 500;
const RICH_README_MIN_CODE_BLOCKS = 2;
const SYMBOLS_DOCS_FULL_THRESHOLD = 0.8;

/** How to earn `secret-safe-docs`. */
export const SECRET_SAFE_DOCS_REMEDIATION =
  "Fix or accept each secret-unsafe-docs warning: the README, the manifest " +
  "description and describe strings should store secrets with " +
  "`swamp vault put <vault> <key>` (it prompts for the value) and pass them " +
  "as `${{ vault.get(<vault>, <key>) }}`.";

/** Compose the rubric score. */
export function composeScore(inputs: RubricInputs): RubricScore {
  const a = inputs.analysis;
  const rows: RubricFactor[] = [
    versionRow(
      "has-readme",
      "Has README or module doc",
      2,
      a === null ? null : a.hasReadme,
      "Add `README.md` to `additionalFiles:` as a bare basename — the " +
        "entry is copied verbatim to `extension/files/<entry>` in the " +
        "archive, so nested paths like `docs/README.md` won't earn the " +
        "factor. For per-directory layouts (manifest beside README), opt " +
        "in with `paths.base: manifest`. " +
        (inputs.docAnalysisError === null
          ? "Or add a module-level JSDoc at the top of every entrypoint file."
          : "A module-level JSDoc counts only once deno doc can analyse " +
            `the source: ${inputs.docAnalysisError}`),
    ),
    versionRow(
      "readme-example",
      "README has a code example",
      1,
      a === null ? null : a.hasReadmeExamples,
      "Add at least one fenced code block (``` … ```) to README showing usage.",
    ),
    richReadmeRow(a),
    symbolsRow(a, inputs.docAnalysisError),
    versionRow("fast-check", "No slow types (deprecated)", 1, a && true, ""),
    ...(inputs.scoredWith >= 3
      ? [dependencyTrustRow(inputs.dependencyTrust)]
      : []),
    ...(inputs.scoredWith >= 4
      ? [
        versionRow(
          "secret-safe-docs",
          "Docs keep secrets in a vault",
          1,
          inputs.secretSafeDocs,
          SECRET_SAFE_DOCS_REMEDIATION,
        ),
      ]
      : []),
    packageRow(
      "description",
      "Has description",
      1,
      typeof inputs.description === "string" &&
        inputs.description.trim().length > 0,
      "Fill `description:` in manifest.yaml.",
    ),
    packageRow(
      "platforms",
      "Platform support declared (or universal)",
      2,
      inputs.platforms.length === 0 || inputs.platforms.length >= 1,
      "Set `platforms:` in manifest.yaml — list supported platforms " +
        "or leave it empty to declare universal support.",
    ),
    versionRow(
      "has-license",
      "License declared",
      1,
      inputs.licenseDeclared,
      "Declare the license in manifest.yaml as an SPDX " +
        "expression, e.g. `license: MIT` or `license: MIT OR Apache-2.0`. " +
        "Only SPDX identifiers count; a `LicenseRef-` or `AdditionRef-` " +
        "earns nothing.",
    ),
    versionRow(
      "license-file",
      "LICENSE file included",
      1,
      a === null ? null : a.hasLicenseFile,
      "Add a non-empty LICENSE / LICENSE.md / LICENSE.txt " +
        "entry to `additionalFiles:` as a bare basename — entries are " +
        "copied verbatim to `extension/files/<entry>` in the archive, so " +
        "nested paths won't earn the factor. For per-directory layouts " +
        "(manifest beside LICENSE), opt in with `paths.base: manifest`.",
    ),
    repositoryVerifiedRow(inputs.repository),
  ];

  const earned = rows.reduce((s, r) => s + r.earnedPoints, 0);
  const max = rows.reduce((s, r) => s + r.maxPoints, 0);
  const provisional = rows
    .filter((r) => r.status === "provisional")
    .reduce((s, r) => s + r.maxPoints, 0);
  return {
    rubricVersion: RUBRIC_VERSION,
    factors: rows,
    earnedPoints: earned,
    maxPoints: max,
    provisionalPoints: provisional,
    percentage: percentageOf(earned, max),
  };
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function row(
  id: string,
  label: string,
  maxPoints: number,
  earnedPoints: number,
  category: FactorCategory,
  remediation: string,
): RubricFactor {
  const status: FactorStatus = earnedPoints === maxPoints
    ? "earned"
    : earnedPoints === 0
    ? "missing"
    : "partial";
  return {
    id,
    label,
    earnedPoints,
    maxPoints,
    status,
    category,
    ...(status === "earned" || remediation === "" ? {} : { remediation }),
  };
}

function pendingRow(
  id: string,
  label: string,
  maxPoints: number,
  category: FactorCategory,
): RubricFactor {
  return { id, label, earnedPoints: 0, maxPoints, status: "pending", category };
}

function versionRow(
  id: string,
  label: string,
  maxPoints: number,
  value: boolean | null,
  remediation: string,
): RubricFactor {
  if (value === null) return pendingRow(id, label, maxPoints, "per-version");
  return row(
    id,
    label,
    maxPoints,
    value ? maxPoints : 0,
    "per-version",
    remediation,
  );
}

function packageRow(
  id: string,
  label: string,
  maxPoints: number,
  value: boolean,
  remediation: string,
): RubricFactor {
  return row(
    id,
    label,
    maxPoints,
    value ? maxPoints : 0,
    "per-package",
    remediation,
  );
}

function richReadmeRow(a: VersionAnalysis | null): RubricFactor {
  const id = "rich-readme";
  const label = "README is substantive";
  if (a === null) return pendingRow(id, label, 1, "per-version");
  // no README measures as null: missing, not pending
  if (a.readmeLength === null || a.readmeCodeBlockCount === null) {
    return row(
      id,
      label,
      1,
      0,
      "per-version",
      `Add a README ≥${RICH_README_MIN_LENGTH} characters with ≥${RICH_README_MIN_CODE_BLOCKS} fenced code blocks.`,
    );
  }
  const earned = a.readmeLength >= RICH_README_MIN_LENGTH &&
    a.readmeCodeBlockCount >= RICH_README_MIN_CODE_BLOCKS;
  return row(
    id,
    label,
    1,
    earned ? 1 : 0,
    "per-version",
    `Expand README to ≥${RICH_README_MIN_LENGTH} chars with ≥${RICH_README_MIN_CODE_BLOCKS} fenced blocks.`,
  );
}

function symbolsRow(
  a: VersionAnalysis | null,
  docAnalysisError: string | null,
): RubricFactor {
  const id = "symbols-docs";
  const label = "Most symbols documented";
  const pct = a === null ? null : a.percentageDocumentedSymbols;
  if (pct === null) return pendingRow(id, label, 1, "per-version");
  const earned = pct >= SYMBOLS_DOCS_FULL_THRESHOLD;
  return row(
    id,
    label,
    1,
    earned ? 1 : 0,
    "per-version",
    docAnalysisError !== null
      ? "deno doc could not analyse the source, so JSDoc coverage could " +
        `not be measured: ${docAnalysisError}`
      : `Add JSDoc to ≥${
        Math.round(SYMBOLS_DOCS_FULL_THRESHOLD * 100)
      }% of exported symbols in entrypoints (current: ${
        Math.round(pct * 100)
      }%).`,
  );
}

/** Why a dependency with this fix was not audited, for the row's text. */
const NOT_AUDITED_WHY: Readonly<
  Record<Exclude<NotAuditedFix, "other">, string>
> = {
  outage: "an OSV, npm or JSR lookup failed",
  specifier: "no published version matches the specifier",
  canonical: "the archive breaks the canonical shipped form",
  origin: "the code comes from outside npm and JSR",
  name: "the package name is invalid",
  unexpected: "the audit failed unexpectedly",
};

/**
 * The remediation for unaudited dependencies: one known cause gives its
 * reason and fix; several, or one the row cannot name, send the author to
 * each finding's own fix. Only an outage says to re-run.
 */
function notAuditedText(
  count: number,
  fixes: readonly NotAuditedFix[],
): string {
  const kinds: readonly NotAuditedFix[] = fixes.length > 0 ? fixes : ["other"];
  if (kinds.length > 1) {
    return `${count} dependency(ies) not audited, for different reasons. ` +
      "Apply the fix listed with each not-audited finding.";
  }
  const fix = kinds[0];
  if (fix === "other") {
    return `${count} dependency(ies) not audited. Resolve the reason given ` +
      "in each not-audited finding, then re-run.";
  }
  return `${count} dependency(ies) not audited because ${
    NOT_AUDITED_WHY[fix]
  }. ${NOT_AUDITED_FIX[fix]}`;
}

function dependencyTrustRow(input: DependencyTrustInput | null): RubricFactor {
  const id = "dependency-trust";
  const label = "Dependencies pass trust audit";
  if (input === null) {
    return pendingRow(id, label, DEPENDENCY_TRUST_MAX_POINTS, "per-version");
  }
  const { blockerCount, notAuditedCount, notAuditedFixes, looseCount } = input;
  const looseText = `${looseCount} loose dependency specifier(s) ` +
    `(loose-specifier) cost 1 of 2 points. Commit a valid lock (deno.lock, ` +
    `or a package-lock.json that matches node_modules) or pin exact ` +
    `versions to earn the second point.`;
  const remediation = blockerCount > 0
    ? `${blockerCount} dependency blocker(s) found (deprecated packages, ` +
      `pinned deprecated versions or yanked JSR versions, HIGH/CRITICAL ` +
      `vulnerabilities, or missing JSR versions). See the details above, ` +
      `then update or replace the flagged dependencies.` +
      (looseCount > 0 ? ` Also: ${looseText}` : "")
    : notAuditedCount > 0
    ? notAuditedText(notAuditedCount, notAuditedFixes) +
      (looseCount > 0 ? ` Also: ${looseText}` : "")
    : looseCount > 0
    ? looseText
    : "Resolve dependency trust issues — update or replace flagged dependencies.";
  return row(
    id,
    label,
    DEPENDENCY_TRUST_MAX_POINTS,
    input.earnedPoints,
    "per-version",
    remediation,
  );
}

const PUBLIC_REPOSITORY_REMEDIATION =
  "Set `repository:` to a public HTTPS URL on github.com, gitlab.com, " +
  "codeberg.org, or bitbucket.org. Server will verify it resolves publicly.";

/** What the missing-row remediation adds about private source hosting. */
function privateSourceNote(privateSource: PrivateSourceStanding): string {
  switch (privateSource.kind) {
    case "attested":
      return "";
    case "unknown":
      return " A private extension also earns this when its collective has " +
        "private source hosting, which could not be checked (not logged in, " +
        "key rejected, Swamp Club unreachable, or no answer for this " +
        "collective); `swamp auth whoami` shows the login in use.";
    case "not_attested":
      return privateSource.reason === "public_extension"
        ? " Private source hosting covers only private extensions, and this " +
          "extension will publish as public."
        : " Or, for a private extension, ask Swamp Club to mark the " +
          "collective for private source hosting.";
  }
}

const PUBLIC_LABEL = "Verified public repository";
const ATTESTED_LABEL = "Private repository (collective attested)";

function repositoryVerifiedRow(evidence: RepositoryEvidence): RubricFactor {
  const base = {
    id: "repository-verified",
    maxPoints: 2,
    category: "per-package" as const,
  };
  if (evidence.kind === "confirmed") {
    if (evidence.publicRepositoryVerified) {
      return {
        ...base,
        label: PUBLIC_LABEL,
        earnedPoints: 2,
        status: "earned",
      };
    }
    // a public extension still needs a public reference; the attestation only stands in for private source
    if (evidence.privateSourceAttested) {
      return {
        ...base,
        label: ATTESTED_LABEL,
        earnedPoints: 2,
        status: "earned",
      };
    }
    return {
      ...base,
      label: PUBLIC_LABEL,
      earnedPoints: 0,
      status: "missing",
      remediation: PUBLIC_REPOSITORY_REMEDIATION,
    };
  }
  // the registry awards an attested private source on the attestation alone, with no outside check
  if (evidence.privateSource.kind === "attested") {
    return {
      ...base,
      label: ATTESTED_LABEL,
      earnedPoints: 2,
      status: "earned",
    };
  }
  if (
    evidence.repository !== undefined && parseVcsUrl(evidence.repository)
  ) {
    return {
      ...base,
      label: PUBLIC_LABEL,
      earnedPoints: 0,
      status: "provisional",
    };
  }
  return {
    ...base,
    label: PUBLIC_LABEL,
    earnedPoints: 0,
    status: "missing",
    remediation: PUBLIC_REPOSITORY_REMEDIATION +
      privateSourceNote(evidence.privateSource),
  };
}
