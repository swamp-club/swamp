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
 * no I/O here: planNpmPackage resolves versions, the caller queries OSV once
 * per version, evaluateNpmPackage decides; JSR has no OSV data, so
 * evaluateJsrPackage decides from meta.json alone
 */

import {
  parseSpdxExpression,
  spdxLeaves,
} from "../licensing/spdx_expression.ts";
import {
  dependencyTrustEarnedPoints,
  NOT_AUDITED_FIX,
  type NotAuditedFix,
} from "./points.ts";
import type {
  ShippedDependency,
  UnauditedDependency,
  UnauditedDependencyKind,
} from "./audit_record.ts";
import type { JsrPackageMeta, NpmPackageFacts, NpmPackument } from "./npm.ts";
import { factsFor, monthsSince, sanitiseDeprecationNotice } from "./npm.ts";
import type { OsvVulnerability } from "./osv.ts";
import {
  type LockedDependencyVersions,
  type PublishedPackage,
  type RecordedDependencyVersions,
  resolveShippedVersion,
  type ShippedVersion,
  type ShippedVersionSource,
  specifierKind,
  suggestVersion,
} from "./resolution.ts";
import {
  compareSpecifiers,
  type DependencyRegistry,
  type DependencySpecifier,
  JSR_NAME_RE,
  NPM_NAME_RE,
  specifierText,
} from "./specifiers.ts";

export type Lookup<T> =
  | { kind: "found"; value: T }
  | { kind: "unavailable"; reason: string };

export type DependencyTrustCause =
  | "not-audited"
  | "deprecated-version"
  | "loose-specifier"
  | "jsr-yanked"
  | "jsr-missing";

export interface DependencyTrustIssue {
  dependency: string;
  message: string;
  cause?: DependencyTrustCause;
  suggestedVersion?: string;
  remediation?: string;
  notAuditedFix?: NotAuditedFix;
}

export interface DependencyAuditSummary {
  name: string;
  specifier: string;
  importedAs?: string;
  version: string;
  resolvedFrom?: ShippedVersionSource;
  registry: DependencyRegistry;
  license: string | null;
  weeklyDownloads: number | null;
  publishedAgo: string | null;
  passed: boolean;
  cause?: DependencyTrustCause;
  reason?: string;
  notAuditedFix?: NotAuditedFix;
}

export interface DependencyTrustResult {
  errors: DependencyTrustIssue[];
  warnings: DependencyTrustIssue[];
  audited: DependencyAuditSummary[];
  passed: boolean;
  /** a version the audit found unpublished is left out */
  shipped?: ShippedDependency[];
}

export interface ScorecardDependencyFinding {
  packageName: string;
  reason: string;
  cause?: DependencyTrustCause;
}

export interface ScorecardDependencyAudited {
  registry: DependencyRegistry;
  packageName: string;
  specifier: string;
  version: string | null;
  resolvedFrom: ShippedVersionSource | null;
}

export interface ScorecardDependencyTrust {
  passed: boolean;
  earnedPoints: number;
  blockerCount: number;
  blockers: ScorecardDependencyFinding[];
  warnings: ScorecardDependencyFinding[];
  notAudited: { packageName: string; reason: string }[];
  audited: ScorecardDependencyAudited[];
}

export interface TrustThresholds {
  minWeeklyDownloads: number;
  maxAgeMonths: number;
}

/** The thresholds both push and the registry apply. */
export const DEFAULT_TRUST_THRESHOLDS: TrustThresholds = {
  minWeeklyDownloads: 1_000,
  maxAgeMonths: 24,
};

export const LICENSE_ALLOWLIST: ReadonlySet<string> = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "MPL-2.0",
  "Unlicense",
  "CC0-1.0",
]);

export const MAX_AUDITED_DEPENDENCIES = 50;

/**
 * Whether a dependency's license passes: a valid SPDX expression every
 * license of which is on the allowlist. No license, or one that does not
 * parse, does not.
 */
