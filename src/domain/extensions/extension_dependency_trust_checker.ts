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
  DEFAULT_TRUST_THRESHOLDS,
  type DependencySpecifier,
  type DependencyTrustResult,
  evaluateJsrPackage,
  evaluateNpmPackage,
  failedPackageAudits,
  groupForAudit,
  type JsrLookup,
  jsrNameValid,
  type LockedDependencyVersions,
  type Lookup,
  MalformedOsvResponseError,
  type NpmLookup,
  npmNameValid,
  type OsvVulnerability,
  overLimitAudits,
  parseJsrMeta,
  parseNpmPackument,
  parseOsvResponse,
  planNpmPackage,
  pushResult,
  type SpecifierAudit,
  type TrustThresholds,
} from "@swamp-club/extension-scoring/dependency-audit";

/**
 * The dependency trust audit's lookups: npm's packument and download
 * count, OSV's advisories and JSR's `meta.json`. Every decision about what
 * they say is the shared `@swamp-club/extension-scoring` evaluator's, the
 * same one the registry's scorecard runs (swamp-club#3781).
 */

const OSV_QUERY_URL = "https://api.osv.dev/v1/query";
const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const NPM_DOWNLOADS_URL = "https://api.npmjs.org/downloads/point/last-week";
const JSR_REGISTRY_URL = "https://jsr.io";
const FETCH_TIMEOUT_MS = 15_000;

export type Fetcher = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;

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
): Promise<Lookup<OsvVulnerability[]>> {
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
    return { kind: "found", value: parseOsvResponse(await resp.json()) };
  } catch (error) {
    if (error instanceof MalformedOsvResponseError) {
      return { kind: "unavailable", reason: error.message };
    }
    return { kind: "unavailable", reason: describeFailure(error, signal) };
  }
}

async function fetchNpmPackument(
  name: string,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<NpmLookup> {
  if (!npmNameValid(name)) return { kind: "invalid-name" };
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

  let downloadsBody: unknown = null;
  if (downloadsResp?.ok) {
    try {
      downloadsBody = await downloadsResp.json();
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
    return {
      kind: "found",
      value: parseNpmPackument(await pkgResp.json(), downloadsBody),
    };
  } catch (error) {
    return { kind: "unavailable", reason: describeFailure(error, signal) };
  }
}

async function fetchJsrMeta(
  name: string,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<JsrLookup> {
  if (!jsrNameValid(name)) return { kind: "invalid-name" };
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
    return parseJsrMeta(await resp.json());
  } catch (error) {
    return { kind: "unavailable", reason: describeFailure(error, signal) };
  }
}

/** Looks up one npm package and the OSV advisories for each version it ships. */
async function auditNpmPackage(
  name: string,
  specs: DependencySpecifier[],
  lock: LockedDependencyVersions | undefined,
  fetcher: Fetcher,
  thresholds: TrustThresholds,
  now: Date,
  signal?: AbortSignal,
): Promise<SpecifierAudit[]> {
  const npm = await fetchNpmPackument(name, fetcher, signal);
  const plan = planNpmPackage(name, specs, npm, lock);
  const osv = new Map<string, Lookup<OsvVulnerability[]>>();
  for (const version of plan.osvVersions) {
    osv.set(version, await queryOsvVulns(name, version, fetcher, signal));
  }
  return evaluateNpmPackage(name, specs, npm, plan, osv, now, lock, thresholds);
}

/**
 * Audits each dependency at the version push ships: an exact pin, else the
 * version `lock` records, else what the registry resolves today. Each
 * package is looked up once, however many specifiers name it, and at most
 * the shared dependency limit are looked up at all.
 */
export async function checkDependencyTrust(
  specifiers: DependencySpecifier[],
  fetcher: Fetcher = fetch,
  thresholds: TrustThresholds = DEFAULT_TRUST_THRESHOLDS,
  signal?: AbortSignal,
  lock?: LockedDependencyVersions,
  now: Date = new Date(),
): Promise<DependencyTrustResult> {
  const { groups, overLimit } = groupForAudit(specifiers);
  const audits: { spec: DependencySpecifier; audit: SpecifierAudit }[] = [];

  const CONCURRENCY = 5;
  for (let i = 0; i < groups.length; i += CONCURRENCY) {
    const batch = groups.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (specs) => {
        const name = specs[0].name;
        return specs[0].registry === "jsr"
          ? evaluateJsrPackage(
            name,
            specs,
            await fetchJsrMeta(name, fetcher, signal),
            lock,
          )
          : await auditNpmPackage(
            name,
            specs,
            lock,
            fetcher,
            thresholds,
            now,
            signal,
          );
      }),
    );
    for (const [index, result] of results.entries()) {
      const specs = batch[index];
      const specAudits = result.status === "fulfilled"
        ? result.value
        : failedPackageAudits(specs, describeFailure(result.reason));
      for (const [j, audit] of specAudits.entries()) {
        audits.push({ spec: specs[j], audit });
      }
    }
  }
  for (const [j, audit] of overLimitAudits(overLimit).entries()) {
    audits.push({ spec: overLimit[j], audit });
  }
  return pushResult(audits);
}
