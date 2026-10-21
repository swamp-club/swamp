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
import { fromFileUrl } from "@std/path";
import {
  type DependencyRegistry,
  type LockedDependencyVersions,
  resolveShippedVersion,
  specifierKind,
} from "./dependency_version_resolution.ts";
import {
  checkDependencyTrust,
  dependencyTrustBlockerCount,
  type DependencyTrustCause,
  type DependencyTrustResult,
  type Fetcher,
  looseSpecifierCount,
  notAuditedCount,
  notAuditedFixes,
} from "./extension_dependency_trust_checker.ts";
import {
  composeScore,
  computeAnalysisFactors,
} from "./extension_rubric_scorer.ts";

// The vectors the registry scorecard (swamp-club#3353) copies, so push and
// the scorecard resolve and word findings the same way.
const VECTORS_PATH = fromFileUrl(
  new URL("./testdata/dependency_audit_vectors.json", import.meta.url),
);

interface ResolutionVector {
  name: string;
  registry: DependencyRegistry;
  spec: string | null;
  locked?: string[];
  lockedFor?: string;
  published: {
    versions: string[];
    distTags: Record<string, string>;
    yanked?: string[];
  };
  expect: { version: string | null; from?: string; kind: string };
}

interface FindingVector {
  name: string;
  registry: DependencyRegistry;
  package: string;
  spec: string | null;
  locked?: string[];
  npm?: Record<string, unknown>;
  jsr?: { status: number; body: unknown };
  expect: {
    severity: string;
    message: string;
    cause?: string;
    pointsLost: number;
  }[];
  /** The scorecard's wording of the same finding, where it differs. */
  scorecardMessage?: string;
}

const vectors = JSON.parse(await Deno.readTextFile(VECTORS_PATH)) as {
  resolution: ResolutionVector[];
  findings: FindingVector[];
  scoring: {
    name: string;
    findings: { severity: string; cause?: string; dependency: string }[];
    earnedPoints: number;
  }[];
};

function lockOf(versions: string[] | undefined, lockedFor?: string) {
  if (!versions) return undefined;
  const lock: LockedDependencyVersions = {
    source: "deno.lock",
    resolvedFor: () => lockedFor,
    versionsFor: () => versions,
  };
  return lock;
}

for (const v of vectors.resolution) {
  Deno.test(`dependency audit vectors: resolves ${v.name}`, () => {
    const shipped = resolveShippedVersion(
      v.registry,
      "pkg",
      v.spec,
      lockOf(v.locked, v.lockedFor),
      { ...v.published, yanked: new Set(v.published.yanked ?? []) },
    );
    assertEquals(shipped?.version ?? null, v.expect.version);
    if (v.expect.from) assertEquals(shipped?.from, v.expect.from);
    assertEquals(specifierKind(v.spec), v.expect.kind);
  });
}

function vectorFetcher(v: FindingVector): Fetcher {
  return (url: string | URL) => {
    const u = url.toString();
    if (u.includes("jsr.io") && v.jsr) {
      return Promise.resolve(
        new Response(JSON.stringify(v.jsr.body), {
          status: v.jsr.status,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (u.includes("api.osv.dev")) {
      return Promise.resolve(Response.json({ vulns: [] }));
    }
    if (u.includes("api.npmjs.org/downloads")) {
      return Promise.resolve(Response.json({ downloads: 50_000 }));
    }
    if (u.includes("registry.npmjs.org") && v.npm) {
      return Promise.resolve(
        Response.json({
          ...v.npm,
          time: { modified: new Date().toISOString() },
        }),
      );
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  };
}

for (const v of vectors.findings) {
  Deno.test(`dependency audit vectors: reports ${v.name}`, async () => {
    const result = await checkDependencyTrust(
      [{
        name: v.package,
        version: v.spec,
        registry: v.registry,
        sourceFile: "model.ts",
      }],
      vectorFetcher(v),
      undefined,
      undefined,
      lockOf(v.locked),
    );
    const reported = [
      ...result.errors.map((e) => ({ severity: "error", ...e })),
      ...result.warnings.map((w) => ({ severity: "warning", ...w })),
    ].map(({ severity, message, cause }): FindingVector["expect"][number] => ({
      severity,
      message,
      ...(cause ? { cause } : {}),
      pointsLost: cause === "loose-specifier"
        ? 1
        : severity === "error" || cause === "not-audited" ||
            cause === "deprecated-version" || cause === "jsr-yanked"
        ? 2
        : 0,
    }));
    assertEquals(reported, v.expect);
    // The rubric loses points for exactly the findings marked as costing them.
    const lost = Math.max(0, ...v.expect.map((e) => e.pointsLost));
    assertEquals(
      factorOf(result).earnedPoints,
      2 - lost,
    );
  });
}

function factorOf(result: DependencyTrustResult) {
  const factors = computeAnalysisFactors({
    entrypointUrls: [],
    readme: null,
    hasLicenseFile: false,
    doc: { nodes: [] } as unknown as Parameters<
      typeof computeAnalysisFactors
    >[0]["doc"],
    rawLintOutput: "",
    dependencyTrustPassed: dependencyTrustBlockerCount(result) === 0,
    dependencyTrustBlockerCount: dependencyTrustBlockerCount(result),
    dependencyNotAuditedCount: notAuditedCount(result),
    dependencyNotAuditedFixes: notAuditedFixes(result),
    dependencyLooseCount: looseSpecifierCount(result),
  });
  return composeScore(
    factors,
    {
      description: "d",
      platforms: [],
      labels: [],
      models: [],
      workflows: [],
      vaults: [],
      datastores: [],
      reports: [],
      skills: [],
    } as unknown as Parameters<typeof composeScore>[1],
  )
    .factors.find((f) => f.id === "dependency-trust")!;
}

for (const sc of vectors.scoring) {
  Deno.test(`dependency audit vectors: scores ${sc.name}`, () => {
    const result: DependencyTrustResult = {
      errors: [],
      warnings: [],
      audited: [],
      passed: true,
    };
    for (const f of sc.findings) {
      const issue = {
        dependency: f.dependency,
        message: "m",
        ...(f.cause ? { cause: f.cause as DependencyTrustCause } : {}),
      };
      (f.severity === "error" ? result.errors : result.warnings).push(issue);
    }
    assertEquals(factorOf(result).earnedPoints, sc.earnedPoints);
  });
}