export function licenseAllowed(license: string | null | undefined): boolean {
  if (!license) return false;
  try {
    return spdxLeaves(parseSpdxExpression(license)).every((leaf) =>
      leaf.kind === "license" && !leaf.orLater && LICENSE_ALLOWLIST.has(leaf.id)
    );
  } catch {
    return false;
  }
}

interface Finding {
  level: "error" | "warning";
  issue: DependencyTrustIssue;
  scorecard:
    | {
      kind: "blocker" | "warning";
      reason: string;
      cause?: DependencyTrustCause;
    }
    | { kind: "not-audited"; reason: string }
    | null;
}

export interface SpecifierAudit {
  findings: readonly Finding[];
  summary: DependencyAuditSummary;
  shipped?: ShippedVersion;
  resolved: ShippedVersion | null;
}

function blocker(
  name: string,
  push: Omit<DependencyTrustIssue, "dependency">,
  reason: string,
  level: "error" | "warning" = "error",
): Finding {
  return {
    level,
    issue: { dependency: name, ...push },
    scorecard: {
      kind: "blocker",
      reason,
      ...(push.cause ? { cause: push.cause } : {}),
    },
  };
}

function warning(
  name: string,
  push: Omit<DependencyTrustIssue, "dependency">,
  reason: string,
): Finding {
  return {
    level: "warning",
    issue: { dependency: name, ...push },
    scorecard: {
      kind: "warning",
      reason,
      ...(push.cause ? { cause: push.cause } : {}),
    },
  };
}

function notAuditedFinding(
  spec: DependencySpecifier,
  reason: string,
  fix: NotAuditedFix,
): Finding {
  return {
    level: "warning",
    issue: {
      dependency: spec.name,
      message: `not audited: ${reason}`,
      cause: "not-audited",
      remediation: NOT_AUDITED_FIX[fix],
      notAuditedFix: fix,
    },
    scorecard: { kind: "not-audited", reason },
  };
}

/** HIGH, CRITICAL and UNKNOWN vulnerabilities block; MEDIUM ones warn. */
function vulnerabilityFindings(
  name: string,
  vulns: readonly OsvVulnerability[],
): Finding[] {
  const out: Finding[] = [];
  for (const v of vulns) {
    const sev = v.severity;
    if (sev === "HIGH" || sev === "CRITICAL" || sev === "UNKNOWN") {
      out.push(
        blocker(
          name,
          { message: `vulnerability ${v.id} (${sev})` },
          `${sev} vulnerability: ${v.id}`,
        ),
      );
    } else if (sev === "MEDIUM") {
      out.push(
        warning(
          name,
          { message: `vulnerability ${v.id} (${sev})` },
          `MEDIUM vulnerability: ${v.id}`,
        ),
      );
    }
  }
  return out;
}

