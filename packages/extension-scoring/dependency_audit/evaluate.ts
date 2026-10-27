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
 * The dependency trust audit's decisions, given what npm, OSV and JSR
 * answered: which findings each dependency gets, how push words them, how
 * the registry's scorecard words them, and the points they cost. The caller
 * fetches; nothing here does I/O.
 *
 * An audit runs in two passes per package: {@link planNpmPackage} resolves
 * the version each specifier ships from the packument, the caller queries
 * OSV once per version it names, then {@link evaluateNpmPackage} decides.
 * JSR has no OSV data, so {@link evaluateJsrPackage} decides from the
 * package's `meta.json` alone.
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
import type { ShippedDependency } from "./audit_record.ts";
import type { JsrPackageMeta, NpmPackageFacts, NpmPackument } from "./npm.ts";
import { factsFor, monthsSince } from "./npm.ts";
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

/** A lookup's outcome: its data, or why the service could not answer. */
export type Lookup<T> =
  | { kind: "found"; value: T }
  | { kind: "unavailable"; reason: string };

/**
 * Why a finding exists, for the causes that change what the author does:
 * - `not-audited`: a lookup failed, so the dependency is unknown.
 * - `deprecated-version`: the version that ships is deprecated while the
 *   package's latest is not.
 * - `loose-specifier`: an unpinned, range or dist-tag specifier; the finding
 *   names the version that was audited.
 * - `jsr-yanked`: the JSR version that ships is yanked.
 * - `jsr-missing`: the JSR package or version does not exist.
 */
export type DependencyTrustCause =
  | "not-audited"
  | "deprecated-version"
  | "loose-specifier"
  | "jsr-yanked"
  | "jsr-missing";

/** One finding as push reports it. */
export interface DependencyTrustIssue {
  dependency: string;
  message: string;
  /** Present on not-audited and the shipped-version findings only. */
  cause?: DependencyTrustCause;
  /**
   * The version to move to, on `jsr-yanked` and `deprecated-version`
   * findings when another stable version exists.
   */
  suggestedVersion?: string;
  /** How to resolve a finding that has a cause. */
  remediation?: string;
  /** Which fix `remediation` gives; present on `not-audited` findings only. */
  notAuditedFix?: NotAuditedFix;
}

/** One dependency's audit as push lists it. */
export interface DependencyAuditSummary {
  name: string;
  /**
   * The import specifier as the source writes it, e.g. `npm:ms@^2.1.0`, or
   * the one the import map resolves a bare import to.
   */
  specifier: string;
  /** The bare specifier the source wrote, when the import map resolved it. */
  importedAs?: string;
  version: string;
  /** Where `version` came from; absent when nothing resolved. */
  resolvedFrom?: ShippedVersionSource;
  registry: DependencyRegistry;
  license: string | null;
  weeklyDownloads: number | null;
  publishedAgo: string | null;
  passed: boolean;
  /** Present only when the dependency was not audited; `passed` is false. */
  cause?: DependencyTrustCause;
  /** Which lookup failed and how, present with `cause`. */
  reason?: string;
  /** How to resolve it, present with `cause`. */
  notAuditedFix?: NotAuditedFix;
}

/** The audit as push reports it: errors block a push, warnings print. */
export interface DependencyTrustResult {
  errors: DependencyTrustIssue[];
  warnings: DependencyTrustIssue[];
  audited: DependencyAuditSummary[];
  passed: boolean;
  /**
   * The version that ships for each specifier the audit resolved, for the
   * archive's dependency audit record (swamp-club#3662). A version the
   * audit found unpublished is left out.
   */
  shipped?: ShippedDependency[];
}

/** A finding as the registry's scorecard words it. */
export interface ScorecardDependencyFinding {
  packageName: string;
  reason: string;
  cause?: DependencyTrustCause;
}

/** A dependency the scorecard lists as audited. */
export interface ScorecardDependencyAudited {
  registry: DependencyRegistry;
  packageName: string;
  specifier: string;
  version: string | null;
  resolvedFrom: ShippedVersionSource | null;
}

/** The audit as the registry's scorecard stores it. */
export interface ScorecardDependencyTrust {
  passed: boolean;
  earnedPoints: number;
  blockerCount: number;
  blockers: ScorecardDependencyFinding[];
  warnings: ScorecardDependencyFinding[];
  notAudited: { packageName: string; reason: string }[];
  audited: ScorecardDependencyAudited[];
}

/** Thresholds for the npm warnings. */
export interface TrustThresholds {
  minWeeklyDownloads: number;
  maxAgeMonths: number;
}

