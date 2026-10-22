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

import {
  join,
  resolve,
  SEPARATOR,
  toFileUrl as pathToFileUrl,
} from "@std/path";
import type {
  ExtensionManifest,
  PublishVisibility,
} from "./extension_manifest.ts";
import {
  describeDocFailure,
  describeUnpublishedSpecifiers,
  DOC_FAILURE_FALLBACK,
} from "./extension_doc_failure.ts";
import {
  NOT_AUDITED_FIX,
  type NotAuditedFix,
} from "./extension_dependency_trust_checker.ts";
import { markErrorPaths } from "../errors.ts";
import { plainDenoEnv } from "../runtime/deno_plain_env.ts";
import { isValidManifestLicense } from "../licensing/manifest_license_policy.ts";

/**
 * Client-side scorer for the Swamp Club extension quality rubric.
 *
 * Client-side counterpart to swamp-club's server-side scorecard pipeline
 * (`lib/domain/scorecard/analysis-factors.ts` and
 * `lib/domain/scorecard/score.ts` in the swamp-club repo). Factors the
 * CLI can fully evaluate use the same logic as the server. The
 * `repository-verified` factor is marked "provisional" locally because
 * only the server can award it — by HTTP-HEADing the URL, or through the
 * collective's private source hosting for a private extension — so its
 * points are excluded from the client-side total and tracked separately
 * as `provisionalPoints`.
 *
 * Distinct from `extension_quality_checker.ts` in this directory —
 * that module runs `deno fmt` / `deno lint` / dynamic-import checks as
 * part of packaging (bundle safety). This module computes the
 * authoring-quality rubric (README, LICENSE, JSDoc coverage, manifest
 * completeness, repository URL).
 *
 * Pipeline:
 *   1. Extract the pre-built tarball to a temp directory.
 *   2. Strip attacker-controlled config files (matches server's
 *      hermeticity stripping) and write a controlled deno.json so
 *      `deno doc` resolves npm/jsr specifiers consistently.
 *   3. Collect entrypoints from the manifest, prefixing with the
 *      field name the way the server does.
 *   4. Run `deno doc --json` and `deno doc --lint` with CWD at the
 *      extraction root. `--lint` exits 0 regardless of diagnostics;
 *      we parse stdout/stderr for `error[<code>]` patterns. When
 *      `deno doc --json` fails (the source does not resolve), lint is
 *      skipped and the failure is scored, not thrown, as the server
 *      does (swamp-club#3370).
 *   5. Compute the 5 per-version factors and the 3 per-package
 *      factors + `repository-verified`, then compose a rubric v2
 *      score.
 */

/** Schema version. Matches swamp-club's RUBRIC_VERSION. */
export const RUBRIC_VERSION = 4;

/**
 * Slow-type diagnostic codes emitted by `deno doc --lint`. When any of
 * these appear the package fails the `fast-check` factor. Mirrors
 * swamp-club's SLOW_TYPE_CODES set exactly.
 */
export const SLOW_TYPE_CODES: ReadonlySet<string> = new Set([
  "missing-return-type",
  "missing-explicit-type",
  "private-type-ref",
  "unsupported-ambient-module",
  "unsupported-complex-reference",
  "unsupported-default-export-expr",
  "unsupported-destructuring",
  "unsupported-global-module",
  "unsupported-require",
  "unsupported-ts-export-assignment",
  "unsupported-ts-instantiation-expression",
  "unsupported-ts-namespace-export",
  "unsupported-using-stmt",
]);

/** Hosts recognised as publicly-verifiable for `repository-verified`. */
const VERIFIED_REPO_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "gitlab.com",
  "codeberg.org",
  "bitbucket.org",
]);

/** Entrypoint-bearing manifest fields the analyzer runs `deno doc` against. */
const ENTRYPOINT_FIELDS = [
  "models",
  "vaults",
  "datastores",
  "reports",
  "webhooks",
] as const;

const RICH_README_MIN_LENGTH = 500;
const RICH_README_MIN_CODE_BLOCKS = 2;
const SYMBOLS_DOCS_FULL_THRESHOLD = 0.8;

// ── Pure helpers (mirror analysis-factors.ts) ──────────────────────────

// deno-lint-ignore no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, "");
}

