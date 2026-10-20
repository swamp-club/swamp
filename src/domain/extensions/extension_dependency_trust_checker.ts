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

import type { DependencySpecifier } from "./extension_dependency_extractor.ts";
import {
  type LockedDependencyVersions,
  type PublishedPackage,
  resolveAuditVersion,
  resolveShippedVersion,
  type ShippedVersion,
  type ShippedVersionSource,
  specifierKind,
  suggestVersion,
} from "./dependency_version_resolution.ts";

export { resolveAuditVersion };

/**
 * Why a finding needs the pusher's attention; every finding with a cause
 * joins the push warnings gate (an error with one still blocks).
 * - `not-audited`: an OSV, npm or JSR lookup failed, so the dependency was
 *   not checked and is never reported as passed.
 * - `deprecated-version`: the version that ships is deprecated while the
 *   package's latest is not.
 * - `loose-specifier`: an unpinned, range or dist-tag specifier; the finding
 *   names the version this push resolves.
 * - `jsr-yanked`: the JSR version that ships is yanked.
 * - `jsr-missing`: the JSR package or version does not exist (an error).
 */
export type DependencyTrustCause =
  | "not-audited"
  | "deprecated-version"
  | "loose-specifier"
  | "jsr-yanked"
  | "jsr-missing";

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
}

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
  registry: "npm" | "jsr";
  license: string | null;
  weeklyDownloads: number | null;
  publishedAgo: string | null;
  passed: boolean;
  /** Present only when the dependency was not audited; `passed` is false. */
  cause?: DependencyTrustCause;
  /** Which lookup failed and how, present with `cause`. */
  reason?: string;
}

export interface DependencyTrustResult {
  errors: DependencyTrustIssue[];
  warnings: DependencyTrustIssue[];
  audited: DependencyAuditSummary[];
  passed: boolean;
}

export interface TrustThresholds {
  minWeeklyDownloads: number;
  maxAgeMonths: number;
}

export const DEFAULT_TRUST_THRESHOLDS: TrustThresholds = {
  minWeeklyDownloads: 1000,
  maxAgeMonths: 24,
};

const LICENSE_ALLOWLIST: ReadonlySet<string> = new Set([
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

const OSV_QUERY_URL = "https://api.osv.dev/v1/query";
const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const NPM_DOWNLOADS_URL = "https://api.npmjs.org/downloads/point/last-week";
const JSR_REGISTRY_URL = "https://jsr.io";
const FETCH_TIMEOUT_MS = 15_000;
/** The most of a third-party deprecation notice a finding repeats. */
const MAX_DEPRECATION_REASON = 200;

// npm's naming rules, uppercase allowed for legacy names; anything else
// is never fetched.
const NPM_NAME_RE =
  /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
// JSR scopes and names are lowercase alphanumerics and hyphens.
const JSR_NAME_RE = /^@[a-z0-9-]+\/[a-z0-9-]+$/;

interface OsvVuln {
  id: string;
  severity: string;
}

interface NpmPackageFacts {
  version: string;
  license: string | null;
  /** The version that ships is deprecated. */
  deprecated: boolean;
  /**
   * Whether the package's latest is deprecated too. A deprecated version
   * whose latest is not is a warning; when both are (or this is unknown),
   * the package is deprecated and that is an error.
   */
  latestDeprecated?: boolean;
  /** npm's deprecation notice for the version that ships. */
  deprecationReason?: string;
  /** The newest stable version that is not deprecated, when one exists. */
  suggestedVersion?: string;
  maintainerCount: number;
  weeklyDownloads: number | null;
  lastPublish: string | null;
}

/** What the npm lookup returns: the packument, read once per package. */
interface NpmPackument {
  latestVersion: string;
  /** Every version the packument lists. */
  publishedVersions: string[];
  distTags: Record<string, string>;
  manifests: Record<string, Record<string, unknown>>;
  packageLevel: Record<string, unknown>;
  weeklyDownloads: number | null;
  lastPublish: string | null;
}

/** What JSR's `meta.json` says about one package. */
interface JsrPackageMeta {
  latest: string | null;
  versions: string[];
  yanked: Set<string>;
}

/** A lookup's outcome: its data, or why the service could not answer. */
type Lookup<T> =
  | { kind: "found"; value: T }
  | { kind: "unavailable"; reason: string };

export type Fetcher = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export function monthsSince(iso: string, now: Date = new Date()): number {
  const then = new Date(iso);
  const diffMs = now.getTime() - then.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24 * 30.44));
}