/** The thresholds both push and the registry apply. */
export const DEFAULT_TRUST_THRESHOLDS: TrustThresholds = {
  minWeeklyDownloads: 1_000,
  maxAgeMonths: 24,
};

/** Licenses a dependency may carry without a warning. */
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

/** The most dependencies one audit looks up; the rest are not audited. */
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

/** One finding with both wordings. */
interface Finding {
  level: "error" | "warning";
  issue: DependencyTrustIssue;
  /** How the scorecard records it; null when it does not. */
  scorecard:
    | {
      kind: "blocker" | "warning";
      reason: string;
      cause?: DependencyTrustCause;
    }
    | { kind: "not-audited"; reason: string }
    | null;
}

/** One specifier's audit. */
export interface SpecifierAudit {
  findings: readonly Finding[];
  summary: DependencyAuditSummary;
  /** The version that ships, unless the audit found it unpublished. */
  shipped?: ShippedVersion;
  /** The version the audit resolved, published or not; null when none. */
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

/** The npm gates over the facts for the version that ships. */
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

/** What to add to a fix when the lockfile, not the source, chose the version. */
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
 * An unpinned, range or dist-tag specifier's finding, naming the version
 * that was audited; null for an exact pin.
 */
function looseSpecifierFinding(
  spec: DependencySpecifier,
  shipped: ShippedVersion,
  lock: LockedDependencyVersions | undefined,
): Finding | null {
  const kind = specifierKind(spec.version);
  if (kind === "exact") return null;
  const phrase = kind === "unpinned"
    ? "unpinned"
    : kind === "range"
    ? "a range"
    : "a dist-tag";
  const from = shipped.from === "lockfile" && lock
    ? ` (from ${lock.source})`
    : shipped.from === "installed"
    ? " (installed in node_modules)"
    : "";
  const by = shipped.recorded
    ? "the version push recorded"
    : "the version the registry resolved";
  const scorecardFrom = shipped.from === "lockfile"
    ? ` (from ${lock?.source ?? "deno.lock"})`
    : shipped.recorded && shipped.from === "installed"
    ? " (installed in node_modules)"
    : "";
  return warning(
    spec.name,
    {
      message: `${
        specifierText(spec)
      } is ${phrase}; audited ${shipped.version}, the version this push resolves${from}`,
      cause: "loose-specifier",
      remediation: shipped.from === "installed"
        ? `Pin the exact installed version (${shipped.version}) in package.json to ensure that the audited version is the one that ships.`
        : `Pin the exact version this push resolved (${shipped.version}) to ensure that the audited version is the one that ships.`,
    },
    `${
      specifierText(spec)
    } is ${phrase}; audited ${shipped.version}, ${by}${scorecardFrom}`,
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

/** An npm package's packument lookup, or a name never looked up. */
export type NpmLookup = Lookup<NpmPackument> | { kind: "invalid-name" };

/** Whether an npm package name may be looked up at all. */
export function npmNameValid(name: string): boolean {
  return NPM_NAME_RE.test(name);
}

/** Whether a JSR package name may be looked up at all. */
export function jsrNameValid(name: string): boolean {
  return JSR_NAME_RE.test(name);
}

/** The versions each specifier of one npm package ships, before OSV is asked. */
export interface NpmPlan {
  /** Per specifier, in order: the version that ships, or null. */
  shipped: (ShippedVersion | null)[];
  /** The distinct versions to query OSV for. */
  osvVersions: string[];
}

/**
 * Resolves the version each specifier of one npm package ships. Without
 * npm metadata only an exact, installed, recorded or locked version still
 * lets OSV answer.
 */
export function planNpmPackage(
  name: string,
  specs: readonly DependencySpecifier[],
  npm: NpmLookup,
  lock?: LockedDependencyVersions,
  record?: RecordedDependencyVersions,
): NpmPlan {
  if (npm.kind === "invalid-name") {
    return { shipped: specs.map(() => null), osvVersions: [] };
  }
  const published: PublishedPackage | null = npm.kind === "found"
    ? { versions: npm.value.publishedVersions, distTags: npm.value.distTags }
    : null;
  const shipped = specs.map((spec) =>
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
  return { shipped, osvVersions };
}

/**
 * Audits every specifier of one npm package from its packument and the
 * OSV answers for the versions {@link planNpmPackage} named.
 */
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
  if (npm.kind === "invalid-name") {
    return specs.map((spec) =>
      notAuditedAudit(
        spec,
        "invalid npm package name",
        summaryBase(name, spec, "npm"),
        "name",
        null,
      )
    );
  }
  return specs.map((spec, index): SpecifierAudit => {
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
      const loose = looseSpecifierFinding(spec, shipped, lock);
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

/** A JSR package's `meta.json` lookup. */
export type JsrLookup =
  | Lookup<JsrPackageMeta>
  | { kind: "missing" }
  | { kind: "invalid-name" };

/**
 * Audits every specifier of one JSR package from its `meta.json`: the
 * package and the version that ships must exist, and a yanked version
 * costs both points. OSV has no JSR data, so there is no vulnerability
 * check.
 */
export function evaluateJsrPackage(
  name: string,
  specs: readonly DependencySpecifier[],
  meta: JsrLookup,
  lock?: LockedDependencyVersions,
  record?: RecordedDependencyVersions,
): SpecifierAudit[] {
  return specs.map((spec): SpecifierAudit => {
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
      // An exact or locked version ships whether or not JSR answered.
      const known = resolveShippedVersion(
        "jsr",
        name,
        spec.version,
        lock,
        null,
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

    const shipped = resolveShippedVersion(
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
    const loose = looseSpecifierFinding(spec, shipped, lock);
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
 * The specifiers grouped by package, in first-appearance order, with the
 * ones past {@link MAX_AUDITED_DEPENDENCIES} (in registry, name and version
 * order) set aside: those are not looked up.
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

/** The audit of the specifiers {@link groupForAudit} set aside. */
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

/** A package whose audit threw: every specifier of it is not audited. */
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
 * Names the bare imports a finding came from, so the pusher can find the
 * line. Deno resolved them under the project's config — its imports, an
 * importMap file, a scope or a workspace root (swamp-club#3612) — and the
 * module graph does not say which, so the config is not named further. In
 * a package.json project they resolved to an installed dependency
 * (swamp-club#3630).
 */
function importedAsSuffix(
  names: readonly string[],
  throughPackageJson: boolean,
): string {
  return ` (imported as ${names.map((n) => `"${n}"`).join(", ")} through ${
    throughPackageJson ? "package.json" : "the project's Deno config"
  })`;
}

/** The audit as push reports it, from every specifier's audit in order. */
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
 * Why a module that does not parse is not audited: its imports cannot be
 * read, so its dependencies are unknown (swamp-club#3983).
 */
export const UNREADABLE_MODULE_REASON =
  "Its imports cannot be read: the module does not parse, so its dependencies were not audited.";

/**
 * The audit as the registry's scorecard stores it. `unreadable` lists the
 * archive paths of code modules `writtenSpecifiers` could not read;
 * each is not audited, under its path, so it costs the factor's points as
 * an unaudited dependency does.
 */
export function scorecardResult(
  audits: readonly { spec: DependencySpecifier; audit: SpecifierAudit }[],
  unreadable: readonly string[] = [],
): ScorecardDependencyTrust {
  const blockers: ScorecardDependencyFinding[] = [];
  const warnings: ScorecardDependencyFinding[] = [];
  const notAudited: { packageName: string; reason: string }[] = unreadable
    .map((path) => ({ packageName: path, reason: UNREADABLE_MODULE_REASON }));
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
 * The findings that cost both points of the rubric's `dependency-trust`
 * factor besides an unaudited dependency: every error, a deprecated shipped
 * version and a yanked JSR version. Push only warns about the last two
 * (`--yes` accepts them) but the rubric scores against them, as the
 * registry's scorecard does.
 */
export function dependencyTrustBlockerCount(
  result: DependencyTrustResult,
): number {
  return result.errors.length +
    result.warnings.filter((w) =>
      w.cause === "deprecated-version" || w.cause === "jsr-yanked"
    ).length;
}

/** How many dependencies have a loose specifier; together they cost one point. */
export function looseSpecifierCount(result: DependencyTrustResult): number {
  return new Set(
    result.warnings
      .filter((w) => w.cause === "loose-specifier")
      .map((w) => w.dependency),
  ).size;
}

/**
 * The distinct fixes the unaudited dependencies need; a finding without
 * one counts as `other`.
 */
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

/** Whether every unaudited dependency is down to a lookup outage alone. */
export function onlyOutagesNotAudited(
  fixes: readonly NotAuditedFix[],
): boolean {
  return fixes.length > 0 && fixes.every((fix) => fix === "outage");
}

/**
 * The specifiers no published version matches, as the source (or its
 * import map) writes them.
 */
export function unpublishedSpecifiers(result: DependencyTrustResult): string[] {
  return [
    ...new Set(
      result.audited
        .filter((a) => a.notAuditedFix === "specifier")
        .map((a) => a.specifier),
    ),
  ];
}

/** How many dependencies a lookup failure left unaudited. */
export function notAuditedCount(result: DependencyTrustResult): number {
  return new Set(
    result.warnings
      .filter((w) => w.cause === "not-audited")
      .map((w) => w.dependency),
  ).size;
}