function npmGateFindings(
  name: string,
  facts: NpmPackageFacts,
  vulns: readonly OsvVulnerability[],
  thresholds: TrustThresholds,
  now: Date,
): Finding[] {
  const findings = vulnerabilityFindings(name, vulns);
  if (facts.deprecated && facts.latestDeprecated) {
    findings.unshift(
      blocker(
        name,
        { message: "package is deprecated" },
        "package is deprecated",
      ),
    );
  } else if (facts.deprecated) {
    const text = `version ${facts.version} is deprecated${
      facts.deprecationReason ? `: ${facts.deprecationReason}` : ""
    }`;
    // push warns (`--yes` accepts it); the score counts it as a blocker
    findings.push(
      blocker(
        name,
        {
          message: text,
          cause: "deprecated-version",
          ...(facts.suggestedVersion
            ? { suggestedVersion: facts.suggestedVersion }
            : {}),
          remediation: facts.suggestedVersion
            ? `Move to ${facts.suggestedVersion}, the newest version that isn't deprecated.`
            : "Move to a non-deprecated version of the package.",
        },
        text,
        "warning",
      ),
    );
  }

  if (!licenseAllowed(facts.license)) {
    const text = `license "${facts.license ?? "unknown"}" not in allowlist`;
    findings.push(warning(name, { message: text }, text));
  }

  if (facts.maintainerCount === 0) {
    findings.push(
      warning(
        name,
        { message: "no maintainers listed" },
        "no maintainers listed",
      ),
    );
  }

  if (
    facts.weeklyDownloads !== null &&
    facts.weeklyDownloads < thresholds.minWeeklyDownloads
  ) {
    findings.push(
      warning(
        name,
        {
          message:
            `low weekly downloads (${facts.weeklyDownloads} < ${thresholds.minWeeklyDownloads})`,
        },
        `weekly downloads (${facts.weeklyDownloads}) below ${thresholds.minWeeklyDownloads}`,
      ),
    );
  }

  if (facts.lastPublish) {
    const ageMonths = monthsSince(facts.lastPublish, now);
    if (ageMonths > thresholds.maxAgeMonths) {
      findings.push(
        warning(
          name,
          {
            message:
              `last published ${ageMonths} months ago (threshold: ${thresholds.maxAgeMonths})`,
          },
          `last publish ${ageMonths} months ago (threshold: ${thresholds.maxAgeMonths})`,
        ),
      );
    }
  }
  return findings;
}

function formatAge(lastPublish: string | null, now: Date): string | null {
  if (!lastPublish) return null;
  const months = monthsSince(lastPublish, now);
  if (months <= 0) return "this month";
  if (months === 1) return "1mo ago";
  return `${months}mo ago`;
}

function lockRefreshNote(
  shipped: ShippedVersion,
  lock: LockedDependencyVersions | undefined,
): string {
  return shipped.from === "installed"
    ? " Then run `npm install` or `deno install` so node_modules holds the new version."
    : shipped.from === "lockfile" && lock
    ? ` Then refresh ${lock.source} so it records the new version.`
    : "";
}

/**
 * null for an exact pin or a locked version; pinning exact versions and
 * committing a lock earn the point alike
 */
function looseSpecifierFinding(
  spec: DependencySpecifier,
  shipped: ShippedVersion,
): Finding | null {
  if (shipped.looseAs !== undefined) {
    return recordedLooseFinding(spec.name, shipped.looseAs, shipped.version);
  }
  const kind = specifierKind(spec.version);
  if (kind === "exact") return null;
  if (shipped.locked || shipped.from === "lockfile") return null;
  const phrase = kind === "unpinned"
    ? "unpinned"
    : kind === "range"
    ? "a range"
    : "a dist-tag";
  const by = shipped.recorded
    ? "the version push recorded"
    : "the version the registry resolved";
  const scorecardFrom = shipped.recorded && shipped.from === "installed"
    ? " (installed in node_modules)"
    : "";
  return warning(
    spec.name,
    {
      message: `no lock: ${
        spec.version ?? "an unpinned import"
      } resolved to ${shipped.version} today; commit a lock or pin exact versions (costs 1 point)`,
      cause: "loose-specifier",
      remediation: shipped.from === "installed"
        ? `Commit a deno.lock or a package-lock.json that matches node_modules, or pin the exact installed version (${shipped.version}) in package.json.`
        : `Commit a deno.lock, or pin the exact version this push resolved (${shipped.version}).`,
    },
    `${
      specifierText(spec)
    } is ${phrase} and no lock fixed it; audited ${shipped.version}, ${by}${scorecardFrom}`,
  );
}

/** the source is exact, but the author wrote looseAs and no valid lock fixed it */
function recordedLooseFinding(
  name: string,
  looseAs: string,
  version: string,
): Finding {
  return warning(
    name,
    {
      message:
        `no lock: ${looseAs} resolved to ${version} when it was pushed; commit a lock or pin exact versions (costs 1 point)`,
      cause: "loose-specifier",
      remediation:
        `Commit a deno.lock, or pin the exact version push recorded (${version}).`,
    },
    `${looseAs} is not an exact version and no lock fixed it; audited ${version}, the version push recorded`,
  );
}

