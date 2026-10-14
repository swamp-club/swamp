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
} from "./extension_dependency_trust_checker.ts";

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

Deno.test("checkDependencyTrust: skips jsr packages (trusted)", async () => {
  const specs: DependencySpecifier[] = [{
    name: "@std/semver",
    version: "1.0.8",
    registry: "jsr",
    sourceFile: "model.ts",
  }];

  const fetcher = createMockFetcher({});
  const result = await checkDependencyTrust(specs, fetcher);
  assertEquals(result.passed, true);
  assertEquals(result.errors.length, 0);
  assertEquals(result.warnings.length, 0);
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

Deno.test("checkDependencyTrust: npm down with no pinned version cannot query OSV", async () => {
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
  assertEquals(summary.version, "unknown");
  assertEquals(
    summary.reason,
    "npm registry lookup failed (HTTP 404); OSV not queried (no pinned version)",
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