export function cvssToSeverity(score: number): string {
  if (score >= 9.0) return "CRITICAL";
  if (score >= 7.0) return "HIGH";
  if (score >= 4.0) return "MEDIUM";
  if (score > 0.0) return "LOW";
  return "UNKNOWN";
}

const CVSS_V3_AV: Record<string, number> = {
  N: 0.85,
  A: 0.62,
  L: 0.55,
  P: 0.20,
};
const CVSS_V3_AC: Record<string, number> = { L: 0.77, H: 0.44 };
const CVSS_V3_PR_U: Record<string, number> = { N: 0.85, L: 0.62, H: 0.27 };
const CVSS_V3_PR_C: Record<string, number> = { N: 0.85, L: 0.68, H: 0.50 };
const CVSS_V3_UI: Record<string, number> = { N: 0.85, R: 0.62 };
const CVSS_V3_CIA: Record<string, number> = { N: 0, L: 0.22, H: 0.56 };

export function parseCvssV3BaseScore(vector: string): number | null {
  if (!vector.startsWith("CVSS:3")) return null;
  const parts: Record<string, string> = {};
  for (const seg of vector.split("/")) {
    const [k, v] = seg.split(":");
    if (k && v) parts[k] = v;
  }
  const av = CVSS_V3_AV[parts.AV ?? ""];
  const ac = CVSS_V3_AC[parts.AC ?? ""];
  const scope = parts.S;
  const pr = scope === "C"
    ? CVSS_V3_PR_C[parts.PR ?? ""]
    : CVSS_V3_PR_U[parts.PR ?? ""];
  const ui = CVSS_V3_UI[parts.UI ?? ""];
  const c = CVSS_V3_CIA[parts.C ?? ""];
  const i = CVSS_V3_CIA[parts.I ?? ""];
  const a = CVSS_V3_CIA[parts.A ?? ""];
  if (
    av == null || ac == null || pr == null || ui == null ||
    c == null || i == null || a == null || !scope
  ) {
    return null;
  }
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  if (iss <= 0) return 0;
  const exploitability = 8.22 * av * ac * pr * ui;
  const impact = scope === "C"
    ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15)
    : 6.42 * iss;
  if (impact <= 0) return 0;
  const raw = scope === "C"
    ? 1.08 * (impact + exploitability)
    : impact + exploitability;
  return Math.min(Math.ceil(raw * 10) / 10, 10);
}

function extractSeverity(vuln: Record<string, unknown>): string {
  const dbSpecific = vuln.database_specific as
    | Record<string, unknown>
    | undefined;
  if (dbSpecific && typeof dbSpecific.severity === "string") {
    const upper = dbSpecific.severity.toUpperCase();
    if (upper === "MODERATE") return "MEDIUM";
    return upper;
  }
  const sevArr = vuln.severity;
  if (Array.isArray(sevArr) && sevArr.length > 0) {
    let highest: string = "UNKNOWN";
    for (const entry of sevArr) {
      const obj = entry as Record<string, unknown>;
      let numeric: number | null = null;
      if (typeof obj.score === "number") {
        numeric = obj.score;
      } else if (typeof obj.score === "string") {
        numeric = parseCvssV3BaseScore(obj.score);
      }
      if (numeric !== null) {
        if (numeric >= 9.0) return "CRITICAL";
        if (numeric >= 7.0) {
          highest = "HIGH";
        } else if (numeric >= 4.0 && highest !== "HIGH") {
          highest = "MEDIUM";
        } else if (numeric < 4.0 && highest === "UNKNOWN") {
          highest = "LOW";
        }
      }
    }
    return highest;
  }
  return "UNKNOWN";
}

function normaliseVulns(body: unknown): OsvVuln[] {
  if (!body || typeof body !== "object") return [];
  const vulns = (body as Record<string, unknown>).vulns;
  if (!Array.isArray(vulns)) return [];
  return vulns.map((v) => {
    const obj = v as Record<string, unknown>;
    return {
      id: String(obj.id ?? "OSV-UNKNOWN"),
      severity: extractSeverity(obj),
    };
  });
}