function summaryBase(
  name: string,
  spec: DependencySpecifier,
  registry: DependencyRegistry,
): Omit<DependencyAuditSummary, "passed"> {
  return {
    name,
    specifier: specifierText(spec),
    version: spec.version ?? "latest",
    registry,
    license: null,
    weeklyDownloads: null,
    publishedAgo: null,
  };
}

function notAuditedAudit(
  spec: DependencySpecifier,
  reason: string,
  summary: Omit<DependencyAuditSummary, "passed" | "cause" | "reason">,
  fix: NotAuditedFix,
  resolved: ShippedVersion | null,
  findings: Finding[] = [],
): SpecifierAudit {
  return {
    findings: [...findings, notAuditedFinding(spec, reason, fix)],
    summary: {
      ...summary,
      passed: false,
      cause: "not-audited",
      reason,
      notAuditedFix: fix,
    },
    resolved,
  };
}

export type NpmLookup = Lookup<NpmPackument> | { kind: "invalid-name" };

export function npmNameValid(name: string): boolean {
  return NPM_NAME_RE.test(name);
}

export function jsrNameValid(name: string): boolean {
  return JSR_NAME_RE.test(name);
}

export interface NpmPlan {
  shipped: (ShippedVersion | null)[];
  /**
   * why the specifier breaks the canonical shipped form, or null; absent
   * without a v2 record
   */
  canonicalIssues?: (string | null)[];
  osvVersions: string[];
}

/**
 * without npm metadata only an exact, installed, recorded or locked version
 * still lets OSV answer
 */
export function planNpmPackage(
  name: string,
  specs: readonly DependencySpecifier[],
  npm: NpmLookup,
  lock?: LockedDependencyVersions,
  record?: RecordedDependencyVersions,
): NpmPlan {
  const canonicalIssues = canonicalIssuesOf(specs, record);
  const issues = canonicalIssues ? { canonicalIssues } : {};
  if (npm.kind === "invalid-name") {
    return { shipped: specs.map(() => null), osvVersions: [], ...issues };
  }
  const published: PublishedPackage | null = npm.kind === "found"
    ? { versions: npm.value.publishedVersions, distTags: npm.value.distTags }
    : null;
  const shipped = specs.map((spec) =>
    spec.bundled ??
      resolveShippedVersion(
        "npm",
        name,
        spec.version,
        lock,
        published,
        spec.installedVersion,
        record,
      )
  );
  const osvVersions = [
    ...new Set(shipped.flatMap((s) => s === null ? [] : [s.version])),
  ];
  return { shipped, osvVersions, ...issues };
}

function canonicalIssuesOf(
  specs: readonly DependencySpecifier[],
  record: RecordedDependencyVersions | undefined,
): (string | null)[] | undefined {
  const issueOf = record?.canonicalIssue;
  return issueOf
    ? specs.map((spec) => issueOf(specifierText(spec)))
    : undefined;
}

function canonicalAudit(
  name: string,
  spec: DependencySpecifier,
  registry: DependencyRegistry,
  issue: string,
): SpecifierAudit {
  return notAuditedAudit(
    spec,
    issue,
    summaryBase(name, spec, registry),
    "canonical",
    null,
  );
}

