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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  evaluateJsrPackage,
  evaluateNpmPackage,
  groupForAudit,
  licenseAllowed,
  type Lookup,
  MAX_AUDITED_DEPENDENCIES,
  type NpmLookup,
  overLimitAudits,
  planNpmPackage,
  pushResult,
  scorecardResult,
  type SpecifierAudit,
  UNREADABLE_MODULE_REASON,
} from "./evaluate.ts";
import { monthsSince, parseNpmPackument } from "./npm.ts";
import type { OsvVulnerability } from "./osv.ts";
import type { DependencySpecifier } from "./specifiers.ts";

const NOW = new Date("2026-10-26T00:00:00Z");

function spec(
  name: string,
  version: string | null,
  registry: "npm" | "jsr" = "npm",
): DependencySpecifier {
  return { name, version, registry, sourceFile: "models/a.ts" };
}

function packument(overrides: Record<string, unknown> = {}): NpmLookup {
  return {
    kind: "found",
    value: parseNpmPackument({
      "dist-tags": { latest: "1.0.0" },
      versions: {
        "1.0.0": { license: "MIT", maintainers: [{ name: "m" }] },
      },
      time: { "1.0.0": "2026-09-01T00:00:00Z" },
      ...overrides,
    }, { downloads: 50_000 }),
  };
}

function auditNpm(
  s: DependencySpecifier,
  npm: NpmLookup,
  osv: Record<string, Lookup<OsvVulnerability[]>> = {},
): SpecifierAudit {
  const plan = planNpmPackage(s.name, [s], npm);
  const answers = new Map<string, Lookup<OsvVulnerability[]>>();
  for (const v of plan.osvVersions) {
    answers.set(v, osv[v] ?? { kind: "found", value: [] });
  }
  return evaluateNpmPackage(s.name, [s], npm, plan, answers, NOW)[0];
}

function views(s: DependencySpecifier, audit: SpecifierAudit) {
  const entries = [{ spec: s, audit }];
  return { push: pushResult(entries), scorecard: scorecardResult(entries) };
}

Deno.test("evaluateNpmPackage: a healthy pin passes with both points", () => {
  const s = spec("ok", "1.0.0");
  const { push, scorecard } = views(s, auditNpm(s, packument()));
  assertEquals(push.errors, []);
  assertEquals(push.warnings, []);
  assertEquals(scorecard.earnedPoints, 2);
  assertEquals(scorecard.audited, [{
    registry: "npm",
    packageName: "ok",
    specifier: "npm:ok@1.0.0",
    version: "1.0.0",
    resolvedFrom: "exact",
  }]);
});

Deno.test("evaluateNpmPackage: vulnerabilities in each wording; HIGH blocks, MEDIUM warns", () => {
  const s = spec("vuln", "1.0.0");
  const { push, scorecard } = views(
    s,
    auditNpm(s, packument(), {
      "1.0.0": {
        kind: "found",
        value: [
          { id: "GHSA-h", severity: "HIGH" },
          { id: "GHSA-m", severity: "MEDIUM" },
        ],
      },
    }),
  );
  assertEquals(push.errors.map((e) => e.message), [
    "vulnerability GHSA-h (HIGH)",
  ]);
  assertEquals(push.warnings.map((w) => w.message), [
    "vulnerability GHSA-m (MEDIUM)",
  ]);
  assertEquals(scorecard.blockers.map((b) => b.reason), [
    "HIGH vulnerability: GHSA-h",
  ]);
  assertEquals(scorecard.warnings.map((w) => w.reason), [
    "MEDIUM vulnerability: GHSA-m",
  ]);
  assertEquals(scorecard.earnedPoints, 0);
});

Deno.test("evaluateNpmPackage: a version npm lists without a manifest is not audited", () => {
  const s = spec("nullman", "1.0.0");
  const { push, scorecard } = views(
    s,
    auditNpm(s, packument({ versions: { "1.0.0": null } })),
  );
  assertStringIncludes(push.warnings[0].message, "npm lists no version 1.0.0");
  assertEquals(push.warnings[0].notAuditedFix, "specifier");
  assertEquals(scorecard.notAudited.length, 1);
  assertEquals(scorecard.earnedPoints, 0);
});