export function parseSpdxLicense(
  license: string | null | undefined,
): string[] {
  if (!license) return [];
  return license
    .replace(/[()]/g, " ")
    .split(/\s+(?:AND|OR|WITH)\s+/i)
    .map((term) => term.trim())
    .filter(Boolean);
}

export function licenseAllowed(license: string | null | undefined): boolean {
  const terms = parseSpdxLicense(license);
  if (terms.length === 0) return false;
  return terms.every((term) => LICENSE_ALLOWLIST.has(term));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function describeFailure(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) return "interrupted";
  if (error instanceof DOMException && error.name === "AbortError") {
    return `no response within ${FETCH_TIMEOUT_MS / 1000}s`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function queryOsvVulns(
  name: string,
  version: string,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<Lookup<OsvVuln[]>> {
  try {
    const resp = await fetchWithTimeout(
      OSV_QUERY_URL,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          package: { name, ecosystem: "npm" },
          version,
        }),
      },
      fetcher,
      signal,
    );
    if (!resp.ok) {
      await resp.body?.cancel();
      return { kind: "unavailable", reason: `HTTP ${resp.status}` };
    }
    return { kind: "found", value: normaliseVulns(await resp.json()) };
  } catch (error) {
    return { kind: "unavailable", reason: describeFailure(error, signal) };
  }
}

