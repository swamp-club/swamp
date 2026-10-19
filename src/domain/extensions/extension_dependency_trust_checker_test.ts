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

import { assertEquals } from "@std/assert";
import type { DependencySpecifier } from "./extension_dependency_extractor.ts";
import {
  checkDependencyTrust,
  cvssToSeverity,
  DEFAULT_TRUST_THRESHOLDS,
  evaluateNpmTrustGates,
  type Fetcher,
  licenseAllowed,
  monthsSince,
  notAuditedCount,
  parseCvssV3BaseScore,
  parseSpdxLicense,
  resolveAuditVersion,
} from "./extension_dependency_trust_checker.ts";
import type { LockedDependencyVersions } from "./dependency_version_resolution.ts";

// ── Pure function tests ─────────────────────────────────────────────────

Deno.test("cvssToSeverity: maps scores correctly", () => {
  assertEquals(cvssToSeverity(9.5), "CRITICAL");
  assertEquals(cvssToSeverity(9.0), "CRITICAL");
  assertEquals(cvssToSeverity(7.5), "HIGH");
  assertEquals(cvssToSeverity(7.0), "HIGH");
  assertEquals(cvssToSeverity(5.0), "MEDIUM");
  assertEquals(cvssToSeverity(4.0), "MEDIUM");
  assertEquals(cvssToSeverity(2.0), "LOW");
  assertEquals(cvssToSeverity(0.0), "UNKNOWN");
});

Deno.test("monthsSince: computes months correctly", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  assertEquals(monthsSince("2026-06-01T00:00:00Z", now), 0);
  // 30 days is ~0.98 months → floors to 0
  assertEquals(monthsSince("2026-05-02T00:00:00Z", now), 0);
  // 60 days is ~1.97 months → floors to 1
  assertEquals(monthsSince("2026-04-02T00:00:00Z", now), 1);
  // Large gap: ~900 days
  assertEquals(monthsSince("2024-01-01T00:00:00Z", now) > 25, true);
});

Deno.test("parseCvssV3BaseScore: parses CRITICAL vector", () => {
  const score = parseCvssV3BaseScore(
    "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
  );
  assertEquals(score !== null && score >= 9.0, true);
});

Deno.test("parseCvssV3BaseScore: parses LOW vector", () => {
  const score = parseCvssV3BaseScore(
    "CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N",
  );
  assertEquals(score !== null && score < 4.0, true);
});

Deno.test("parseCvssV3BaseScore: returns null for non-CVSS string", () => {
  assertEquals(parseCvssV3BaseScore("not a vector"), null);
});

Deno.test("evaluateNpmTrustGates: MODERATE GHSA severity is a warning", () => {
  const { errors, warnings } = evaluateNpmTrustGates(
    "test-pkg",
    {
      version: "1.0.0",
      license: "MIT",
      deprecated: false,
      maintainerCount: 2,
      weeklyDownloads: 10000,
      lastPublish: "2026-01-01T00:00:00Z",
    },
    [{ id: "GHSA-mod1", severity: "MEDIUM" }],
  );
  assertEquals(errors.length, 0);
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].message, "vulnerability GHSA-mod1 (MEDIUM)");
});

Deno.test("parseSpdxLicense: splits compound expressions", () => {
  assertEquals(parseSpdxLicense("MIT"), ["MIT"]);
  assertEquals(parseSpdxLicense("MIT OR Apache-2.0"), ["MIT", "Apache-2.0"]);
  assertEquals(parseSpdxLicense("(MIT AND ISC)"), ["MIT", "ISC"]);
  assertEquals(parseSpdxLicense(null), []);
  assertEquals(parseSpdxLicense(""), []);
});

Deno.test("licenseAllowed: validates against allowlist", () => {
  assertEquals(licenseAllowed("MIT"), true);
  assertEquals(licenseAllowed("Apache-2.0"), true);
  assertEquals(licenseAllowed("GPL-3.0"), false);
  assertEquals(licenseAllowed("MIT OR Apache-2.0"), true);
  assertEquals(licenseAllowed("MIT AND GPL-3.0"), false);
  assertEquals(licenseAllowed(null), false);
});

// ── evaluateNpmTrustGates tests ─────────────────────────────────────────

Deno.test("evaluateNpmTrustGates: passes for healthy package", () => {
  const { errors, warnings } = evaluateNpmTrustGates(
    "axios",
    {
      version: "1.7.2",
      license: "MIT",
      deprecated: false,
      maintainerCount: 3,
      weeklyDownloads: 50_000_000,
      lastPublish: "2026-04-01T00:00:00Z",
    },
    [],
    DEFAULT_TRUST_THRESHOLDS,
    new Date("2026-06-01T00:00:00Z"),
  );
  assertEquals(errors.length, 0);
  assertEquals(warnings.length, 0);
});

Deno.test("evaluateNpmTrustGates: deprecated package is an error", () => {
  const { errors } = evaluateNpmTrustGates(
    "old-pkg",
    {
      version: "1.0.0",
      license: "MIT",
      deprecated: true,
      maintainerCount: 1,
      weeklyDownloads: 5000,
      lastPublish: "2025-01-01T00:00:00Z",
    },
    [],
  );
  assertEquals(errors.length, 1);
  assertEquals(errors[0].message, "package is deprecated");
});