/** True if the markdown text contains a fenced code block. */
export function hasFencedCodeBlock(md: string): boolean {
  return /^```[\w-]*\s*\n[\s\S]*?\n```/m.test(md);
}

/** Count fenced code blocks; non-overlapping, same regex as the boolean check. */
export function countFencedCodeBlocks(md: string): number {
  const matches = md.match(/^```[\w-]*\s*\n[\s\S]*?\n```/gm);
  return matches ? matches.length : 0;
}

/**
 * Parse the combined stdout+stderr from `deno doc --lint`, strip ANSI,
 * and count how many diagnostics belong to {@link SLOW_TYPE_CODES}.
 * `deno doc --lint` exits 0 even with errors printed, so the caller
 * does NOT rely on exit status — this is the source of truth.
 */
export function countSlowTypeDiagnostics(rawLintOutput: string): number {
  const plain = stripAnsi(rawLintOutput);
  const codes = [...plain.matchAll(/error\[([a-z-]+)\]/g)].map((m) => m[1]);
  let count = 0;
  for (const code of codes) {
    if (SLOW_TYPE_CODES.has(code)) count++;
  }
  return count;
}

/** A single node in `deno doc --json` output. */
export interface DocNode {
  module_doc?: { doc?: string };
  symbols?: Array<{
    name: string;
    declarations?: Array<{
      declarationKind: string;
      jsDoc?: { doc?: string };
      kind: string;
    }>;
  }>;
}

/** Full `deno doc --json` shape. */
export interface DocOutput {
  version: number;
  nodes: Record<string, DocNode>;
}

/**
 * Module-level doc check for a single entrypoint. The entrypointUrl is
 * a `file://` URL — that's how `deno doc` keys its output nodes.
 */
export function hasModuleDoc(doc: DocOutput, entrypointUrl: string): boolean {
  const node = doc.nodes[entrypointUrl];
  return !!(node?.module_doc?.doc && node.module_doc.doc.trim());
}

/**
 * Count `(totalExports, documentedExports)` for one entrypoint.
 * An exported declaration is any symbol with `declarationKind === "export"`.
 * Overloaded symbols declare multiple declarations — each counts separately.
 */
export function countExports(
  doc: DocOutput,
  entrypointUrl: string,
): { total: number; documented: number } {
  const node = doc.nodes[entrypointUrl];
  let total = 0;
  let documented = 0;
  for (const sym of node?.symbols ?? []) {
    for (const d of sym.declarations ?? []) {
      if (d.declarationKind !== "export") continue;
      total++;
      if (d.jsDoc?.doc?.trim()) documented++;
    }
  }
  return { total, documented };
}

/** Per-version analysis factors, mirrors server's AnalysisFactors. */
export interface AnalysisFactors {
  hasReadme: boolean;
  hasReadmeExamples: boolean;
  allEntrypointsDocs: boolean;
  percentageDocumentedSymbols: number;
  allFastCheck: boolean;
  readmeLength: number | null;
  readmeCodeBlockCount: number | null;
  hasLicenseFile: boolean;
  dependencyTrustPassed: boolean;
  dependencyTrustBlockerCount: number;
  /** Dependencies a failed OSV, npm or JSR lookup left unaudited. */
  dependencyNotAuditedCount: number;
  /** The distinct fixes the unaudited dependencies need. */
  dependencyNotAuditedFixes: readonly NotAuditedFix[];
  /** Dependencies with a loose specifier: they cost one of the two points. */
  dependencyLooseCount: number;
  /**
   * No secret-unsafe-docs finding is left unaccepted: the docs keep secrets
   * in a vault (swamp-club#3757).
   */
  secretSafeDocs: boolean;
}

/**
 * Compose all per-version factors from subprocess output plus README
 * text. Pure — no I/O, no subprocess calls. Mirrors
 * analysis-factors.ts#computeAnalysisFactors verbatim.
 */
