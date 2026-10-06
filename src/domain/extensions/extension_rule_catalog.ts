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
 * The catalog of push-time rules: every rule id a safety or review finding
 * can carry, with the one fact that decides whether an author may declare
 * the finding acceptable.
 *
 * This is the single source of truth for that decision. An error-level rule
 * has no acceptance form, by construction: {@link isAcceptableRule} returns
 * false for it and nothing else in the codebase decides otherwise. The
 * adversarial-review family is warning-level but is evidence, not a lint,
 * and is not acceptable here either (it is handled by the attestation
 * design, swamp-club#3065). A rule id that is not in the catalog is unknown
 * and is never acceptable.
 *
 * The detectors keep their own severities (`ReviewRule.severity`,
 * `ContentRule.severity`); `extension_rule_catalog_test.ts` cross-checks
 * them against this table so the two cannot drift.
 */

/** Whether findings from a rule block the push (`error`) or prompt (`warning`). */
export type RuleSeverityClass = "error" | "warning";

/**
 * What a finding of this rule is about: one line in one file (`site`), a
 * whole file (`file`), or the extension as a package (`extension`). The
 * scope decides where an acceptance lives: a site or file finding takes a
 * comment in that file, an extension finding takes a sidecar entry.
 */
export type RuleScope = "site" | "file" | "extension";

/** One catalog entry. */
export interface RuleCatalogEntry {
  /** Stable identifier carried on every finding, e.g. `deno-command`. */
  readonly id: string;
  readonly severity: RuleSeverityClass;
  readonly scope: RuleScope;
  /**
   * Whether an author may declare a finding of this rule acceptable, with
   * a reason. Always false for error-level rules.
   */
  readonly acceptable: boolean;
  /**
   * Short advice on fixing the finding properly, printed in the push and
   * quality summaries. Present on every warning-level rule.
   */
  readonly remediation?: string;
}

/** The catalog. Append new rules here; a rule id used by a detector must be listed. */
export const RULE_CATALOG: readonly RuleCatalogEntry[] = [
  // ── Safety warnings (extension_safety_analyzer.ts) ──────────────────
  {
    id: "long-line",
    severity: "warning",
    scope: "site",
    acceptable: true,
    remediation:
      "Move embedded data to a file listed under additionalFiles and read it at run time, or wrap the literal across lines.",
  },
  {
    id: "base64-run",
    severity: "warning",
    scope: "site",
    acceptable: true,
    remediation:
      "Load encoded data from a file listed under additionalFiles (or binaries) at run time instead of embedding it in source.",
  },
  {
    id: "deno-command",
    severity: "warning",
    scope: "site",
    acceptable: true,
    remediation:
      "Prefer swamp's own primitives over spawning a subprocess; when one is required, validate every argument and document it in the README.",
  },
  {
    id: "ipv4-address-literals",
    severity: "warning",
    scope: "site",
    acceptable: true,
    remediation:
      "Use RFC 5737 documentation ranges (192.0.2.x, 198.51.100.x, 203.0.113.x) or example.com in examples.",
  },
  // ── Safety errors ───────────────────────────────────────────────────
  {
    id: "file-count",
    severity: "error",
    scope: "extension",
    acceptable: false,
  },
  { id: "hidden-file", severity: "error", scope: "file", acceptable: false },
  { id: "file-type", severity: "error", scope: "file", acceptable: false },
  {
    id: "unreadable-file",
    severity: "error",
    scope: "file",
    acceptable: false,
  },
  { id: "symlink", severity: "error", scope: "file", acceptable: false },
  { id: "file-size", severity: "error", scope: "file", acceptable: false },
  {
    id: "total-size",
    severity: "error",
    scope: "extension",
    acceptable: false,
  },
  { id: "dynamic-code", severity: "error", scope: "site", acceptable: false },
  // ── Review rules (extension_review_rules.ts) ────────────────────────
  {
    id: "schema-strictness",
    severity: "warning",
    scope: "site",
    acceptable: true,
    remediation:
      "Declare the properties the model reads so CEL expressions can validate against them; keep .passthrough() only beside declared properties.",
  },
  {
    id: "credentials-sensitive-field",
    severity: "warning",
    scope: "site",
    acceptable: true,
    remediation:
      "Mark the field .meta({ sensitive: true }) so swamp vaults its value, or rename it if it holds a reference rather than a secret.",
  },
  {
    id: "testing-completeness",
    severity: "warning",
    scope: "file",
    acceptable: true,
    remediation:
      "Add a sibling <name>_test.ts covering the success and failure paths.",
  },
  // ── Extension-scoped (appended by push) ─────────────────────────────
  {
    id: "bare-specifiers",
    severity: "warning",
    scope: "extension",
    acceptable: true,
    remediation:
      "Use explicit npm: or jsr: prefixes (for example npm:package@version) so the registry scorer can resolve imports.",
  },
  // ── Adversarial-review evidence: warnings, never acceptable here ────
  {
    id: "adversarial-review-report",
    severity: "warning",
    scope: "extension",
    acceptable: false,
    remediation:
      "Run the adversarial review and record its report at the path the finding names.",
  },
  {
    id: "adversarial-review-dimension-issue",
    severity: "warning",
    scope: "extension",
    acceptable: false,
    remediation:
      "Resolve the dimension the review flagged, or record why it stands in the report note.",
  },
  // ── Acceptance meta rules ───────────────────────────────────────────
  {
    id: "stale-acceptance",
    severity: "warning",
    scope: "site",
    acceptable: false,
    remediation:
      "Remove the acceptance; the finding it named no longer fires there.",
  },
  {
    id: "invalid-acceptance",
    severity: "error",
    scope: "site",
    acceptable: false,
  },
  // ── Quality-check ids (extension_quality_checker.ts), errors ────────
  { id: "fmt", severity: "error", scope: "file", acceptable: false },
  { id: "lint", severity: "error", scope: "file", acceptable: false },
  { id: "dynamic-import", severity: "error", scope: "site", acceptable: false },
  {
    id: "upgrade-chain",
    severity: "error",
    scope: "file",
    acceptable: false,
  },
];

const BY_ID: ReadonlyMap<string, RuleCatalogEntry> = new Map(
  RULE_CATALOG.map((entry) => [entry.id, entry]),
);

/** Looks up a rule by id; undefined for an unknown id. */
export function findRule(ruleId: string): RuleCatalogEntry | undefined {
  return BY_ID.get(ruleId);
}

/** True when the rule is in the catalog. */
export function isKnownRule(ruleId: string): boolean {
  return BY_ID.has(ruleId);
}

/**
 * True when an author may declare a finding of this rule acceptable. False
 * for every error-level rule, for the adversarial-review family, for the
 * acceptance meta rules, and for any id not in the catalog.
 */
export function isAcceptableRule(ruleId: string): boolean {
  const entry = BY_ID.get(ruleId);
  return entry !== undefined && entry.severity === "warning" &&
    entry.acceptable;
}

/** The remediation text for a rule, or undefined when it has none. */
export function remediationFor(ruleId: string): string | undefined {
  return BY_ID.get(ruleId)?.remediation;
}