export function evaluateNpmPackage(
  name: string,
  specs: readonly DependencySpecifier[],
  npm: NpmLookup,
  plan: NpmPlan,
  osv: ReadonlyMap<string, Lookup<OsvVulnerability[]>>,
  now: Date,
  lock?: LockedDependencyVersions,
  thresholds: TrustThresholds = DEFAULT_TRUST_THRESHOLDS,
): SpecifierAudit[] {
  return specs.map((spec, index): SpecifierAudit => {
    const issue = plan.canonicalIssues?.[index] ?? null;
    if (issue !== null) return canonicalAudit(name, spec, "npm", issue);
    if (npm.kind === "invalid-name") {
      return notAuditedAudit(
        spec,
        "invalid npm package name",
        summaryBase(name, spec, "npm"),
        "name",
        null,
      );
    }
    const shipped = plan.shipped[index];
    const version = shipped?.version ?? null;
    const answer = version === null ? null : osv.get(version) ?? null;

    const failures: string[] = [];
    // A wrong specifier fails the same way on every re-run; a lookup that
    // failed may not.
    let wrongSpecifier = false;
    // An exact, installed or locked version still ships when npm is down,
    // so only a version npm says it never published is left unrecorded.
    let unpublished = false;
    if (npm.kind === "unavailable") {
      failures.push(`npm registry lookup failed (${npm.reason})`);
    } else if (
      version !== null && !Object.hasOwn(npm.value.manifests, version)
    ) {
      failures.push(`npm lists no version ${version}`);
      wrongSpecifier = true;
      unpublished = true;
    }
    if (answer === null) {
      failures.push(
        npm.kind === "found"
          ? `OSV not queried (no published version matches ${
            spec.version ?? "latest"
          })`
          : "OSV not queried (no resolvable version)",
      );
      if (npm.kind === "found") wrongSpecifier = true;
    } else if (answer.kind === "unavailable") {
      failures.push(`OSV lookup failed (${answer.reason})`);
    }
    const vulns = answer?.kind === "found" ? answer.value : [];

    // facts only for a version npm lists; never borrow another version's
    const facts = npm.kind === "found" && version !== null &&
        Object.hasOwn(npm.value.manifests, version)
      ? factsFor(npm.value, version)
      : null;
    const findings = facts
      ? npmGateFindings(name, facts, vulns, thresholds, now)
      : vulnerabilityFindings(name, vulns);
    if (shipped) {
      const note = lockRefreshNote(shipped, lock);
      for (const f of findings) {
        if (f.issue.cause === "deprecated-version" && f.issue.remediation) {
          f.issue.remediation += note;
        }
      }
      const loose = looseSpecifierFinding(spec, shipped);
      if (loose) findings.push(loose);
    }

    const summary = {
      ...summaryBase(name, spec, "npm"),
      version: version ?? spec.version ?? "latest",
      ...(shipped ? { resolvedFrom: shipped.from } : {}),
      license: facts?.license ?? null,
      weeklyDownloads: facts?.weeklyDownloads ?? null,
      publishedAgo: formatAge(facts?.lastPublish ?? null, now),
    };
    const audit: SpecifierAudit = failures.length > 0
      ? notAuditedAudit(
        spec,
        failures.join("; "),
        summary,
        wrongSpecifier ? "specifier" : "outage",
        shipped,
        findings,
      )
      : {
        findings,
        summary: {
          ...summary,
          passed: !findings.some((f) => f.level === "error"),
        },
        resolved: shipped,
      };
    return shipped && !unpublished ? { ...audit, shipped } : audit;
  });
}

export type JsrLookup =
  | Lookup<JsrPackageMeta>
  | { kind: "missing" }
  | { kind: "invalid-name" };

/**
 * the package and the version that ships must exist, and a yanked version costs
 * both points; OSV has no JSR data, so there is no vulnerability check
 */