Deno.test("evaluateNpmPackage: without a latest dist-tag a deprecated version is that version's finding", () => {
  const s = spec("old", "1.0.0");
  const { push, scorecard } = views(
    s,
    auditNpm(
      s,
      packument({
        "dist-tags": {},
        version: "1.0.0",
        versions: { "1.0.0": { license: "MIT", deprecated: "gone" } },
      }),
    ),
  );
  assertEquals(push.errors, []);
  assertEquals(push.warnings[0].cause, "deprecated-version");
  assertEquals(scorecard.blockers, [{
    packageName: "old",
    reason: "version 1.0.0 is deprecated: gone",
    cause: "deprecated-version",
  }]);
});

Deno.test("evaluateNpmPackage: an OSV hit on an exact pin is kept when npm is down", () => {
  const s = spec("down", "1.0.0");
  const { push, scorecard } = views(
    s,
    auditNpm(s, { kind: "unavailable", reason: "HTTP 503" }, {
      "1.0.0": { kind: "found", value: [{ id: "GHSA-x", severity: "HIGH" }] },
    }),
  );
  assertEquals(push.errors.map((e) => e.message), [
    "vulnerability GHSA-x (HIGH)",
  ]);
  assertEquals(push.warnings[0].cause, "not-audited");
  assertEquals(scorecard.blockers.length, 1);
  assertEquals(scorecard.notAudited, [{
    packageName: "down",
    reason: "npm registry lookup failed (HTTP 503)",
  }]);
});

Deno.test("evaluateNpmPackage: an invalid npm name is not audited and never looked up", () => {
  const s = spec("Foo Bar", null);
  const plan = planNpmPackage(s.name, [s], { kind: "invalid-name" });
  assertEquals(plan.osvVersions, []);
  const { push } = views(s, auditNpm(s, { kind: "invalid-name" }));
  assertEquals(push.warnings.map((w) => [w.message, w.notAuditedFix]), [[
    "not audited: invalid npm package name",
    "name",
  ]]);
});

Deno.test("evaluateNpmPackage: missing maintainer data is no finding; an empty list is", () => {
  const none = spec("nomaint", "1.0.0");
  assertEquals(
    views(none, auditNpm(none, packument())).push.warnings,
    [],
  );
  const empty = spec("empty", "1.0.0");
  assertEquals(
    views(
      empty,
      auditNpm(
        empty,
        packument({
          versions: { "1.0.0": { license: "MIT", maintainers: [] } },
        }),
      ),
    ).push.warnings.map((w) => w.message),
    ["no maintainers listed"],
  );
  const absent = spec("absent", "1.0.0");
  assertEquals(
    views(
      absent,
      auditNpm(
        absent,
        packument({ versions: { "1.0.0": { license: "MIT" } } }),
      ),
    ).push.warnings,
    [],
  );
});

Deno.test("evaluateNpmPackage: age and downloads in each wording", () => {
  const s = spec("stale", "1.0.0");
  const lookup = packument({ time: { "1.0.0": "2020-01-01T00:00:00Z" } });
  if (lookup.kind === "found") lookup.value.weeklyDownloads = 10;
  const { push, scorecard } = views(s, auditNpm(s, lookup));
  assertEquals(push.warnings.map((w) => w.message), [
    "low weekly downloads (10 < 1000)",
    `last published ${
      monthsSince("2020-01-01T00:00:00Z", NOW)
    } months ago (threshold: 24)`,
  ]);
  assertEquals(scorecard.warnings.map((w) => w.reason), [
    "weekly downloads (10) below 1000",
    `last publish ${
      monthsSince("2020-01-01T00:00:00Z", NOW)
    } months ago (threshold: 24)`,
  ]);
});

Deno.test("monthsSince: a month is 30.44 days", () => {
  const at = (days: number) =>
    monthsSince(new Date(NOW.getTime() - days * 86_400_000).toISOString(), NOW);
  assertEquals(at(755), 24);
  assertEquals(at(761), 25);
});