async function fetchNpmFacts(
  name: string,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<Lookup<NpmPackument>> {
  // The download count is a soft signal: its failure leaves it null and
  // never makes the package metadata lookup, or the audit, fail.
  const [pkgSettled, downloadsSettled] = await Promise.allSettled([
    fetchWithTimeout(`${NPM_REGISTRY_URL}/${name}`, {}, fetcher, signal),
    fetchWithTimeout(`${NPM_DOWNLOADS_URL}/${name}`, {}, fetcher, signal),
  ]);
  const downloadsResp = downloadsSettled.status === "fulfilled"
    ? downloadsSettled.value
    : null;
  if (pkgSettled.status === "rejected") {
    await downloadsResp?.body?.cancel();
    return {
      kind: "unavailable",
      reason: describeFailure(pkgSettled.reason, signal),
    };
  }
  const pkgResp = pkgSettled.value;

  let weeklyDownloads: number | null = null;
  if (downloadsResp?.ok) {
    try {
      const dlBody = await downloadsResp.json() as Record<string, unknown>;
      if (typeof dlBody.downloads === "number") {
        weeklyDownloads = dlBody.downloads;
      }
    } catch {
      // An unreadable count is as good as none.
    }
  } else {
    await downloadsResp?.body?.cancel();
  }

  try {
    if (!pkgResp.ok) {
      await pkgResp.body?.cancel();
      return { kind: "unavailable", reason: `HTTP ${pkgResp.status}` };
    }
    const pkgBody = await pkgResp.json() as Record<string, unknown>;

    const distTags: Record<string, string> = {};
    const rawTags = pkgBody["dist-tags"];
    if (rawTags && typeof rawTags === "object") {
      for (const [tag, value] of Object.entries(rawTags)) {
        if (typeof value === "string") distTags[tag] = value;
      }
    }
    const latestVersion = distTags.latest ??
      String(pkgBody.version ?? "unknown");
    const manifests: Record<string, Record<string, unknown>> = {};
    if (pkgBody.versions && typeof pkgBody.versions === "object") {
      for (
        const [version, manifest] of Object.entries(
          pkgBody.versions as Record<string, unknown>,
        )
      ) {
        if (manifest && typeof manifest === "object") {
          manifests[version] = manifest as Record<string, unknown>;
        }
      }
    }

    const time = pkgBody.time as Record<string, string> | undefined;
    const lastPublish = time?.[latestVersion] ?? time?.modified ?? null;

    return {
      kind: "found",
      value: {
        latestVersion,
        publishedVersions: Object.keys(manifests),
        distTags,
        manifests,
        packageLevel: pkgBody,
        weeklyDownloads,
        lastPublish,
      },
    };
  } catch (error) {
    return { kind: "unavailable", reason: describeFailure(error, signal) };
  }
}

function licenseOf(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (
    raw && typeof raw === "object" &&
    typeof (raw as Record<string, unknown>).type === "string"
  ) {
    return (raw as Record<string, unknown>).type as string;
  }
  return null;
}

/** npm marks a deprecated version with a non-empty notice. */
function deprecationOf(raw: unknown): string | null {
  if (typeof raw === "string") return raw.length > 0 ? raw : null;
  return raw === true ? "" : null;
}

/** A third-party notice made safe for one terminal line. */
function sanitiseNotice(notice: string): string {
  // Control characters, and the bidi and zero-width format characters that
  // could reorder or hide part of the line.
  const flat = notice.replace(
    // deno-lint-ignore no-control-regex
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g,
    " ",
  ).replace(/\s+/g, " ").trim();
  return flat.length > MAX_DEPRECATION_REASON
    ? `${flat.slice(0, MAX_DEPRECATION_REASON - 1)}…`
    : flat;
}

/**
 * The facts for the version that ships: license, maintainers and
 * deprecation from its own manifest. The age stays the package's latest
 * publish: it measures whether the package is maintained, not the pin.
 * The caller reports a version the packument does not list as not audited;
 * its facts then come from the package level only, never from latest.
 */
function factsFor(packument: NpmPackument, version: string): NpmPackageFacts {
  const pkg = packument.packageLevel;
  const latest = packument.manifests[packument.latestVersion];
  const shipped: Record<string, unknown> | undefined =
    packument.manifests[version];
  const latestNotice = deprecationOf(latest?.deprecated ?? pkg.deprecated);
  const notice = deprecationOf(shipped?.deprecated ?? pkg.deprecated);
  const maintainers = shipped?.maintainers ?? pkg.maintainers;
  const suggestion = notice === null ? null : suggestVersion(
    version,
    packument.publishedVersions,
    new Set(
      packument.publishedVersions.filter((v) =>
        deprecationOf(packument.manifests[v]?.deprecated ?? pkg.deprecated) !==
          null
      ),
    ),
  );
  return {
    version,
    license: licenseOf(shipped?.license ?? pkg.license),
    deprecated: notice !== null,
    latestDeprecated: latestNotice !== null,
    ...(notice ? { deprecationReason: sanitiseNotice(notice) } : {}),
    ...(notice !== null && suggestion !== null
      ? { suggestedVersion: suggestion }
      : {}),
    maintainerCount: Array.isArray(maintainers) ? maintainers.length : 0,
    weeklyDownloads: packument.weeklyDownloads,
    lastPublish: packument.lastPublish,
  };
}

async function fetchJsrMeta(
  name: string,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<Lookup<JsrPackageMeta> | { kind: "missing" }> {
  try {
    const resp = await fetchWithTimeout(
      `${JSR_REGISTRY_URL}/${name}/meta.json`,
      { headers: { accept: "application/json" } },
      fetcher,
      signal,
    );
    if (resp.status === 404) {
      await resp.body?.cancel();
      return { kind: "missing" };
    }
    if (!resp.ok) {
      await resp.body?.cancel();
      return { kind: "unavailable", reason: `HTTP ${resp.status}` };
    }
    const contentType = resp.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      await resp.body?.cancel();
      return { kind: "unavailable", reason: "response was not JSON" };
    }
    const body = await resp.json() as Record<string, unknown>;
    const rawVersions = body.versions;
    if (!rawVersions || typeof rawVersions !== "object") {
      return { kind: "unavailable", reason: "metadata lists no versions" };
    }
    const versions: string[] = [];
    const yanked = new Set<string>();
    for (const [version, entry] of Object.entries(rawVersions)) {
      versions.push(version);
      if (
        entry && typeof entry === "object" &&
        (entry as Record<string, unknown>).yanked === true
      ) {
        yanked.add(version);
      }
    }
    return {
      kind: "found",
      value: {
        latest: typeof body.latest === "string" ? body.latest : null,
        versions,
        yanked,
      },
    };
  } catch (error) {
    return { kind: "unavailable", reason: describeFailure(error, signal) };
  }
}

/**
 * HIGH, CRITICAL and UNKNOWN vulnerabilities are errors; MEDIUM ones are
 * warnings. Shared by a full audit and one whose npm lookup failed.
 */
function evaluateVulns(
  name: string,
  vulns: OsvVuln[],
): { errors: DependencyTrustIssue[]; warnings: DependencyTrustIssue[] } {
  const errors: DependencyTrustIssue[] = [];
  const warnings: DependencyTrustIssue[] = [];
  for (const v of vulns) {
    const sev = v.severity.toUpperCase();
    if (sev === "HIGH" || sev === "CRITICAL" || sev === "UNKNOWN") {
      errors.push({
        dependency: name,
        message: `vulnerability ${v.id} (${sev})`,
      });
    } else if (sev === "MEDIUM") {
      warnings.push({
        dependency: name,
        message: `vulnerability ${v.id} (${sev})`,
      });
    }
  }
  return { errors, warnings };
}

export function evaluateNpmTrustGates(
  name: string,
  facts: NpmPackageFacts,
  vulns: OsvVuln[],
  thresholds: TrustThresholds = DEFAULT_TRUST_THRESHOLDS,
  now: Date = new Date(),
): { errors: DependencyTrustIssue[]; warnings: DependencyTrustIssue[] } {
  const { errors, warnings } = evaluateVulns(name, vulns);

  if (facts.deprecated && facts.latestDeprecated !== false) {
    errors.unshift({ dependency: name, message: "package is deprecated" });
  } else if (facts.deprecated) {
    warnings.push({
      dependency: name,
      message: `version ${facts.version} is deprecated${
        facts.deprecationReason ? `: ${facts.deprecationReason}` : ""
      }`,
      cause: "deprecated-version",
      ...(facts.suggestedVersion
        ? { suggestedVersion: facts.suggestedVersion }
        : {}),
      remediation: facts.suggestedVersion
        ? `Move to ${facts.suggestedVersion}, the newest version that isn't deprecated.`
        : "Move to a non-deprecated version of the package.",
    });
  }

  if (!licenseAllowed(facts.license)) {
    warnings.push({
      dependency: name,
      message: `license "${facts.license ?? "unknown"}" not in allowlist`,
    });
  }

  if (facts.maintainerCount === 0) {
    warnings.push({ dependency: name, message: "no maintainers listed" });
  }

  if (
    facts.weeklyDownloads !== null &&
    facts.weeklyDownloads < thresholds.minWeeklyDownloads
  ) {
    warnings.push({
      dependency: name,
      message:
        `low weekly downloads (${facts.weeklyDownloads} < ${thresholds.minWeeklyDownloads})`,
    });
  }

  if (facts.lastPublish) {
    const ageMonths = monthsSince(facts.lastPublish, now);
    if (ageMonths > thresholds.maxAgeMonths) {
      warnings.push({
        dependency: name,
        message:
          `last published ${ageMonths} months ago (threshold: ${thresholds.maxAgeMonths})`,
      });
    }
  }

  return { errors, warnings };
}

function formatAge(lastPublish: string | null): string | null {
  if (!lastPublish) return null;
  const months = monthsSince(lastPublish);
  if (months <= 0) return "this month";
  if (months === 1) return "1mo ago";
  return `${months}mo ago`;
}

/** The specifier as the source writes it, without any subpath. */
function specifierText(spec: DependencySpecifier): string {
  return `${spec.registry}:${spec.name}${
    spec.version !== null ? `@${spec.version}` : ""
  }`;
}

/** What to add to a fix when the lockfile, not the source, chose the version. */
function lockRefreshNote(
  shipped: ShippedVersion,
  lock: LockedDependencyVersions | undefined,
): string {
  return shipped.from === "lockfile" && lock
    ? ` Then refresh ${lock.source} so it records the new version.`
    : "";
}

/**
 * An unpinned, range or dist-tag specifier's finding, naming the version
 * this push resolves; null for an exact pin.
 */
function looseSpecifierFinding(
  spec: DependencySpecifier,
  shipped: ShippedVersion,
  lock: LockedDependencyVersions | undefined,
): DependencyTrustIssue | null {
  const kind = specifierKind(spec.version);
  if (kind === "exact") return null;
  const phrase = kind === "unpinned"
    ? "unpinned"
    : kind === "range"
    ? "a range"
    : "a dist-tag";
  const from = shipped.from === "lockfile" && lock
    ? ` (from ${lock.source})`
    : "";
  return {
    dependency: spec.name,
    message: `${
      specifierText(spec)
    } is ${phrase}; audited ${shipped.version}, the version this push resolves${from}`,
    cause: "loose-specifier",
    remediation:
      `Pin the exact version this push resolved (${shipped.version}) to ensure that the audited version is the one that ships.`,
  };
}

/**
 * Names the bare imports a finding came from, so the pusher can find the
 * line the import map resolved.
 */
function importedAsSuffix(names: readonly string[]): string {
  return ` (imported as ${
    names.map((n) => `"${n}"`).join(", ")
  } via deno.json)`;
}

/** A specifier's audit, its findings naming the bare import it came from. */
function attributeToImport(
  spec: DependencySpecifier,
  audit: SpecifierAudit,
): SpecifierAudit {
  if (spec.importedAs === undefined) return audit;
  const suffix = importedAsSuffix([spec.importedAs]);
  const attribute = (issue: DependencyTrustIssue): DependencyTrustIssue => ({
    ...issue,
    message: issue.message + suffix,
  });
  return {
    errors: audit.errors.map(attribute),
    warnings: audit.warnings.map(attribute),
    summary: { ...audit.summary, importedAs: spec.importedAs },
  };
}

/** One specifier's findings and summary. */
interface SpecifierAudit {
  errors: DependencyTrustIssue[];
  warnings: DependencyTrustIssue[];
  summary: DependencyAuditSummary;
}

/**
 * How to resolve a dependency that was not audited, by why it was not: a
 * lookup outage clears on a re-run, a wrong name or specifier never does.
 */
const NOT_AUDITED_FIX = {
  outage: "Re-run when OSV, npm and JSR are reachable.",
  name: "Correct the package name in the import.",
  specifier: "Change the specifier to a version the registry publishes.",
  unexpected: "Re-run; if it fails again, report it.",
  other: "Resolve the reason above, then re-run.",
} as const;

function notAudited(
  spec: DependencySpecifier,
  reason: string,
  summary: Omit<DependencyAuditSummary, "passed" | "cause" | "reason">,
  fix: keyof typeof NOT_AUDITED_FIX = "other",
  errors: DependencyTrustIssue[] = [],
  warnings: DependencyTrustIssue[] = [],
): SpecifierAudit {
  return {
    errors,
    warnings: [...warnings, {
      dependency: spec.name,
      message: `not audited: ${reason}`,
      cause: "not-audited",
      remediation: NOT_AUDITED_FIX[fix],
    }],
    summary: { ...summary, passed: false, cause: "not-audited", reason },
  };
}

/**
 * Audits every specifier of one npm package from a single packument
 * lookup, querying OSV once per version that ships.
 */
async function auditNpmPackage(
  name: string,
  specs: DependencySpecifier[],
  lock: LockedDependencyVersions | undefined,
  fetcher: Fetcher,
  thresholds: TrustThresholds,
  signal?: AbortSignal,
): Promise<SpecifierAudit[]> {
  if (!NPM_NAME_RE.test(name)) {
    return specs.map((spec) =>
      notAudited(spec, "invalid npm package name", {
        name,
        specifier: specifierText(spec),
        version: spec.version ?? "latest",
        registry: "npm",
        license: null,
        weeklyDownloads: null,
        publishedAgo: null,
      }, "name")
    );
  }

  const npm = await fetchNpmFacts(name, fetcher, signal);
  const published: PublishedPackage | null = npm.kind === "found"
    ? { versions: npm.value.publishedVersions, distTags: npm.value.distTags }
    : null;
  const osvByVersion = new Map<string, Promise<Lookup<OsvVuln[]>>>();

  const audits: SpecifierAudit[] = [];
  for (const spec of specs) {
    // Without npm metadata only an exact or locked version still lets OSV
    // answer.
    const shipped = resolveShippedVersion(
      "npm",
      name,
      spec.version,
      lock,
      published,
    );
    const version = shipped?.version ?? null;
    let osvLookup: Promise<Lookup<OsvVuln[]>> | null = null;
    if (version !== null) {
      osvLookup = osvByVersion.get(version) ?? null;
      if (osvLookup === null) {
        osvLookup = queryOsvVulns(name, version, fetcher, signal);
        osvByVersion.set(version, osvLookup);
      }
    }
    const osv = osvLookup === null ? null : await osvLookup;

    const failures: string[] = [];
    // A wrong specifier fails the same way on every re-run; a lookup that
    // failed may not.
    let wrongSpecifier = false;
    if (npm.kind === "unavailable") {
      failures.push(`npm registry lookup failed (${npm.reason})`);
    } else if (
      version !== null && !Object.hasOwn(npm.value.manifests, version)
    ) {
      failures.push(`npm lists no version ${version}`);
      wrongSpecifier = true;
    }
    if (osv === null) {
      failures.push(
        npm.kind === "found"
          ? `OSV not queried (no published version matches ${
            spec.version ?? "latest"
          })`
          : "OSV not queried (no resolvable version)",
      );
      if (npm.kind === "found") wrongSpecifier = true;
    } else if (osv.kind === "unavailable") {
      failures.push(`OSV lookup failed (${osv.reason})`);
    }
    const vulns = osv?.kind === "found" ? osv.value : [];

    const facts = npm.kind === "found"
      ? factsFor(npm.value, version ?? npm.value.latestVersion)
      : null;
    const { errors, warnings } = facts
      ? evaluateNpmTrustGates(name, facts, vulns, thresholds)
      : evaluateVulns(name, vulns);
    if (shipped) {
      const note = lockRefreshNote(shipped, lock);
      for (const w of warnings) {
        if (w.cause === "deprecated-version" && w.remediation) {
          w.remediation += note;
        }
      }
      const loose = looseSpecifierFinding(spec, shipped, lock);
      if (loose) warnings.push(loose);
    }

    const summary = {
      name,
      specifier: specifierText(spec),
      version: version ?? spec.version ?? "latest",
      ...(shipped ? { resolvedFrom: shipped.from } : {}),
      registry: "npm" as const,
      license: facts?.license ?? null,
      weeklyDownloads: facts?.weeklyDownloads ?? null,
      publishedAgo: formatAge(facts?.lastPublish ?? null),
    };
    audits.push(
      failures.length > 0
        ? notAudited(
          spec,
          failures.join("; "),
          summary,
          wrongSpecifier ? "specifier" : "outage",
          errors,
          warnings,
        )
        : {
          errors,
          warnings,
          summary: { ...summary, passed: errors.length === 0 },
        },
    );
  }
  return audits;
}

/**
 * Audits every specifier of one JSR package from a single `meta.json`
 * lookup: the package and the version that ships must exist, and a yanked
 * version warns. OSV has no JSR data, so there is no vulnerability check.
 */
async function auditJsrPackage(
  name: string,
  specs: DependencySpecifier[],
  lock: LockedDependencyVersions | undefined,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<SpecifierAudit[]> {
  const meta = JSR_NAME_RE.test(name)
    ? await fetchJsrMeta(name, fetcher, signal)
    : null;

  return specs.map((spec): SpecifierAudit => {
    const base = {
      name,
      specifier: specifierText(spec),
      version: spec.version ?? "latest",
      registry: "jsr" as const,
      license: null,
      weeklyDownloads: null,
      publishedAgo: null,
    };
    const missing = (message: string): SpecifierAudit => ({
      errors: [{ dependency: name, message, cause: "jsr-missing" }],
      warnings: [],
      summary: { ...base, passed: false },
    });

    if (meta === null) return missing("invalid JSR package name");
    if (meta.kind === "missing") return missing("JSR package not found");
    if (meta.kind === "unavailable") {
      return notAudited(
        spec,
        `JSR lookup failed (${meta.reason})`,
        base,
        "outage",
      );
    }

    const shipped = resolveShippedVersion("jsr", name, spec.version, lock, {
      versions: meta.value.versions,
      distTags: meta.value.latest ? { latest: meta.value.latest } : {},
      yanked: meta.value.yanked,
    });
    if (!shipped || !meta.value.versions.includes(shipped.version)) {
      return missing(
        `version ${
          shipped?.version ?? spec.version ?? "latest"
        } not found on JSR`,
      );
    }

    const warnings: DependencyTrustIssue[] = [];
    if (meta.value.yanked.has(shipped.version)) {
      const suggested = suggestVersion(
        shipped.version,
        meta.value.versions,
        meta.value.yanked,
      );
      warnings.push({
        dependency: name,
        message:
          `version ${shipped.version} was withdrawn (yanked) by its author on JSR. ${
            suggested
              ? `Newest version that isn't yanked: ${suggested}.`
              : "No other version is available."
          }`,
        cause: "jsr-yanked",
        ...(suggested ? { suggestedVersion: suggested } : {}),
        remediation: (suggested
          ? `Pin jsr:${name}@${suggested} (or the newest non-yanked version your code supports).`
          : "Wait for the author to publish a replacement, or replace the dependency.") +
          lockRefreshNote(shipped, lock),
      });
    }
    const loose = looseSpecifierFinding(spec, shipped, lock);
    if (loose) warnings.push(loose);
    return {
      errors: [],
      warnings,
      summary: {
        ...base,
        version: shipped.version,
        resolvedFrom: shipped.from,
        passed: true,
      },
    };
  });
}

/**
 * Audits each dependency at the version push ships: an exact pin, else the
 * version `lock` records, else what the registry resolves today. Each
 * package is looked up once, however many specifiers name it.
 */
export async function checkDependencyTrust(
  specifiers: DependencySpecifier[],
  fetcher: Fetcher = fetch,
  thresholds: TrustThresholds = DEFAULT_TRUST_THRESHOLDS,
  signal?: AbortSignal,
  lock?: LockedDependencyVersions,
): Promise<DependencyTrustResult> {
  const allErrors: DependencyTrustIssue[] = [];
  const allWarnings: DependencyTrustIssue[] = [];
  const audited: DependencyAuditSummary[] = [];

  const packages = new Map<string, DependencySpecifier[]>();
  for (const spec of specifiers) {
    const key = `${spec.registry}:${spec.name}`;
    const group = packages.get(key);
    if (group) group.push(spec);
    else packages.set(key, [spec]);
  }
  const groups = [...packages.values()];

  const CONCURRENCY = 5;
  for (let i = 0; i < groups.length; i += CONCURRENCY) {
    const batch = groups.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(([first, ...rest]) =>
        first.registry === "jsr"
          ? auditJsrPackage(first.name, [first, ...rest], lock, fetcher, signal)
          : auditNpmPackage(
            first.name,
            [first, ...rest],
            lock,
            fetcher,
            thresholds,
            signal,
          )
      ),
    );

    for (const [index, result] of results.entries()) {
      const specs = batch[index];
      if (result.status === "rejected") {
        // Named by its bare imports only when no specifier writes it out.
        const bare = specs.every((spec) => spec.importedAs !== undefined)
          ? [...new Set(specs.flatMap((spec) => spec.importedAs ?? []))]
          : [];
        allWarnings.push({
          dependency: specs[0].name,
          message: `not audited: audit check failed (${
            describeFailure(result.reason)
          })${bare.length > 0 ? importedAsSuffix(bare) : ""}`,
          cause: "not-audited",
          remediation: NOT_AUDITED_FIX.unexpected,
        });
        continue;
      }
      for (const [i, raw] of result.value.entries()) {
        const audit = attributeToImport(specs[i], raw);
        for (const error of audit.errors) allErrors.push(error);
        for (const warning of audit.warnings) allWarnings.push(warning);
        audited.push(audit.summary);
      }
    }
  }

  return {
    errors: allErrors,
    warnings: allWarnings,
    audited,
    passed: allErrors.length === 0,
  };
}

/**
 * The findings that cost both points of the rubric's dependency-trust factor
 * besides an unaudited dependency: every error, a deprecated shipped version
 * and a yanked JSR version. Push only warns about the last two (`--yes`
 * accepts them) but the rubric scores against them, as the registry's
 * scorecard does.
 */
export function dependencyTrustBlockerCount(
  result: DependencyTrustResult,
): number {
  return result.errors.length +
    result.warnings.filter((w) =>
      w.cause === "deprecated-version" || w.cause === "jsr-yanked"
    ).length;
}

/** How many dependencies have a loose specifier; each costs one point. */
export function looseSpecifierCount(result: DependencyTrustResult): number {
  return new Set(
    result.warnings
      .filter((w) => w.cause === "loose-specifier")
      .map((w) => w.dependency),
  ).size;
}

/** How many dependencies a lookup failure left unaudited. */
export function notAuditedCount(result: DependencyTrustResult): number {
  return new Set(
    result.warnings
      .filter((w) => w.cause === "not-audited")
      .map((w) => w.dependency),
  ).size;
}