export function evaluateJsrPackage(
  name: string,
  specs: readonly DependencySpecifier[],
  meta: JsrLookup,
  lock?: LockedDependencyVersions,
  record?: RecordedDependencyVersions,
): SpecifierAudit[] {
  return specs.map((spec): SpecifierAudit => {
    // checked here to name the issue; resolveShippedVersion repeats the
    // check for any other caller that hands it a v2 record
    const issue = record?.canonicalIssue?.(specifierText(spec)) ?? null;
    if (issue !== null) return canonicalAudit(name, spec, "jsr", issue);
    const base = summaryBase(name, spec, "jsr");
    const missing = (
      message: string,
      resolved: ShippedVersion | null,
    ): SpecifierAudit => ({
      findings: [
        blocker(name, { message, cause: "jsr-missing" }, message),
      ],
      summary: { ...base, passed: false },
      resolved,
    });

    if (meta.kind === "invalid-name") {
      return missing("invalid JSR package name", null);
    }
    if (meta.kind === "missing") return missing("JSR package not found", null);
    if (meta.kind === "unavailable") {
      // An exact, bundled or locked version ships whether or not JSR answered.
      const known = spec.bundled ?? resolveShippedVersion(
        "jsr",
        name,
        spec.version,
        lock,
        null,
        undefined,
        record,
      );
      const audit = notAuditedAudit(
        spec,
        `JSR lookup failed (${meta.reason})`,
        base,
        "outage",
        known,
      );
      return known ? { ...audit, shipped: known } : audit;
    }

    const shipped = spec.bundled ?? resolveShippedVersion(
      "jsr",
      name,
      spec.version,
      lock,
      {
        versions: meta.value.versions,
        distTags: meta.value.latest ? { latest: meta.value.latest } : {},
        yanked: meta.value.yanked,
      },
      undefined,
      record,
    );
    if (!shipped || !meta.value.versions.includes(shipped.version)) {
      return missing(
        `version ${
          shipped?.version ?? spec.version ?? "latest"
        } not found on JSR`,
        shipped,
      );
    }

    const findings: Finding[] = [];
    if (meta.value.yanked.has(shipped.version)) {
      const suggested = suggestVersion(
        shipped.version,
        meta.value.versions,
        meta.value.yanked,
      );
      const text =
        `version ${shipped.version} was withdrawn (yanked) by its author on JSR. ${
          suggested
            ? `Newest version that isn't yanked: ${suggested}.`
            : "No other version is available."
        }`;
      // push warns (`--yes` accepts it); the score counts it as a blocker
      findings.push(
        blocker(
          name,
          {
            message: text,
            cause: "jsr-yanked",
            ...(suggested ? { suggestedVersion: suggested } : {}),
            remediation: (suggested
              ? `Pin jsr:${name}@${suggested} (or the newest non-yanked version your code supports).`
              : "Wait for the author to publish a replacement, or replace the dependency.") +
              lockRefreshNote(shipped, lock),
          },
          text,
          "warning",
        ),
      );
    }
    const loose = looseSpecifierFinding(spec, shipped);
    if (loose) findings.push(loose);
    return {
      findings,
      summary: {
        ...base,
        version: shipped.version,
        resolvedFrom: shipped.from,
        passed: true,
      },
      shipped,
      resolved: shipped,
    };
  });
}

/**
 * specifiers past MAX_AUDITED_DEPENDENCIES (in registry, name and version
 * order) are set aside and not looked up
 */
export function groupForAudit(
  specifiers: readonly DependencySpecifier[],
): {
  groups: DependencySpecifier[][];
  overLimit: DependencySpecifier[];
} {
  const ranked = [...specifiers].sort(compareSpecifiers);
  const over = new Set(ranked.slice(MAX_AUDITED_DEPENDENCIES));
  const packages = new Map<string, DependencySpecifier[]>();
  for (const spec of specifiers) {
    if (over.has(spec)) continue;
    const key = `${spec.registry}:${spec.name}`;
    const group = packages.get(key);
    if (group) group.push(spec);
    else packages.set(key, [spec]);
  }
  return {
    groups: [...packages.values()],
    overLimit: ranked.slice(MAX_AUDITED_DEPENDENCIES),
  };
}

export function overLimitAudits(
  specs: readonly DependencySpecifier[],
): SpecifierAudit[] {
  return specs.map((spec) =>
    notAuditedAudit(
      spec,
      `not queried: over the ${MAX_AUDITED_DEPENDENCIES}-dependency limit`,
      summaryBase(spec.name, spec, spec.registry),
      "other",
      null,
    )
  );
}

export function failedPackageAudits(
  specs: readonly DependencySpecifier[],
  failure: string,
): SpecifierAudit[] {
  return specs.map((spec) =>
    notAuditedAudit(
      spec,
      `audit check failed (${failure})`,
      summaryBase(spec.name, spec, spec.registry),
      "unexpected",
      null,
    )
  );
}

/**
 * names the bare imports a finding came from so the pusher can find the line;
 * the project config that resolved them is not named further, as the module
 * graph does not say which
 */
function importedAsSuffix(
  names: readonly string[],
  throughPackageJson: boolean,
): string {
  return ` (imported as ${names.map((n) => `"${n}"`).join(", ")} through ${
    throughPackageJson ? "package.json" : "the project's Deno config"
  })`;
}

export function pushResult(
  audits: readonly { spec: DependencySpecifier; audit: SpecifierAudit }[],
): DependencyTrustResult {
  const errors: DependencyTrustIssue[] = [];
  const warnings: DependencyTrustIssue[] = [];
  const audited: DependencyAuditSummary[] = [];
  const shipped: ShippedDependency[] = [];
  for (const { spec, audit } of audits) {
    const suffix = spec.importedAs === undefined ? "" : importedAsSuffix(
      [spec.importedAs],
      spec.installedVersion !== undefined,
    );
    for (const f of audit.findings) {
      const issue = { ...f.issue, message: f.issue.message + suffix };
      (f.level === "error" ? errors : warnings).push(issue);
    }
    audited.push(
      spec.importedAs === undefined
        ? audit.summary
        : { ...audit.summary, importedAs: spec.importedAs },
    );
    if (audit.shipped) {
      shipped.push({ specifier: spec, shipped: audit.shipped });
    }
  }
  return {
    errors,
    warnings,
    audited,
    passed: errors.length === 0,
    shipped,
  };
}

/**
 * a module that does not parse is not audited: its imports cannot be read, so
 * its dependencies are unknown
 */
export const UNREADABLE_MODULE_REASON =
  "Its imports cannot be read: the module does not parse, so its dependencies were not audited.";

const UNAUDITED_KIND_TEXT: Readonly<Record<UnauditedDependencyKind, string>> = {
  url: "a URL import",
  git: "a git dependency",
  "package-json": "a local package.json dependency",
};

/**
 * no registry audit covers this code, so it is not audited and costs both
 * points; the origin comes from an author-written record, so it is made safe
 * for one line before it is named
 */
function unauditedCodeFindings(
  unaudited: readonly UnauditedDependency[],
): { origin: string; issue: DependencyTrustIssue; reason: string }[] {
  const seen = new Set<string>();
  const out: { origin: string; issue: DependencyTrustIssue; reason: string }[] =
    [];
  for (const u of unaudited) {
    const origin = sanitiseDeprecationNotice(u.origin);
    if (seen.has(origin)) continue;
    seen.add(origin);
    const kind = UNAUDITED_KIND_TEXT[u.kind];
    out.push({
      origin,
      issue: {
        dependency: origin,
        message:
          `not audited: ${origin} is ${kind}, from outside npm and JSR, so no registry audit covers it`,
        cause: "not-audited",
        remediation: NOT_AUDITED_FIX.origin,
        notAuditedFix: "origin",
      },
      reason:
        `${kind}, from outside npm and JSR: no registry audit covers it. ${NOT_AUDITED_FIX.origin}`,
    });
  }
  return out;
}

/**
 * adds the code from outside npm and JSR as not-audited warnings, so extension
 * quality and push charge it as the registry does
 */
export function withUnauditedCode(
  result: DependencyTrustResult,
  unaudited: readonly UnauditedDependency[],
): DependencyTrustResult {
  const findings = unauditedCodeFindings(unaudited);
  if (findings.length === 0) return result;
  return {
    ...result,
    warnings: [...result.warnings, ...findings.map((f) => f.issue)],
  };
}

/**
 * each unreadable module path and each unaudited origin is not audited, so it
 * costs the factor's points as an unaudited dependency does
 */
export function scorecardResult(
  audits: readonly { spec: DependencySpecifier; audit: SpecifierAudit }[],
  unreadable: readonly string[] = [],
  unaudited: readonly UnauditedDependency[] = [],
): ScorecardDependencyTrust {
  const blockers: ScorecardDependencyFinding[] = [];
  const warnings: ScorecardDependencyFinding[] = [];
  const notAudited: { packageName: string; reason: string }[] = [
    ...unreadable.map((path) => ({
      packageName: path,
      reason: UNREADABLE_MODULE_REASON,
    })),
    ...unauditedCodeFindings(unaudited).map((f) => ({
      packageName: f.origin,
      reason: f.reason,
    })),
  ];
  const audited: ScorecardDependencyAudited[] = [];
  for (const { spec, audit } of audits) {
    audited.push({
      registry: spec.registry,
      packageName: spec.name,
      specifier: specifierText(spec),
      version: audit.resolved?.version ?? null,
      resolvedFrom: audit.resolved?.from ?? null,
    });
    for (const f of audit.findings) {
      const s = f.scorecard;
      if (s === null) continue;
      if (s.kind === "not-audited") {
        notAudited.push({ packageName: spec.name, reason: s.reason });
        continue;
      }
      const entry: ScorecardDependencyFinding = {
        packageName: spec.name,
        reason: s.reason,
        ...(s.cause ? { cause: s.cause } : {}),
      };
      (s.kind === "blocker" ? blockers : warnings).push(entry);
    }
  }
  return {
    passed: blockers.length === 0 && notAudited.length === 0,
    earnedPoints: dependencyTrustEarnedPoints({
      blockerCount: blockers.length,
      notAuditedCount: notAudited.length,
      looseCount: warnings.filter((w) => w.cause === "loose-specifier").length,
    }),
    blockerCount: blockers.length,
    blockers,
    warnings,
    notAudited,
    audited,
  };
}

/**
 * push only warns about a deprecated shipped version and a yanked JSR version,
 * but the rubric scores against them as the registry's scorecard does
 */
export function dependencyTrustBlockerCount(
  result: DependencyTrustResult,
): number {
  return result.errors.length +
    result.warnings.filter((w) =>
      w.cause === "deprecated-version" || w.cause === "jsr-yanked"
    ).length;
}

export function looseSpecifierCount(result: DependencyTrustResult): number {
  return new Set(
    result.warnings
      .filter((w) => w.cause === "loose-specifier")
      .map((w) => w.dependency),
  ).size;
}

export function notAuditedFixes(
  result: Pick<DependencyTrustResult, "warnings">,
): NotAuditedFix[] {
  return [
    ...new Set(
      result.warnings
        .filter((w) => w.cause === "not-audited")
        .map((w) => w.notAuditedFix ?? "other"),
    ),
  ];
}

export function onlyOutagesNotAudited(
  fixes: readonly NotAuditedFix[],
): boolean {
  return fixes.length > 0 && fixes.every((fix) => fix === "outage");
}

export function unpublishedSpecifiers(result: DependencyTrustResult): string[] {
  return [
    ...new Set(
      result.audited
        .filter((a) => a.notAuditedFix === "specifier")
        .map((a) => a.specifier),
    ),
  ];
}

export function notAuditedCount(result: DependencyTrustResult): number {
  return new Set(
    result.warnings
      .filter((w) => w.cause === "not-audited")
      .map((w) => w.dependency),
  ).size;
}
