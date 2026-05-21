// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

export interface DependencyTrustResult {
  errors: DependencyTrustIssue[];
  warnings: DependencyTrustIssue[];
  passed: boolean;
}

export interface TrustThresholds {
  minWeeklyDownloads: number;
  maxAgeMonths: number;
  minMaintenance: number;
}

export const DEFAULT_TRUST_THRESHOLDS: TrustThresholds = {
  minWeeklyDownloads: 1000,
  maxAgeMonths: 24,
  minMaintenance: 0.4,
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

function extractSeverity(vuln: Record<string, unknown>): string {
  const dbSpecific = vuln.database_specific as
    | Record<string, unknown>
    | undefined;
  if (dbSpecific && typeof dbSpecific.severity === "string") {
    return String(dbSpecific.severity).toUpperCase();
  }
  const sevArr = vuln.severity;
  if (Array.isArray(sevArr) && sevArr.length > 0) {
    const first = sevArr[0] as Record<string, unknown>;
    const score = Number(first.score);
    if (Number.isFinite(score)) return cvssToSeverity(score);
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
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
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
): Promise<OsvVuln[]> {
  try {
    const resp = await fetchWithTimeout(OSV_QUERY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        package: { name, ecosystem: "npm" },
        version,
      }),
    }, fetcher);
    if (!resp.ok) return [];
    return normaliseVulns(await resp.json());
  } catch {
    return [];
  }
}

async function fetchNpmFacts(
  name: string,
  fetcher: Fetcher,
): Promise<NpmPackageFacts | null> {
  try {
    const [manifestResp, downloadsResp] = await Promise.all([
      fetchWithTimeout(`${NPM_REGISTRY_URL}/${name}/latest`, {}, fetcher),
      fetchWithTimeout(`${NPM_DOWNLOADS_URL}/${name}`, {}, fetcher),
    ]);

    if (!manifestResp.ok) return null;
    const manifest = await manifestResp.json() as Record<string, unknown>;

    let weeklyDownloads: number | null = null;
    if (downloadsResp.ok) {
      const dlBody = await downloadsResp.json() as Record<string, unknown>;
      if (typeof dlBody.downloads === "number") {
        weeklyDownloads = dlBody.downloads;
      }
    } else {
      await downloadsResp.body?.cancel();
    }

    const version = String(manifest.version ?? "unknown");
    const rawLicense = manifest.license;
    const license = typeof rawLicense === "string"
      ? rawLicense
      : (rawLicense && typeof rawLicense === "object" &&
          typeof (rawLicense as Record<string, unknown>).type === "string")
      ? (rawLicense as Record<string, unknown>).type as string
      : null;

    const deprecated = !!manifest.deprecated;
    const maintainers = manifest.maintainers;
    const maintainerCount = Array.isArray(maintainers) ? maintainers.length : 0;

    let lastPublish: string | null = null;
    try {
      const pkgResp = await fetchWithTimeout(
        `${NPM_REGISTRY_URL}/${name}`,
        {},
        fetcher,
      );
      if (pkgResp.ok) {
        const pkgBody = await pkgResp.json() as Record<string, unknown>;
        const time = pkgBody.time as Record<string, string> | undefined;
        if (time) {
          lastPublish = time[version] ?? time.modified ?? null;
        }
      } else {
        await pkgResp.body?.cancel();
      }
    } catch {
      // publish date is best-effort
    }

    return {
      version,
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

export async function checkDependencyTrust(
  specifiers: DependencySpecifier[],
  fetcher: Fetcher = fetch,
  thresholds: TrustThresholds = DEFAULT_TRUST_THRESHOLDS,
): Promise<DependencyTrustResult> {
  const allErrors: DependencyTrustIssue[] = [];
  const allWarnings: DependencyTrustIssue[] = [];

  const npmSpecs = specifiers.filter((s) => s.registry === "npm");

  // jsr packages trust jsr's built-in enforcement (SPDX license,
  // provenance, no install scripts) — skip gates where data is unavailable

  const CONCURRENCY = 5;
  for (let i = 0; i < npmSpecs.length; i += CONCURRENCY) {
    const batch = npmSpecs.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (spec) => {
        const facts = await fetchNpmFacts(spec.name, fetcher);
        if (!facts) {
          allWarnings.push({
            dependency: spec.name,
            message: "could not fetch package metadata (API unreachable)",
          });
          return;
        }

        const version = spec.version ?? facts.version;
        const vulns = await queryOsvVulns(spec.name, version, fetcher);
        const { errors, warnings } = evaluateNpmTrustGates(
          spec.name,
          facts,
          vulns,
          thresholds,
        );
        allErrors.push(...errors);
        allWarnings.push(...warnings);
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
    passed: allErrors.length === 0,
  };
}