export function computeAnalysisFactors(input: {
  entrypointUrls: string[];
  readme: string | null;
  hasLicenseFile: boolean;
  doc: DocOutput;
  rawLintOutput: string;
  dependencyTrustPassed?: boolean;
  dependencyTrustBlockerCount?: number;
  dependencyNotAuditedCount?: number;
  dependencyNotAuditedFixes?: readonly NotAuditedFix[];
  dependencyLooseCount?: number;
  /** No secret-unsafe-docs finding is left unaccepted; unchecked when absent. */
  secretSafeDocs?: boolean;
  /** `deno doc` could not analyse the source, so `doc` is empty. */
  docFailed?: boolean;
}): AnalysisFactors {
  const { entrypointUrls, readme, hasLicenseFile, doc, rawLintOutput } = input;
  const docFailed = input.docFailed === true;

  const moduleDocs = entrypointUrls.map((ep) => ({
    ep,
    hasDoc: hasModuleDoc(doc, ep),
  }));

  let totalSymbols = 0;
  let documentedSymbols = 0;
  for (const ep of entrypointUrls) {
    const { total, documented } = countExports(doc, ep);
    totalSymbols += total;
    documentedSymbols += documented;
  }

  const hasReadmeFile = readme !== null;
  const hasReadme = hasReadmeFile || moduleDocs.some((m) => m.hasDoc);
  const hasReadmeExamples = readme ? hasFencedCodeBlock(readme) : false;
  const allEntrypointsDocs = moduleDocs.length > 0 &&
    moduleDocs.every((m) => m.hasDoc);
  // an unanalysed source documents nothing; the empty doc would otherwise read as 100%
  const ratio = docFailed
    ? 0
    : totalSymbols === 0
    ? 1
    : documentedSymbols / totalSymbols;
  const percentageDocumentedSymbols = Number(ratio.toFixed(4));
  const allFastCheck = countSlowTypeDiagnostics(rawLintOutput) === 0;

  const readmeLength = readme === null ? null : readme.length;
  const readmeCodeBlockCount = readme === null
    ? null
    : countFencedCodeBlocks(readme);

  return {
    hasReadme,
    hasReadmeExamples,
    allEntrypointsDocs,
    percentageDocumentedSymbols,
    allFastCheck,
    readmeLength,
    readmeCodeBlockCount,
    hasLicenseFile,
    dependencyTrustPassed: input.dependencyTrustPassed ?? false,
    dependencyTrustBlockerCount: input.dependencyTrustBlockerCount ?? 0,
    dependencyNotAuditedCount: input.dependencyNotAuditedCount ?? 0,
    dependencyNotAuditedFixes: input.dependencyNotAuditedFixes ?? [],
    dependencyLooseCount: input.dependencyLooseCount ?? 0,
    secretSafeDocs: input.secretSafeDocs ?? false,
  };
}

// ── Score composition (mirror score.ts) ────────────────────────────────

/** Status of one scorecard row. */
export type FactorStatus = "earned" | "partial" | "missing" | "provisional";

/** One row of the scorecard. */
export interface RubricFactor {
  id: string;
  label: string;
  earnedPoints: number;
  maxPoints: number;
  status: FactorStatus;
  remediation?: string;
}

/** Complete rubric score. */
export interface RubricScore {
  rubricVersion: number;
  factors: RubricFactor[];
  earnedPoints: number;
  maxEarnablePoints: number;
  percentage: number;
  allPassed: boolean;
  provisionalPoints: number;
  maxClientEarnablePoints: number;
  /**
   * Why `deno doc` could not analyse the source, or null when it could.
   * When set, the documentation factors score 0, as on the registry.
   */
  docAnalysisError: string | null;
}

/**
 * Structural check for repository verification. The server does an
 * additional HTTP HEAD to confirm the URL is live and public — the CLI
 * reports the structural result optimistically, noting that the final
 * verdict comes from the server after publish. Returns:
 *   true  → URL is HTTPS and on an allowlisted host (will earn the
 *           factor if the repo is public at publish time)
 *   false → URL is missing, malformed, non-HTTPS, or on a host the
 *           server does not accept for verification
 */
