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

export interface DependencyTrustIssue {
  dependency: string;
  message: string;
}

export interface DependencyAuditSummary {
  name: string;
  version: string;
  registry: "npm" | "jsr";
  license: string | null;
  weeklyDownloads: number | null;
  publishedAgo: string | null;
  passed: boolean;
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
const FETCH_TIMEOUT_MS = 15_000;

interface OsvVuln {
  id: string;
  severity: string;
}

interface NpmPackageFacts {
  version: string;
  license: string | null;
  deprecated: boolean;
  maintainerCount: number;
  weeklyDownloads: number | null;
  lastPublish: string | null;
}

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

async function queryOsvVulns(
  name: string,
  version: string,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<OsvVuln[]> {
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
      return [];
    }
    return normaliseVulns(await resp.json());
  } catch {
    return [];
  }
}

async function fetchNpmFacts(
  name: string,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<NpmPackageFacts | null> {
  try {
    const [pkgResp, downloadsResp] = await Promise.all([
      fetchWithTimeout(`${NPM_REGISTRY_URL}/${name}`, {}, fetcher, signal),
      fetchWithTimeout(`${NPM_DOWNLOADS_URL}/${name}`, {}, fetcher, signal),
    ]);

    if (!pkgResp.ok) {
      await pkgResp.body?.cancel();
      await downloadsResp.body?.cancel();
      return null;
    }
    const pkgBody = await pkgResp.json() as Record<string, unknown>;

    let weeklyDownloads: number | null = null;
    if (downloadsResp.ok) {
      const dlBody = await downloadsResp.json() as Record<string, unknown>;
      if (typeof dlBody.downloads === "number") {
        weeklyDownloads = dlBody.downloads;
      }
    } else {
      await downloadsResp.body?.cancel();
    }

    const distTags = pkgBody["dist-tags"] as Record<string, string> | undefined;
    const latestVersion = distTags?.latest ??
      String(pkgBody.version ?? "unknown");
    const versions = pkgBody.versions as
      | Record<string, Record<string, unknown>>
      | undefined;
    const latestManifest = versions?.[latestVersion];

    const rawLicense = latestManifest?.license ?? pkgBody.license;
    const license = typeof rawLicense === "string"
      ? rawLicense
      : (rawLicense && typeof rawLicense === "object" &&
          typeof (rawLicense as Record<string, unknown>).type === "string")
      ? (rawLicense as Record<string, unknown>).type as string
      : null;

    const deprecated = !!(latestManifest?.deprecated ?? pkgBody.deprecated);
    const maintainers = latestManifest?.maintainers ?? pkgBody.maintainers;
    const maintainerCount = Array.isArray(maintainers) ? maintainers.length : 0;

    const time = pkgBody.time as Record<string, string> | undefined;
    const lastPublish = time?.[latestVersion] ?? time?.modified ?? null;

    return {
      version: latestVersion,
      license,
      deprecated,
      maintainerCount,
      weeklyDownloads,
      lastPublish,
    };
  } catch {
    return null;
  }
}

export function evaluateNpmTrustGates(
  name: string,
  facts: NpmPackageFacts,
  vulns: OsvVuln[],
  thresholds: TrustThresholds = DEFAULT_TRUST_THRESHOLDS,
  now: Date = new Date(),
): { errors: DependencyTrustIssue[]; warnings: DependencyTrustIssue[] } {
  const errors: DependencyTrustIssue[] = [];
  const warnings: DependencyTrustIssue[] = [];

  if (facts.deprecated) {
    errors.push({ dependency: name, message: "package is deprecated" });
  }

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

export async function checkDependencyTrust(
  specifiers: DependencySpecifier[],
  fetcher: Fetcher = fetch,
  thresholds: TrustThresholds = DEFAULT_TRUST_THRESHOLDS,
  signal?: AbortSignal,
): Promise<DependencyTrustResult> {
  const allErrors: DependencyTrustIssue[] = [];
  const allWarnings: DependencyTrustIssue[] = [];
  const audited: DependencyAuditSummary[] = [];

  const npmSpecs = specifiers.filter((s) => s.registry === "npm");
  const jsrSpecs = specifiers.filter((s) => s.registry === "jsr");

  for (const spec of jsrSpecs) {
    audited.push({
      name: spec.name,
      version: spec.version ?? "latest",
      registry: "jsr",
      license: null,
      weeklyDownloads: null,
      publishedAgo: null,
      passed: true,
    });
  }

  const CONCURRENCY = 5;
  for (let i = 0; i < npmSpecs.length; i += CONCURRENCY) {
    const batch = npmSpecs.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (spec) => {
        const facts = await fetchNpmFacts(spec.name, fetcher, signal);
        if (!facts) {
          allWarnings.push({
            dependency: spec.name,
            message: "could not fetch package metadata (API unreachable)",
          });
          audited.push({
            name: spec.name,
            version: spec.version ?? "unknown",
            registry: "npm",
            license: null,
            weeklyDownloads: null,
            publishedAgo: null,
            passed: true,
          });
          return;
        }

        const version = spec.version ?? facts.version;
        const vulns = await queryOsvVulns(spec.name, version, fetcher, signal);
        const { errors, warnings } = evaluateNpmTrustGates(
          spec.name,
          facts,
          vulns,
          thresholds,
        );
        allErrors.push(...errors);
        allWarnings.push(...warnings);

        audited.push({
          name: spec.name,
          version,
          registry: "npm",
          license: facts.license,
          weeklyDownloads: facts.weeklyDownloads,
          publishedAgo: formatAge(facts.lastPublish),
          passed: errors.length === 0,
        });
      }),
    );

    for (const result of results) {
      if (result.status === "rejected") {
        allWarnings.push({
          dependency: "unknown",
          message: `audit check failed: ${String(result.reason)}`,
        });
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