Deno.test("evaluateNpmTrustGates: HIGH vuln is an error", () => {
  const { errors } = evaluateNpmTrustGates(
    "vuln-pkg",
    {
      version: "1.0.0",
      license: "MIT",
      deprecated: false,
      maintainerCount: 2,
      weeklyDownloads: 10000,
      lastPublish: "2026-01-01T00:00:00Z",
    },
    [{ id: "GHSA-1234", severity: "HIGH" }],
  );
  assertEquals(errors.length, 1);
  assertEquals(errors[0].message, "vulnerability GHSA-1234 (HIGH)");
});

Deno.test("evaluateNpmTrustGates: MEDIUM vuln is a warning", () => {
  const { errors, warnings } = evaluateNpmTrustGates(
    "vuln-pkg",
    {
      version: "1.0.0",
      license: "MIT",
      deprecated: false,
      maintainerCount: 2,
      weeklyDownloads: 10000,
      lastPublish: "2026-01-01T00:00:00Z",
    },
    [{ id: "GHSA-5678", severity: "MEDIUM" }],
  );
  assertEquals(errors.length, 0);
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].message, "vulnerability GHSA-5678 (MEDIUM)");
});

Deno.test("evaluateNpmTrustGates: low downloads is a warning", () => {
  const { warnings } = evaluateNpmTrustGates(
    "niche-pkg",
    {
      version: "1.0.0",
      license: "MIT",
      deprecated: false,
      maintainerCount: 1,
      weeklyDownloads: 50,
      lastPublish: "2026-05-01T00:00:00Z",
    },
    [],
  );
  const dlWarning = warnings.find((w) => w.message.includes("downloads"));
  assertEquals(dlWarning !== undefined, true);
});

Deno.test("evaluateNpmTrustGates: stale publish is a warning", () => {
  const { warnings } = evaluateNpmTrustGates(
    "stale-pkg",
    {
      version: "1.0.0",
      license: "MIT",
      deprecated: false,
      maintainerCount: 2,
      weeklyDownloads: 5000,
      lastPublish: "2023-01-01T00:00:00Z",
    },
    [],
    DEFAULT_TRUST_THRESHOLDS,
    new Date("2026-06-01T00:00:00Z"),
  );
  const staleWarning = warnings.find((w) => w.message.includes("months ago"));
  assertEquals(staleWarning !== undefined, true);
});

Deno.test("evaluateNpmTrustGates: bad license is a warning", () => {
  const { warnings } = evaluateNpmTrustGates(
    "gpl-pkg",
    {
      version: "1.0.0",
      license: "GPL-3.0",
      deprecated: false,
      maintainerCount: 2,
      weeklyDownloads: 5000,
      lastPublish: "2026-01-01T00:00:00Z",
    },
    [],
  );
  const licWarning = warnings.find((w) => w.message.includes("license"));
  assertEquals(licWarning !== undefined, true);
});

Deno.test("evaluateNpmTrustGates: no maintainers is a warning", () => {
  const { warnings } = evaluateNpmTrustGates(
    "orphan-pkg",
    {
      version: "1.0.0",
      license: "MIT",
      deprecated: false,
      maintainerCount: 0,
      weeklyDownloads: 5000,
      lastPublish: "2026-01-01T00:00:00Z",
    },
    [],
  );
  const maintWarning = warnings.find((w) =>
    w.message.includes("no maintainers")
  );
  assertEquals(maintWarning !== undefined, true);
});

// ── Integration tests with mocked fetcher ───────────────────────────────