export function repositoryLikelyVerifiable(
  repository: string | undefined,
): boolean {
  if (!repository) return false;
  let url: URL;
  try {
    url = new URL(repository);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return VERIFIED_REPO_HOSTS.has(url.hostname.toLowerCase());
}

/**
 * Whether the registry will award `repository-verified` through the
 * collective's private source hosting, as far as the CLI can tell before
 * publish. The registry awards it to a private extension whose collective
 * has private source hosting, whatever the repository URL
 * (`repositoryVerifiedFactor` in swamp-club's `score.ts`).
 *   attested     → the registry awards the factor
 *   not_attested → it does not; `reason` says which half is missing
 *   unknown      → the CLI could not tell (no credentials, swamp-club
 *                  unreachable, or a server that does not report it), so
 *                  the factor is scored on the repository URL alone
 */
export type PrivateSourceStanding =
  | { kind: "attested" }
  | {
    kind: "not_attested";
    reason: "public_extension" | "no_private_source_hosting";
  }
  | { kind: "unknown" };

/**
 * Whether a publish of this extension will be private, mirroring the
 * registry's `confirm-push.ts`: a republish keeps the stored visibility,
 * and a first publish is private when the manifest asks for it or the
 * collective's namespace is private, whatever the manifest says otherwise.
 *
 * @param existing the published extension, or null when it is not
 *   published yet
 */
export function predictPublishedPrivate(
  existing: { isPrivate: boolean } | null,
  manifestVisibility: PublishVisibility | undefined,
  privateNamespace: boolean,
): boolean {
  if (existing) return existing.isPrivate;
  return manifestVisibility === "private" || privateNamespace;
}

/**
 * Compose a RubricScore from the per-version analysis factors and the
 * manifest. Mirrors score.ts#composeScore but restricted to the
 * signals the CLI can observe (no access to server-side `license`
 * SPDX string or the server's HTTP-HEAD repository verification).
 *
 * `verified-by-swamp` is not in the rubric — it's an editorial badge
 * that does not move the percentage. Provenance is currently gated
 * off on the server and is omitted here for parity.
 */
export function composeScore(
  factors: AnalysisFactors,
  manifest: ExtensionManifest,
  privateSource: PrivateSourceStanding = { kind: "unknown" },
  docAnalysisError: string | null = null,
): RubricScore {
  const rows: RubricFactor[] = [
    boolRow("has-readme", "Has README or module doc", 2, factors.hasReadme, {
      remediation:
        "Add `README.md` to `additionalFiles:` as a bare basename — the " +
        "entry is copied verbatim to `extension/files/<entry>` in the " +
        "archive, so nested paths like `docs/README.md` won't earn the " +
        "factor. For per-directory layouts (manifest beside README), opt " +
        "in with `paths.base: manifest`. " +
        (docAnalysisError === null
          ? "Or add a module-level JSDoc at the top of every entrypoint file."
          : "A module-level JSDoc counts only once deno doc can analyse " +
            `the source: ${docAnalysisError}`),
    }),
    boolRow(
      "readme-example",
      "README has a code example",
      1,
      factors.hasReadmeExamples,
      {
        remediation:
          "Add at least one fenced code block (``` … ```) to README showing usage.",
      },
    ),
    richReadmeRow(factors.readmeLength, factors.readmeCodeBlockCount),
    symbolsRow(factors.percentageDocumentedSymbols, docAnalysisError),
    boolRow("fast-check", "No slow types (deprecated)", 1, true, {}),
    boolRow(
      "description",
      "Has description",
      1,
      typeof manifest.description === "string" &&
        manifest.description.trim().length > 0,
      { remediation: "Fill `description:` in manifest.yaml." },
    ),
    boolRow(
      "platforms",
      "Platform support declared (or universal)",
      2,
      manifest.platforms.length === 0 || manifest.platforms.length >= 1,
      {
        remediation:
          "Set `platforms:` in manifest.yaml — list supported platforms " +
          "or leave it empty to declare universal support.",
      },
    ),
    boolRow(
      "has-license",
      "License declared",
      1,
      isValidManifestLicense(manifest.license),
      {
        remediation: "Declare the license in manifest.yaml as an SPDX " +
          "expression, e.g. `license: MIT` or `license: MIT OR Apache-2.0`. " +
          "Only SPDX identifiers count; a `LicenseRef-` or `AdditionRef-` " +
          "earns nothing.",
      },
    ),
    boolRow(
      "license-file",
      "LICENSE file included",
      1,
      factors.hasLicenseFile,
      {
        remediation: "Add a non-empty LICENSE / LICENSE.md / LICENSE.txt " +
          "entry to `additionalFiles:` as a bare basename — entries are " +
          "copied verbatim to `extension/files/<entry>` in the archive, so " +
          "nested paths won't earn the factor. For per-directory layouts " +
          "(manifest beside LICENSE), opt in with `paths.base: manifest`.",
      },
    ),
    repositoryVerifiedRow(manifest.repository, privateSource),
    dependencyTrustRow(
      factors.dependencyTrustPassed,
      factors.dependencyTrustBlockerCount,
      factors.dependencyNotAuditedCount,
      factors.dependencyNotAuditedFixes,
      factors.dependencyLooseCount,
    ),
    boolRow(
      "secret-safe-docs",
      "Docs keep secrets in a vault",
      1,
      factors.secretSafeDocs,
      {
        remediation: "Fix or accept each secret-unsafe-docs warning: the " +
          "README, the manifest description and describe strings should " +
          "store secrets with `swamp vault put <vault> <key>` (it prompts " +
          "for the value) and pass them as " +
          "`${{ vault.get(<vault>, <key>) }}`.",
      },
    ),
  ];

  const earned = rows.reduce((s, r) => s + r.earnedPoints, 0);
  const max = rows.reduce((s, r) => s + r.maxPoints, 0);
  const provisional = rows
    .filter((r) => r.status === "provisional")
    .reduce((s, r) => s + r.maxPoints, 0);
  const clientMax = max - provisional;
  const percentage = clientMax === 0
    ? 0
    : Math.floor((earned * 100) / clientMax);

  return {
    rubricVersion: RUBRIC_VERSION,
    factors: rows,
    earnedPoints: earned,
    maxEarnablePoints: max,
    percentage,
    allPassed: rows.every((r) =>
      r.status === "earned" || r.status === "provisional"
    ),
    provisionalPoints: provisional,
    maxClientEarnablePoints: clientMax,
    docAnalysisError: null,
  };
}

function boolRow(
  id: string,
  label: string,
  maxPoints: number,
  earned: boolean,
  extra: { remediation?: string } = {},
): RubricFactor {
  return {
    id,
    label,
    earnedPoints: earned ? maxPoints : 0,
    maxPoints,
    status: earned ? "earned" : "missing",
    remediation: earned ? undefined : extra.remediation,
  };
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

function repositoryVerifiedRow(
  repository: string | undefined,
  privateSource: PrivateSourceStanding,
): RubricFactor {
  if (privateSource.kind === "attested") {
    return {
      id: "repository-verified",
      label: "Private repository (collective attested)",
      earnedPoints: 0,
      maxPoints: 2,
      status: "provisional",
    };
  }
  const verifiable = repositoryLikelyVerifiable(repository);
  if (verifiable) {
    return {
      id: "repository-verified",
      label: "Verified public repository (server confirms on publish)",
      earnedPoints: 0,
      maxPoints: 2,
      status: "provisional",
    };
  }
  return {
    id: "repository-verified",
    label: "Verified public repository (server confirms on publish)",
    earnedPoints: 0,
    maxPoints: 2,
    status: "missing",
    remediation: PUBLIC_REPOSITORY_REMEDIATION +
      privateSourceNote(privateSource),
  };
}

function richReadmeRow(
  readmeLength: number | null,
  readmeCodeBlockCount: number | null,
): RubricFactor {
  if (readmeLength === null || readmeCodeBlockCount === null) {
    return {
      id: "rich-readme",
      label: "README is substantive",
      earnedPoints: 0,
      maxPoints: 1,
      status: "missing",
      remediation:
        `Add a README ≥${RICH_README_MIN_LENGTH} characters with ≥${RICH_README_MIN_CODE_BLOCKS} fenced code blocks.`,
    };
  }
  const earned = readmeLength >= RICH_README_MIN_LENGTH &&
    readmeCodeBlockCount >= RICH_README_MIN_CODE_BLOCKS;
  return {
    id: "rich-readme",
    label: "README is substantive",
    earnedPoints: earned ? 1 : 0,
    maxPoints: 1,
    status: earned ? "earned" : "missing",
    remediation: earned
      ? undefined
      : `Expand README to ≥${RICH_README_MIN_LENGTH} chars with ≥${RICH_README_MIN_CODE_BLOCKS} fenced blocks.`,
  };
}

/** Why a dependency with this fix was not audited, for the row's text. */
const NOT_AUDITED_WHY: Readonly<
  Record<Exclude<NotAuditedFix, "other">, string>
> = {
  outage: "an OSV, npm or JSR lookup failed",
  specifier: "no published version matches the specifier",
  name: "the package name is invalid",
  unexpected: "the audit failed unexpectedly",
};

/**
 * The remediation for unaudited dependencies: one known cause gives its
 * reason and fix; several, or one the row cannot name, send the author to
 * each finding's own fix, which the findings report prints and JSON carries
 * as `remediation`. Only an outage says to re-run.
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

function dependencyTrustRow(
  noBlockers: boolean,
  blockerCount: number,
  notAuditedCount: number,
  notAuditedFixes: readonly NotAuditedFix[],
  looseCount: number,
): RubricFactor {
  // An unaudited dependency is unknown, not partly trusted: it loses the
  // factor exactly as a blocker does. A loose specifier alone costs one of
  // the two points.
  const full = noBlockers && notAuditedCount === 0;
  const earnedPoints = !full ? 0 : looseCount > 0 ? 1 : 2;
  const looseText = `${looseCount} loose dependency specifier(s) ` +
    `(loose-specifier) cost 1 of 2 points. Pin an exact, published ` +
    `version to earn the second point.`;
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
  return {
    id: "dependency-trust",
    label: "Dependencies pass trust gates",
    earnedPoints,
    maxPoints: 2,
    status: earnedPoints === 2 ? "earned" : "missing",
    remediation: earnedPoints === 2 ? undefined : remediation,
  };
}

function symbolsRow(
  pct: number,
  docAnalysisError: string | null,
): RubricFactor {
  const earned = pct >= SYMBOLS_DOCS_FULL_THRESHOLD;
  return {
    id: "symbols-docs",
    label: "Most symbols documented",
    earnedPoints: earned ? 1 : 0,
    maxPoints: 1,
    status: earned ? "earned" : "missing",
    remediation: earned
      ? undefined
      : docAnalysisError !== null
      ? "deno doc could not analyse the source, so JSDoc coverage could " +
        `not be measured: ${docAnalysisError}`
      : `Add JSDoc to ≥${
        Math.round(SYMBOLS_DOCS_FULL_THRESHOLD * 100)
      }% of exported symbols in entrypoints (current: ${
        Math.round(pct * 100)
      }%).`,
  };
}

// ── Tarball extraction + deno doc orchestrator ─────────────────────────

/**
 * Extracts a `.tar.gz` byte stream into the given directory. Domain owns
 * the port; the libswamp layer wires in `extractTarGz` from
 * `infrastructure/archive/tar_archive.ts` so this module doesn't reach
 * across layers. Tests inject a fake.
 */
export type ExtractTarball = (
  source: ReadableStream<Uint8Array>,
  destDir: string,
) => Promise<void>;

/** Injected subprocess deps — makes tests hermetic. */
export interface RubricScoreDeps {
  runDeno: (
    args: string[],
    cwd: string,
  ) => Promise<{ success: boolean; stdout: string; stderr: string }>;
  extractTarball: ExtractTarball;
}

/** Default deps: real `deno` subprocess plus the supplied tarball extractor. */
export function createRubricScoreDeps(
  denoPath: string,
  extractTarball: ExtractTarball,
  denoEnv?: Record<string, string>,
): RubricScoreDeps {
  const plainEnv = plainDenoEnv(denoEnv ?? Deno.env.toObject());
  return {
    runDeno: async (args, cwd) => {
      const cmd = new Deno.Command(denoPath, {
        args,
        cwd,
        stdout: "piped",
        stderr: "piped",
        env: plainEnv,
      });
      const out = await cmd.output();
      return {
        success: out.success,
        stdout: new TextDecoder().decode(out.stdout),
        stderr: new TextDecoder().decode(out.stderr),
      };
    },
    extractTarball,
  };
}

const STRIPPED_CONFIG_FILES = [
  "deno.json",
  "deno.jsonc",
  "deno.lock",
  "package.json",
  "package-lock.json",
  ".npmrc",
] as const;

const README_FILENAMES = ["README.md", "README.MD", "readme.md", "Readme.md"];

const LICENSE_FILENAMES = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "LICENSE.MD",
  "LICENSE.TXT",
  "License",
  "License.md",
  "License.txt",
  "license",
  "license.md",
  "license.txt",
  "COPYING",
  "COPYING.md",
  "COPYING.txt",
];

/**
 * Score a pre-built extension tarball against the rubric. Extracts
 * the tarball to a temp dir, strips hermetic configs, writes a
 * controlled deno.json, runs `deno doc`, and composes the score —
 * mirroring swamp-club's DenoDocExtensionTarballAnalyzer +
 * composeScore pipeline.
 */
export async function scoreExtensionTarball(
  tarballBytes: Uint8Array,
  manifest: ExtensionManifest,
  deps: RubricScoreDeps,
  options?: {
    dependencyTrustPassed?: boolean;
    dependencyTrustBlockerCount?: number;
    dependencyNotAuditedCount?: number;
    dependencyNotAuditedFixes?: readonly NotAuditedFix[];
    dependencyLooseCount?: number;
    /** No secret-unsafe-docs finding is left unaccepted. */
    secretSafeDocs?: boolean;
    privateSource?: PrivateSourceStanding;
    /**
     * Specifiers npm publishes no version for, from the dependency audit:
     * they name the cause when deno's own output does not.
     */
    unpublishedSpecifiers?: string[];
  },
): Promise<RubricScore> {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_quality_" });
  try {
    const extractDir = join(tmpDir, "extract");
    await Deno.mkdir(extractDir);

    try {
      await deps.extractTarball(
        ReadableStream.from([tarballBytes]),
        extractDir,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to extract tarball for scoring: ${message}`);
    }

    // Locate the directory that holds manifest.yaml. Swamp CLI's
    // archives put everything under `extension/`, so the common case
    // is extractDir/extension/manifest.yaml.
    const logicalRoot = await findManifestRoot(extractDir);

    // Strip any config files the packager might have included, then
    // write our controlled deno.json so `deno doc` resolves npm/jsr
    // specifiers consistently. Mirrors server hermeticity.
    for (const name of STRIPPED_CONFIG_FILES) {
      await Deno.remove(join(logicalRoot, name)).catch(() => {});
    }
    await Deno.remove(join(logicalRoot, "node_modules"), { recursive: true })
      .catch(() => {});

    const controlledConfig: Record<string, unknown> = {
      nodeModulesDir: "auto",
    };
    await Deno.writeTextFile(
      join(logicalRoot, "deno.json"),
      JSON.stringify(controlledConfig, null, 2) + "\n",
    );

    const rootAbs = resolve(logicalRoot);
    const entrypointPaths = collectEntrypoints(logicalRoot, rootAbs, manifest);

    const readme = await findReadme(logicalRoot);
    const hasLicenseFile = await findLicenseFile(logicalRoot);

    let doc: DocOutput = { version: 1, nodes: {} };
    let lintOutput = "";
    let docAnalysisError: string | null = null;
    if (entrypointPaths.length > 0) {
      try {
        doc = await runDenoDocJson(entrypointPaths, logicalRoot, deps);
      } catch (err) {
        if (!(err instanceof DenoDocFailedError)) throw err;
        docAnalysisError = describeDocFailure(
          err.output,
          await fileUrlRoots(rootAbs),
        );
        const unpublished = options?.unpublishedSpecifiers ?? [];
        if (
          docAnalysisError === DOC_FAILURE_FALLBACK && unpublished.length > 0
        ) {
          docAnalysisError = describeUnpublishedSpecifiers(unpublished);
        }
      }
      if (docAnalysisError === null) {
        lintOutput = await runDenoDocLint(entrypointPaths, logicalRoot, deps);
      }
    }

    const entrypointUrls = entrypointPaths.map(toFileUrl);
    const analysisFactors = computeAnalysisFactors({
      entrypointUrls,
      readme,
      hasLicenseFile,
      doc,
      rawLintOutput: lintOutput,
      dependencyTrustPassed: options?.dependencyTrustPassed,
      dependencyTrustBlockerCount: options?.dependencyTrustBlockerCount,
      dependencyNotAuditedCount: options?.dependencyNotAuditedCount,
      dependencyNotAuditedFixes: options?.dependencyNotAuditedFixes,
      dependencyLooseCount: options?.dependencyLooseCount,
      secretSafeDocs: options?.secretSafeDocs,
      docFailed: docAnalysisError !== null,
    });

    return {
      ...composeScore(
        analysisFactors,
        manifest,
        options?.privateSource,
        docAnalysisError,
      ),
      docAnalysisError,
    };
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

export async function findManifestRoot(extractDir: string): Promise<string> {
  try {
    await Deno.stat(join(extractDir, "manifest.yaml"));
    return extractDir;
  } catch {
    // Not at top level — check one level down (CLI packages under `extension/`).
  }
  for await (const entry of Deno.readDir(extractDir)) {
    if (!entry.isDirectory) continue;
    const candidate = join(extractDir, entry.name);
    try {
      await Deno.stat(join(candidate, "manifest.yaml"));
      return candidate;
    } catch {
      // keep looking
    }
  }
  throw markErrorPaths(
    new Error(
      `No manifest.yaml found in extracted tarball at ${extractDir}`,
    ),
    [extractDir],
  );
}

/** Walk manifest fields for entrypoints; prefix each with its field directory. */
export function collectEntrypoints(
  root: string,
  rootAbs: string,
  manifest: ExtensionManifest,
): string[] {
  const eps: string[] = [];
  for (const field of ENTRYPOINT_FIELDS) {
    const list = manifest[field];
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      if (typeof p !== "string") continue;
      const normalized = p.replace(/^\.\//, "");
      const prefixed = normalized.startsWith(`${field}/`)
        ? normalized
        : `${field}/${normalized}`;
      const entryAbs = resolve(root, prefixed);
      if (entryAbs !== rootAbs && !entryAbs.startsWith(rootAbs + SEPARATOR)) {
        throw markErrorPaths(
          new Error(`Entrypoint escapes extraction root: ${p}`),
          [p],
        );
      }
      eps.push(entryAbs);
    }
  }
  return eps;
}

/** README lookup at logical root AND files/ subdirectory. */
async function findReadme(root: string): Promise<string | null> {
  const dirs = [root, join(root, "files")];
  for (const dir of dirs) {
    for (const name of README_FILENAMES) {
      try {
        return await Deno.readTextFile(join(dir, name));
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

/** LICENSE file lookup at logical root AND files/ subdirectory. */
async function findLicenseFile(root: string): Promise<boolean> {
  const dirs = [root, join(root, "files")];
  for (const dir of dirs) {
    for (const name of LICENSE_FILENAMES) {
      try {
        const info = await Deno.stat(join(dir, name));
        if (info.isFile && info.size > 0) return true;
      } catch {
        // keep looking
      }
    }
  }
  return false;
}

function toFileUrl(abs: string): string {
  return new URL("file://" + abs).href;
}

/**
 * The extraction root as deno's `file://` URLs spell it — the resolved
 * path and, where it differs (a symlinked temp dir), the real path.
 */
async function fileUrlRoots(rootAbs: string): Promise<string[]> {
  const spellings = [rootAbs];
  try {
    const real = await Deno.realPath(rootAbs);
    if (real !== rootAbs) spellings.push(real);
  } catch {
    // the resolved spelling alone
  }
  return spellings.map((p) => decodeURIComponent(pathToFileUrl(p).pathname));
}

/** `deno doc --json` exited non-zero: the source did not resolve. */
class DenoDocFailedError extends Error {
  constructor(readonly output: string) {
    super("deno doc --json failed");
    this.name = "DenoDocFailedError";
  }
}

async function runDenoDocJson(
  entrypoints: string[],
  cwd: string,
  deps: RubricScoreDeps,
): Promise<DocOutput> {
  const result = await deps.runDeno(
    ["doc", "--json", ...entrypoints],
    cwd,
  );
  if (!result.success) {
    throw new DenoDocFailedError(result.stderr + "\n" + result.stdout);
  }
  try {
    return JSON.parse(result.stdout) as DocOutput;
  } catch (err) {
    throw new Error(`deno doc --json returned invalid JSON: ${String(err)}`);
  }
}

async function runDenoDocLint(
  entrypoints: string[],
  cwd: string,
  deps: RubricScoreDeps,
): Promise<string> {
  // `deno doc --lint` exits 0 even with diagnostics; we parse the text.
  const result = await deps.runDeno(
    ["doc", "--lint", ...entrypoints],
    cwd,
  );
  return result.stdout + result.stderr;
}