Deno.test("licenseAllowed: an SPDX expression of allowed licenses passes", () => {
  for (const ok of ["MIT", "MIT OR Apache-2.0", "(MIT)", "MIT AND ISC"]) {
    assert(licenseAllowed(ok), ok);
  }
  for (
    const bad of [
      null,
      "",
      "GPL-3.0-only",
      "MIT OR GPL-3.0-only",
      "MIT or ISC",
      "Apache-2.0 WITH LLVM-exception",
      "Apache-2.0+",
    ]
  ) {
    assert(!licenseAllowed(bad), String(bad));
  }
});

Deno.test("evaluateNpmPackage: a dependency with no license warns", () => {
  const s = spec("nolic", "1.0.0");
  const { scorecard } = views(
    s,
    auditNpm(s, packument({ versions: { "1.0.0": { maintainers: [1] } } })),
  );
  assertEquals(scorecard.warnings.map((w) => w.reason), [
    'license "unknown" not in allowlist',
  ]);
});

Deno.test("evaluateJsrPackage: an unscoped name is an invalid-name blocker", () => {
  const s = spec("foo", "1", "jsr");
  const audit = evaluateJsrPackage("foo", [s], { kind: "invalid-name" })[0];
  const { scorecard } = views(s, audit);
  assertEquals(scorecard.blockers, [{
    packageName: "foo",
    reason: "invalid JSR package name",
    cause: "jsr-missing",
  }]);
  assertEquals(scorecard.earnedPoints, 0);
});

Deno.test("evaluateJsrPackage: a yanked version costs both points; push warns", () => {
  const s = spec("@a/b", "1.0.0", "jsr");
  const audit = evaluateJsrPackage("@a/b", [s], {
    kind: "found",
    value: {
      latest: "1.1.0",
      versions: ["1.0.0", "1.1.0"],
      yanked: new Set(["1.0.0"]),
    },
  })[0];
  const { push, scorecard } = views(s, audit);
  assertEquals(push.errors, []);
  assertEquals(push.warnings[0].cause, "jsr-yanked");
  assertEquals(scorecard.blockers[0].cause, "jsr-yanked");
  assertEquals(scorecard.earnedPoints, 0);
});

Deno.test("evaluateNpmPackage: a loose specifier costs one point, worded for push and the scorecard", () => {
  const s = spec("loose", "^1.0.0");
  const { push, scorecard } = views(s, auditNpm(s, packument()));
  assertEquals(push.warnings.map((w) => w.message), [
    "npm:loose@^1.0.0 is a range; audited 1.0.0, the version this push resolves",
  ]);
  assertEquals(scorecard.warnings.map((w) => w.reason), [
    "npm:loose@^1.0.0 is a range; audited 1.0.0, the version the registry resolved",
  ]);
  assertEquals(scorecard.earnedPoints, 1);
});

Deno.test("groupForAudit: dependencies past the limit, in name order, are not looked up", () => {
  const specs = Array.from(
    { length: MAX_AUDITED_DEPENDENCIES + 2 },
    (_, i) => spec(`p${String(i).padStart(3, "0")}`, "1.0.0"),
  ).reverse();
  const { groups, overLimit } = groupForAudit(specs);
  assertEquals(groups.length, MAX_AUDITED_DEPENDENCIES);
  assertEquals(overLimit.map((s) => s.name), ["p050", "p051"]);
  const audits = overLimitAudits(overLimit);
  const { scorecard } = {
    scorecard: scorecardResult(
      overLimit.map((s, i) => ({ spec: s, audit: audits[i] })),
    ),
  };
  assertEquals(
    scorecard.notAudited[0].reason,
    "not queried: over the 50-dependency limit",
  );
  assertEquals(scorecard.earnedPoints, 0);
});

Deno.test("scorecardResult: a module that does not parse is not audited and costs the points", () => {
  const scorecard = scorecardResult([], ["models/broken.ts"]);
  assertEquals(scorecard.notAudited, [
    { packageName: "models/broken.ts", reason: UNREADABLE_MODULE_REASON },
  ]);
  assertEquals(scorecard.passed, false);
  assertEquals(scorecard.earnedPoints, 0);
  assertEquals(scorecardResult([]).earnedPoints, 2);
});