function createMockFetcher(
  responses: Record<string, { status: number; body: unknown }>,
): Fetcher {
  return (url: string | URL, _init?: RequestInit) => {
    const urlStr = url.toString();
    for (const [pattern, resp] of Object.entries(responses)) {
      if (urlStr.includes(pattern)) {
        return Promise.resolve(
          new Response(JSON.stringify(resp.body), {
            status: resp.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  };
}

Deno.test("checkDependencyTrust: passes for healthy npm package", async () => {
  const specs: DependencySpecifier[] = [{
    name: "axios",
    version: "1.7.2",
    registry: "npm",
    sourceFile: "model.ts",
  }];

  const fetcher = createMockFetcher({
    "registry.npmjs.org/axios": {
      status: 200,
      body: {
        "dist-tags": { latest: "1.7.2" },
        versions: {
          "1.7.2": {
            version: "1.7.2",
            license: "MIT",
            maintainers: [{ name: "a" }, { name: "b" }],
          },
        },
        time: { "1.7.2": "2026-04-01T00:00:00Z" },
      },
    },
    "api.npmjs.org/downloads": {
      status: 200,
      body: { downloads: 50_000_000 },
    },
    "api.osv.dev": { status: 200, body: { vulns: [] } },
  });

  const result = await checkDependencyTrust(specs, fetcher);
  assertEquals(result.passed, true);
  assertEquals(result.errors.length, 0);
});

Deno.test("checkDependencyTrust: blocks on HIGH vulnerability", async () => {
  const specs: DependencySpecifier[] = [{
    name: "vulnerable-pkg",
    version: "1.0.0",
    registry: "npm",
    sourceFile: "model.ts",
  }];

  const fetcher = createMockFetcher({
    "registry.npmjs.org/vulnerable-pkg": {
      status: 200,
      body: {
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            version: "1.0.0",
            license: "MIT",
            maintainers: [{ name: "a" }],
          },
        },
        time: { "1.0.0": "2026-01-01T00:00:00Z" },
      },
    },
    "api.npmjs.org/downloads": {
      status: 200,
      body: { downloads: 10000 },
    },
    "api.osv.dev": {
      status: 200,
      body: {
        vulns: [{
          id: "GHSA-1234",
          database_specific: { severity: "HIGH" },
        }],
      },
    },
  });

  const result = await checkDependencyTrust(specs, fetcher);
  assertEquals(result.passed, false);
  assertEquals(result.errors.length, 1);
});

const HEALTHY_NPM_BODY = {
  "dist-tags": { latest: "1.0.0" },
  versions: {
    "1.0.0": {
      version: "1.0.0",
      license: "MIT",
      maintainers: [{ name: "a" }],
    },
  },
  time: { "1.0.0": new Date().toISOString() },
};

const OSV_URL = "api.osv.dev";
const NPM_URL = "registry.npmjs.org/";
const DOWNLOADS_URL = "api.npmjs.org/downloads";

/**
 * Answers each service from `routes` by URL substring; a route of "throw"
 * rejects like an unreachable host. Records every URL it was asked for.
 */
function routedFetcher(
  routes: Record<string, { status: number; body: unknown } | "throw">,
  calls: string[] = [],
): Fetcher {
  return (url: string | URL) => {
    const urlStr = url.toString();
    calls.push(urlStr);
    for (const [pattern, route] of Object.entries(routes)) {
      if (!urlStr.includes(pattern)) continue;
      if (route === "throw") {
        return Promise.reject(new TypeError("error sending request"));
      }
      return Promise.resolve(
        new Response(JSON.stringify(route.body), { status: route.status }),
      );
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  };
}

function npmSpec(name: string, version: string | null): DependencySpecifier {
  return { name, version, registry: "npm", sourceFile: "model.ts" };
}

Deno.test("checkDependencyTrust: an OSV error response leaves the dependency not audited", async () => {
  const result = await checkDependencyTrust(
    [npmSpec("some-pkg", "1.0.0")],
    routedFetcher({
      [OSV_URL]: { status: 503, body: {} },
      [NPM_URL]: { status: 200, body: HEALTHY_NPM_BODY },
      [DOWNLOADS_URL]: { status: 200, body: { downloads: 50_000 } },
    }),
  );

  assertEquals(result.errors, []);
  assertEquals(result.passed, true);
  assertEquals(result.warnings, [{
    dependency: "some-pkg",
    message: "not audited: OSV lookup failed (HTTP 503)",
    cause: "not-audited",
  }]);
  const [summary] = result.audited;
  assertEquals(summary.passed, false);
  assertEquals(summary.cause, "not-audited");
  assertEquals(summary.reason, "OSV lookup failed (HTTP 503)");
  assertEquals(summary.license, "MIT");
  assertEquals(notAuditedCount(result), 1);
});

Deno.test("checkDependencyTrust: an unreachable OSV leaves the dependency not audited", async () => {
  const result = await checkDependencyTrust(
    [npmSpec("some-pkg", "1.0.0")],
    routedFetcher({
      [OSV_URL]: "throw",
      [NPM_URL]: { status: 200, body: HEALTHY_NPM_BODY },
      [DOWNLOADS_URL]: { status: 200, body: { downloads: 50_000 } },
    }),
  );

  assertEquals(
    result.audited[0].reason,
    "OSV lookup failed (error sending request)",
  );
  assertEquals(result.audited[0].passed, false);
  assertEquals(notAuditedCount(result), 1);
});

Deno.test("checkDependencyTrust: npm down with a pinned version still queries OSV", async () => {
  const calls: string[] = [];
  const result = await checkDependencyTrust(
    [npmSpec("some-pkg", "1.0.0")],
    routedFetcher({
      [OSV_URL]: { status: 200, body: { vulns: [] } },
      [NPM_URL]: { status: 500, body: {} },
      [DOWNLOADS_URL]: { status: 500, body: {} },
    }, calls),
  );

  assertEquals(calls.some((u) => u.includes(OSV_URL)), true);
  assertEquals(result.warnings, [{
    dependency: "some-pkg",
    message: "not audited: npm registry lookup failed (HTTP 500)",
    cause: "not-audited",
  }]);
  const [summary] = result.audited;
  assertEquals(summary.version, "1.0.0");
  assertEquals(summary.passed, false);
  assertEquals(summary.cause, "not-audited");
  assertEquals(summary.license, null);
});

Deno.test("checkDependencyTrust: npm down still blocks on a HIGH vulnerability OSV reports", async () => {
  const result = await checkDependencyTrust(
    [npmSpec("some-pkg", "1.0.0")],
    routedFetcher({
      [OSV_URL]: {
        status: 200,
        body: {
          vulns: [{ id: "GHSA-1234", database_specific: { severity: "HIGH" } }],
        },
      },
      [NPM_URL]: "throw",
      [DOWNLOADS_URL]: "throw",
    }),
  );

  assertEquals(result.passed, false);
  assertEquals(result.errors, [{
    dependency: "some-pkg",
    message: "vulnerability GHSA-1234 (HIGH)",
  }]);
  assertEquals(result.audited[0].cause, "not-audited");
});

Deno.test("checkDependencyTrust: npm down with no version cannot query OSV", async () => {
  const calls: string[] = [];
  const result = await checkDependencyTrust(
    [npmSpec("some-pkg", null)],
    routedFetcher({
      [OSV_URL]: { status: 200, body: { vulns: [] } },
      [NPM_URL]: { status: 404, body: {} },
      [DOWNLOADS_URL]: { status: 404, body: {} },
    }, calls),
  );

  assertEquals(calls.some((u) => u.includes(OSV_URL)), false);
  const [summary] = result.audited;
  assertEquals(summary.version, "latest");
  assertEquals(
    summary.reason,
    "npm registry lookup failed (HTTP 404); OSV not queried (no resolvable version)",
  );
  assertEquals(summary.passed, false);
});

Deno.test("checkDependencyTrust: both services down names both lookups", async () => {
  const result = await checkDependencyTrust(
    [npmSpec("some-pkg", "1.0.0")],
    routedFetcher({
      [OSV_URL]: { status: 502, body: {} },
      [NPM_URL]: "throw",
      [DOWNLOADS_URL]: "throw",
    }),
  );

  assertEquals(result.errors, []);
  assertEquals(result.warnings, [{
    dependency: "some-pkg",
    message: "not audited: npm registry lookup failed (error sending " +
      "request); OSV lookup failed (HTTP 502)",
    cause: "not-audited",
  }]);
  assertEquals(result.audited[0].passed, false);
  assertEquals(notAuditedCount(result), 1);
});

Deno.test("checkDependencyTrust: a failed downloads lookup alone still audits the dependency", async () => {
  const result = await checkDependencyTrust(
    [npmSpec("some-pkg", "1.0.0")],
    routedFetcher({
      [OSV_URL]: { status: 200, body: { vulns: [] } },
      [NPM_URL]: { status: 200, body: HEALTHY_NPM_BODY },
      [DOWNLOADS_URL]: { status: 503, body: {} },
    }),
  );

  const [summary] = result.audited;
  assertEquals(summary.passed, true);
  assertEquals(summary.cause, undefined);
  assertEquals(summary.weeklyDownloads, null);
  assertEquals(notAuditedCount(result), 0);
});

Deno.test("checkDependencyTrust: an unreachable downloads API alone still audits the dependency", async () => {
  const result = await checkDependencyTrust(
    [npmSpec("some-pkg", "1.0.0")],
    routedFetcher({
      [OSV_URL]: { status: 200, body: { vulns: [] } },
      [NPM_URL]: { status: 200, body: HEALTHY_NPM_BODY },
      [DOWNLOADS_URL]: "throw",
    }),
  );

  const [summary] = result.audited;
  assertEquals(summary.passed, true);
  assertEquals(summary.cause, undefined);
  assertEquals(summary.license, "MIT");
  assertEquals(summary.weeklyDownloads, null);
  assertEquals(notAuditedCount(result), 0);
});

Deno.test("checkDependencyTrust: counts each unaudited dependency once, by name", async () => {
  const result = await checkDependencyTrust(
    [npmSpec("pkg-a", "1.0.0"), npmSpec("pkg-b", "2.0.0")],
    routedFetcher({
      [OSV_URL]: "throw",
      [NPM_URL]: { status: 200, body: HEALTHY_NPM_BODY },
      [DOWNLOADS_URL]: { status: 200, body: { downloads: 50_000 } },
    }),
  );

  assertEquals(notAuditedCount(result), 2);
  for (const name of ["pkg-a", "pkg-b"]) {
    const summary = result.audited.find((a) => a.name === name);
    assertEquals(summary?.cause, "not-audited");
  }
});

Deno.test("checkDependencyTrust: empty specifiers passes", async () => {
  const result = await checkDependencyTrust([], fetch);
  assertEquals(result.passed, true);
  assertEquals(result.errors.length, 0);
  assertEquals(result.warnings.length, 0);
});

// ── Audited version resolution ──────────────────────────────────────────
// Vectors mirror swamp-club tests/domain/dependency_trust_test.ts, so push
// and the registry scorecard ask OSV about the same version.

const PUBLISHED = [
  "3.9.0",
  "4.17.0",
  "4.18.2",
  "4.21.1",
  "5.0.0",
  "5.1.0-rc.1",
];
const TAGS = { latest: "5.0.0", next: "5.1.0-rc.1" };

Deno.test("resolveAuditVersion: an exact version is used as-is", () => {
  assertEquals(resolveAuditVersion("4.18.2", PUBLISHED, TAGS), "4.18.2");
});

Deno.test("resolveAuditVersion: an exact version needs no npm data", () => {
  assertEquals(resolveAuditVersion("1.0.0", [], {}), "1.0.0");
});

Deno.test("resolveAuditVersion: no version resolves to latest", () => {
  assertEquals(resolveAuditVersion(null, PUBLISHED, TAGS), "5.0.0");
});

Deno.test("resolveAuditVersion: no version without npm data is unresolvable", () => {
  assertEquals(resolveAuditVersion(null, [], {}), null);
});

Deno.test("resolveAuditVersion: a caret range resolves to the highest match", () => {
  assertEquals(resolveAuditVersion("^4.18.0", PUBLISHED, TAGS), "4.21.1");
});

Deno.test("resolveAuditVersion: a tilde range resolves to the highest match", () => {
  assertEquals(resolveAuditVersion("~4.18.0", PUBLISHED, TAGS), "4.18.2");
});

Deno.test("resolveAuditVersion: a bare major resolves within it", () => {
  assertEquals(resolveAuditVersion("4", PUBLISHED, TAGS), "4.21.1");
});

Deno.test("resolveAuditVersion: a dist-tag resolves through dist-tags", () => {
  assertEquals(resolveAuditVersion("next", PUBLISHED, TAGS), "5.1.0-rc.1");
});

Deno.test("resolveAuditVersion: a range nothing satisfies is unresolvable", () => {
  assertEquals(resolveAuditVersion("^9.0.0", PUBLISHED, TAGS), null);
});

Deno.test("resolveAuditVersion: a range without npm data is unresolvable", () => {
  assertEquals(resolveAuditVersion("^4.18.0", [], {}), null);
});

const RANGE_NPM_BODY = {
  "dist-tags": { latest: "4.21.1" },
  versions: {
    "4.17.0": { license: "MIT", maintainers: [{ name: "a" }] },
    "4.18.2": { license: "MIT", maintainers: [{ name: "a" }] },
    "4.21.1": { license: "MIT", maintainers: [{ name: "a" }] },
    "5.0.0-beta.1": { license: "MIT", maintainers: [{ name: "a" }] },
  },
  time: { "4.21.1": new Date().toISOString() },
};

/** Like `routedFetcher`, also recording each OSV request body. */
function osvRecordingFetcher(
  routes: Record<string, { status: number; body: unknown } | "throw">,
  osvBodies: unknown[],
): Fetcher {
  const inner = routedFetcher(routes);
  return (url: string | URL, init?: RequestInit) => {
    if (url.toString().includes(OSV_URL)) {
      osvBodies.push(JSON.parse(String(init?.body)));
    }
    return inner(url, init);
  };
}

Deno.test("checkDependencyTrust: a range asks OSV about the highest published match", async () => {
  const osvBodies: unknown[] = [];
  const result = await checkDependencyTrust(
    [npmSpec("express", "^4.18.0")],
    osvRecordingFetcher({
      [OSV_URL]: { status: 200, body: { vulns: [] } },
      [NPM_URL]: { status: 200, body: RANGE_NPM_BODY },
      [DOWNLOADS_URL]: { status: 200, body: { downloads: 50_000 } },
    }, osvBodies),
  );

  assertEquals(osvBodies, [{
    package: { name: "express", ecosystem: "npm" },
    version: "4.21.1",
  }]);
  const [summary] = result.audited;
  assertEquals(summary.version, "4.21.1");
  assertEquals(summary.passed, true);
  assertEquals(summary.cause, undefined);
  assertEquals(notAuditedCount(result), 0);
});

Deno.test("checkDependencyTrust: a range nothing satisfies is not audited", async () => {
  const osvBodies: unknown[] = [];
  const result = await checkDependencyTrust(
    [npmSpec("express", "^9.0.0")],
    osvRecordingFetcher({
      [OSV_URL]: { status: 200, body: { vulns: [] } },
      [NPM_URL]: { status: 200, body: RANGE_NPM_BODY },
      [DOWNLOADS_URL]: { status: 200, body: { downloads: 50_000 } },
    }, osvBodies),
  );

  assertEquals(osvBodies, []);
  assertEquals(result.warnings, [{
    dependency: "express",
    message:
      "not audited: OSV not queried (no published version matches ^9.0.0)",
    cause: "not-audited",
  }]);
  const [summary] = result.audited;
  assertEquals(summary.version, "^9.0.0");
  assertEquals(summary.passed, false);
  assertEquals(summary.cause, "not-audited");
  assertEquals(
    summary.reason,
    "OSV not queried (no published version matches ^9.0.0)",
  );
});

Deno.test("checkDependencyTrust: npm down with a range cannot query OSV", async () => {
  const osvBodies: unknown[] = [];
  const result = await checkDependencyTrust(
    [npmSpec("express", "^4.18.0")],
    osvRecordingFetcher({
      [OSV_URL]: { status: 200, body: { vulns: [] } },
      [NPM_URL]: { status: 503, body: {} },
      [DOWNLOADS_URL]: { status: 503, body: {} },
    }, osvBodies),
  );

  assertEquals(osvBodies, []);
  const [summary] = result.audited;
  assertEquals(summary.version, "^4.18.0");
  assertEquals(summary.passed, false);
  assertEquals(
    summary.reason,
    "npm registry lookup failed (HTTP 503); OSV not queried (no resolvable version)",
  );
});

Deno.test("checkDependencyTrust: no version and no latest tag is not audited", async () => {
  const osvBodies: unknown[] = [];
  const result = await checkDependencyTrust(
    [npmSpec("express", null)],
    osvRecordingFetcher({
      [OSV_URL]: { status: 200, body: { vulns: [] } },
      [NPM_URL]: {
        status: 200,
        body: { ...RANGE_NPM_BODY, "dist-tags": {} },
      },
      [DOWNLOADS_URL]: { status: 200, body: { downloads: 50_000 } },
    }, osvBodies),
  );

  assertEquals(osvBodies, []);
  const [summary] = result.audited;
  assertEquals(summary.version, "latest");
  assertEquals(
    summary.reason,
    "OSV not queried (no published version matches latest)",
  );
});

Deno.test("checkDependencyTrust: a malformed packument leaves a range not audited", async () => {
  const osvBodies: unknown[] = [];
  const result = await checkDependencyTrust(
    [npmSpec("express", "^4.18.0")],
    osvRecordingFetcher({
      [OSV_URL]: { status: 200, body: { vulns: [] } },
      [NPM_URL]: {
        status: 200,
        body: { "dist-tags": { latest: 4 }, versions: "4.21.1" },
      },
      [DOWNLOADS_URL]: { status: 200, body: { downloads: 50_000 } },
    }, osvBodies),
  );

  assertEquals(osvBodies, []);
  const [summary] = result.audited;
  assertEquals(summary.passed, false);
  assertEquals(
    summary.reason,
    "OSV not queried (no published version matches ^4.18.0)",
  );
});

// ── The shipped version (swamp-club#3352) ───────────────────────────────

function lockOf(
  versions: Record<string, string[]>,
): LockedDependencyVersions {
  return {
    source: "deno.lock",
    versionsFor: (registry, name) => versions[`${registry}:${name}`] ?? [],
  };
}

function healthyRoutes(
  packument: unknown,
): Record<string, { status: number; body: unknown }> {
  return {
    [OSV_URL]: { status: 200, body: { vulns: [] } },
    [NPM_URL]: { status: 200, body: packument },
    [DOWNLOADS_URL]: { status: 200, body: { downloads: 50_000 } },
  };
}

const DEPRECATION_BODY = {
  "dist-tags": { latest: "2.0.0" },
  versions: {
    "1.0.0": {
      license: "GPL-3.0",
      maintainers: [],
      deprecated: "Use 2.x instead\u001b[31m",
    },
    "2.0.0": { license: "MIT", maintainers: [{ name: "a" }] },
  },
  time: { "2.0.0": new Date().toISOString() },
};

Deno.test("checkDependencyTrust: a deprecated pin warns when latest is not deprecated", async () => {
  const result = await checkDependencyTrust(
    [npmSpec("pkg", "1.0.0")],
    routedFetcher(healthyRoutes(DEPRECATION_BODY)),
  );

  assertEquals(result.errors, []);
  assertEquals(
    result.warnings.find((w) => w.cause === "deprecated-version"),
    {
      dependency: "pkg",
      message: "version 1.0.0 is deprecated: Use 2.x instead [31m",
      cause: "deprecated-version",
    },
  );
  // License and maintainers come from the pinned version too.
  assertEquals(result.audited[0].license, "GPL-3.0");
  assertEquals(
    result.warnings.some((w) => w.message === "no maintainers listed"),
    true,
  );
  assertEquals(result.audited[0].passed, true);
  assertEquals(result.audited[0].resolvedFrom, "exact");
});

Deno.test("checkDependencyTrust: a good pin passes when only latest is deprecated", async () => {
  const body = {
    ...DEPRECATION_BODY,
    versions: {
      "1.0.0": { license: "MIT", maintainers: [{ name: "a" }] },
      "2.0.0": {
        license: "MIT",
        maintainers: [{ name: "a" }],
        deprecated: "abandoned",
      },
    },
  };
  const result = await checkDependencyTrust(
    [npmSpec("pkg", "1.0.0")],
    routedFetcher(healthyRoutes(body)),
  );

  assertEquals(result.errors, []);
  assertEquals(result.warnings, []);
  assertEquals(result.passed, true);
});

Deno.test("checkDependencyTrust: a deprecated pin of a deprecated package is an error", async () => {
  const body = {
    ...DEPRECATION_BODY,
    versions: {
      "1.0.0": {
        license: "MIT",
        maintainers: [{ name: "a" }],
        deprecated: "x",
      },
      "2.0.0": {
        license: "MIT",
        maintainers: [{ name: "a" }],
        deprecated: "x",
      },
    },
  };
  const result = await checkDependencyTrust(
    [npmSpec("pkg", "1.0.0")],
    routedFetcher(healthyRoutes(body)),
  );

  assertEquals(result.errors, [{
    dependency: "pkg",
    message: "package is deprecated",
  }]);
  assertEquals(
    result.warnings.some((w) => w.cause === "deprecated-version"),
    false,
  );
});

Deno.test("checkDependencyTrust: a long deprecation notice is cut to 200 characters", async () => {
  const body = {
    ...DEPRECATION_BODY,
    versions: {
      ...DEPRECATION_BODY.versions,
      "1.0.0": {
        license: "MIT",
        maintainers: [{ name: "a" }],
        deprecated: "x".repeat(500),
      },
    },
  };
  const result = await checkDependencyTrust(
    [npmSpec("pkg", "1.0.0")],
    routedFetcher(healthyRoutes(body)),
  );
  const finding = result.warnings.find((w) => w.cause === "deprecated-version");
  assertEquals(
    finding?.message,
    `version 1.0.0 is deprecated: ${"x".repeat(199)}…`,
  );
});

Deno.test("checkDependencyTrust: a range warns naming the version it resolves", async () => {
  const result = await checkDependencyTrust(
    [npmSpec("express", "^4.18.0")],
    routedFetcher(healthyRoutes(RANGE_NPM_BODY)),
  );

  assertEquals(result.warnings, [{
    dependency: "express",
    message:
      "npm:express@^4.18.0 is a range; audited 4.21.1, the version this push resolves",
    cause: "loose-specifier",
  }]);
  assertEquals(result.audited[0].specifier, "npm:express@^4.18.0");
  assertEquals(result.audited[0].resolvedFrom, "registry");
});

Deno.test("checkDependencyTrust: a tilde range, unpinned and a dist-tag each warn", async () => {
  const body = {
    ...RANGE_NPM_BODY,
    "dist-tags": { latest: "4.21.1", next: "5.0.0-beta.1" },
  };
  const result = await checkDependencyTrust(
    [
      npmSpec("express", "~4.17.0"),
      npmSpec("express", null),
      npmSpec("express", "next"),
    ],
    routedFetcher(healthyRoutes(body)),
  );

  assertEquals(
    result.warnings.filter((w) => w.cause === "loose-specifier").map((w) =>
      w.message
    ),
    [
      "npm:express@~4.17.0 is a range; audited 4.17.0, the version this push resolves",
      "npm:express is unpinned; audited 4.21.1, the version this push resolves",
      "npm:express@next is a dist-tag; audited 5.0.0-beta.1, the version this push resolves",
    ],
  );
});

Deno.test("checkDependencyTrust: exact pins, including = and v forms, do not warn", async () => {
  const result = await checkDependencyTrust(
    [
      npmSpec("express", "4.18.2"),
      npmSpec("express", "=4.17.0"),
      npmSpec("express", "v4.21.1"),
    ],
    routedFetcher(healthyRoutes(RANGE_NPM_BODY)),
  );

  assertEquals(result.warnings, []);
  assertEquals(
    result.audited.map((a) => [a.version, a.resolvedFrom]),
    [["4.18.2", "exact"], ["4.17.0", "exact"], ["4.21.1", "exact"]],
  );
});

Deno.test("checkDependencyTrust: two ranges of one package share one packument lookup", async () => {
  const calls: string[] = [];
  const result = await checkDependencyTrust(
    [npmSpec("express", "^4.18.0"), npmSpec("express", "~4.17.0")],
    routedFetcher(healthyRoutes(RANGE_NPM_BODY), calls),
  );

  assertEquals(calls.filter((u) => u.includes(NPM_URL)).length, 1);
  assertEquals(calls.filter((u) => u.includes(OSV_URL)).length, 2);
  assertEquals(result.audited.map((a) => a.version), ["4.21.1", "4.17.0"]);
});

Deno.test("checkDependencyTrust: the lock decides a range's version and the finding says so", async () => {
  const osvBodies: unknown[] = [];
  const result = await checkDependencyTrust(
    [npmSpec("express", "^4.17.0")],
    osvRecordingFetcher(healthyRoutes(RANGE_NPM_BODY), osvBodies),
    DEFAULT_TRUST_THRESHOLDS,
    undefined,
    lockOf({ "npm:express": ["4.18.2"] }),
  );

  assertEquals(osvBodies, [{
    package: { name: "express", ecosystem: "npm" },
    version: "4.18.2",
  }]);
  assertEquals(result.warnings, [{
    dependency: "express",
    message:
      "npm:express@^4.17.0 is a range; audited 4.18.2, the version this push resolves (from deno.lock)",
    cause: "loose-specifier",
  }]);
  assertEquals(result.audited[0].resolvedFrom, "lockfile");
});

Deno.test("checkDependencyTrust: a stale lock entry falls through to the registry", async () => {
  const result = await checkDependencyTrust(
    [npmSpec("express", "^4.18.0")],
    routedFetcher(healthyRoutes(RANGE_NPM_BODY)),
    DEFAULT_TRUST_THRESHOLDS,
    undefined,
    lockOf({ "npm:express": ["4.17.0"] }),
  );
  assertEquals(result.audited[0].version, "4.21.1");
  assertEquals(result.audited[0].resolvedFrom, "registry");
});

Deno.test("checkDependencyTrust: npm down with a locked range still queries OSV", async () => {
  const osvBodies: unknown[] = [];
  const result = await checkDependencyTrust(
    [npmSpec("express", "^4.17.0")],
    osvRecordingFetcher({
      [OSV_URL]: { status: 200, body: { vulns: [] } },
      [NPM_URL]: { status: 503, body: {} },
      [DOWNLOADS_URL]: { status: 503, body: {} },
    }, osvBodies),
    DEFAULT_TRUST_THRESHOLDS,
    undefined,
    lockOf({ "npm:express": ["4.18.2"] }),
  );
  assertEquals(osvBodies.length, 1);
  assertEquals(
    result.audited[0].reason,
    "npm registry lookup failed (HTTP 503)",
  );
});

Deno.test("checkDependencyTrust: an invalid npm name is not audited and never fetched", async () => {
  const calls: string[] = [];
  const result = await checkDependencyTrust(
    [npmSpec("bad name?x", "1.0.0")],
    routedFetcher(healthyRoutes(HEALTHY_NPM_BODY), calls),
  );
  assertEquals(calls, []);
  assertEquals(result.warnings, [{
    dependency: "bad name?x",
    message: "not audited: invalid npm package name",
    cause: "not-audited",
  }]);
});

// ── JSR ──────────────────────────────────────────────────────────────────

const JSR_URL = "jsr.io/";

function jsrSpec(name: string, version: string | null): DependencySpecifier {
  return { name, version, registry: "jsr", sourceFile: "model.ts" };
}

const JSR_META = {
  scope: "std",
  name: "assert",
  latest: "1.0.2",
  versions: {
    "0.225.0": { yanked: true, createdAt: "2024-04-29T16:05:05Z" },
    "0.225.1": { createdAt: "2024-05-01T00:00:00Z" },
    "1.0.0": { createdAt: "2024-07-01T00:00:00Z" },
    "1.0.2": { createdAt: "2024-09-01T00:00:00Z" },
    "1.1.0-rc.1": { createdAt: "2024-10-01T00:00:00Z" },
  },
};

/** Answers jsr.io like the real registry: JSON with its content type. */
function jsrFetcher(
  route: { status: number; body: unknown; contentType?: string } | "throw",
  calls: string[] = [],
): Fetcher {
  return (url: string | URL, init?: RequestInit) => {
    calls.push(url.toString());
    assertEquals(new Headers(init?.headers).get("accept"), "application/json");
    if (route === "throw") {
      return Promise.reject(new TypeError("error sending request"));
    }
    return Promise.resolve(
      new Response(JSON.stringify(route.body), {
        status: route.status,
        headers: { "content-type": route.contentType ?? "application/json" },
      }),
    );
  };
}

Deno.test("checkDependencyTrust: a JSR version that exists passes", async () => {
  const calls: string[] = [];
  const result = await checkDependencyTrust(
    [jsrSpec("@std/assert", "1.0.0")],
    jsrFetcher({ status: 200, body: JSR_META }, calls),
  );
  assertEquals(calls, ["https://jsr.io/@std/assert/meta.json"]);
  assertEquals(result.errors, []);
  assertEquals(result.warnings, []);
  assertEquals(result.audited[0].passed, true);
  assertEquals(result.audited[0].registry, "jsr");
});

Deno.test("checkDependencyTrust: a yanked JSR version warns", async () => {
  const result = await checkDependencyTrust(
    [jsrSpec("@std/assert", "0.225.0")],
    jsrFetcher({ status: 200, body: JSR_META }),
  );
  assertEquals(result.errors, []);
  assertEquals(result.warnings, [{
    dependency: "@std/assert",
    message: "version 0.225.0 is yanked on JSR",
    cause: "jsr-yanked",
  }]);
});

Deno.test("checkDependencyTrust: a missing JSR version is an error", async () => {
  const result = await checkDependencyTrust(
    [jsrSpec("@std/assert", "0.0.999")],
    jsrFetcher({ status: 200, body: JSR_META }),
  );
  assertEquals(result.passed, false);
  assertEquals(result.errors, [{
    dependency: "@std/assert",
    message: "version 0.0.999 not found on JSR",
    cause: "jsr-missing",
  }]);
});

Deno.test("checkDependencyTrust: a missing JSR package is an error", async () => {
  const result = await checkDependencyTrust(
    [jsrSpec("@swamp-nonexistent/zzz", "1.0.0")],
    jsrFetcher({
      status: 404,
      body: "404 - Not Found",
      contentType: "text/plain",
    }),
  );
  assertEquals(result.errors, [{
    dependency: "@swamp-nonexistent/zzz",
    message: "JSR package not found",
    cause: "jsr-missing",
  }]);
});

Deno.test("checkDependencyTrust: an invalid JSR name is an error and never fetched", async () => {
  const calls: string[] = [];
  const result = await checkDependencyTrust(
    [jsrSpec("@a?x/b#y", "1.0.0")],
    jsrFetcher({ status: 200, body: JSR_META }, calls),
  );
  assertEquals(calls, []);
  assertEquals(result.errors[0].message, "invalid JSR package name");
  assertEquals(result.errors[0].cause, "jsr-missing");
});

Deno.test("checkDependencyTrust: a JSR range skips yanked and prerelease versions", async () => {
  const result = await checkDependencyTrust(
    [jsrSpec("@std/assert", "^0.225.0"), jsrSpec("@std/assert", "1")],
    jsrFetcher({ status: 200, body: JSR_META }),
  );
  assertEquals(
    result.warnings.map((w) => w.message),
    [
      "jsr:@std/assert@^0.225.0 is a range; audited 0.225.1, the version this push resolves",
      "jsr:@std/assert@1 is a range; audited 1.0.2, the version this push resolves",
    ],
  );
});

Deno.test("checkDependencyTrust: a JSR range only a yanked version satisfies resolves to it", async () => {
  const result = await checkDependencyTrust(
    [jsrSpec("@std/assert", "~0.225.0")],
    jsrFetcher({
      status: 200,
      body: {
        ...JSR_META,
        versions: { "0.225.0": { yanked: true }, "1.0.2": {} },
      },
    }),
  );
  assertEquals(result.warnings.map((w) => w.cause), [
    "jsr-yanked",
    "loose-specifier",
  ]);
  assertEquals(result.audited[0].version, "0.225.0");
});

Deno.test("checkDependencyTrust: an unpinned JSR import resolves to latest", async () => {
  const result = await checkDependencyTrust(
    [jsrSpec("@std/assert", null)],
    jsrFetcher({ status: 200, body: JSR_META }),
  );
  assertEquals(result.warnings, [{
    dependency: "@std/assert",
    message:
      "jsr:@std/assert is unpinned; audited 1.0.2, the version this push resolves",
    cause: "loose-specifier",
  }]);
});

Deno.test("checkDependencyTrust: a JSR range the lock records resolves from the lock", async () => {
  const result = await checkDependencyTrust(
    [jsrSpec("@std/assert", "1")],
    jsrFetcher({ status: 200, body: JSR_META }),
    DEFAULT_TRUST_THRESHOLDS,
    undefined,
    lockOf({ "jsr:@std/assert": ["1.0.0"] }),
  );
  assertEquals(result.audited[0].version, "1.0.0");
  assertEquals(result.audited[0].resolvedFrom, "lockfile");
});

for (
  const [label, route, reason] of [
    ["an error status", { status: 503, body: {} }, "HTTP 503"],
    ["a rate limit", { status: 429, body: {} }, "HTTP 429"],
    ["an unreachable host", "throw", "error sending request"],
    [
      "an HTML page",
      { status: 200, body: "<html>", contentType: "text/html" },
      "response was not JSON",
    ],
    [
      "metadata without versions",
      { status: 200, body: { latest: "1.0.0" } },
      "metadata lists no versions",
    ],
  ] as const
) {
  Deno.test(`checkDependencyTrust: JSR answering with ${label} is not audited`, async () => {
    const result = await checkDependencyTrust(
      [jsrSpec("@std/assert", "1.0.0")],
      jsrFetcher(route),
    );
    assertEquals(result.errors, []);
    assertEquals(result.warnings, [{
      dependency: "@std/assert",
      message: `not audited: JSR lookup failed (${reason})`,
      cause: "not-audited",
    }]);
    assertEquals(result.audited[0].passed, false);
    assertEquals(notAuditedCount(result), 1);
  });
}
