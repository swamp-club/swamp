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
import {
  type DependencyRegistry,
  type LockedDependencyVersions,
  resolveShippedVersion,
  specifierKind,
} from "@swamp-club/extension-scoring/dependency-audit";
import {
  checkDependencyTrust,
  type Fetcher,
} from "./extension_dependency_trust_checker.ts";
import {
  dependencyTrustBlockerCount,
  type DependencyTrustCause,
  type DependencyTrustResult,
  looseSpecifierCount,
  notAuditedCount,
  notAuditedFixes,
} from "@swamp-club/extension-scoring/dependency-audit";
import { composeLocalScore } from "./extension_rubric_scorer.ts";
import type { ExtensionManifest } from "./extension_manifest.ts";
import { computeAnalysisFactors } from "@swamp-club/extension-scoring/rubric";
import vectorsJson from "@swamp-club/extension-scoring/vectors/dependency-audit.json" with {
  type: "json",
};
import {
  auditRecordEntryUsable,
  buildDependencyAuditRecord,
  buildDependencyAuditRecordV2,
  canonicalShippedSpecifierIssue,
} from "@swamp-club/extension-scoring/dependency-audit";

// The vectors @swamp-club/extension-scoring ships: the package's own tests
// run them against the shared evaluator; these run them through push's
// fetching, so its lookups feed the evaluator what the vectors expect.

interface ResolutionVector {
  name: string;
  registry: DependencyRegistry;
  spec: string | null;
  locked?: string[];
  lockedFor?: string;
  installed?: string;
  published: {
    versions: string[];
    distTags: Record<string, string>;
    yanked?: string[];
  };
  expect: { version: string | null; from?: string; kind: string };
}

interface RecordVector {
  name: string;
  source: "written" | "import-map" | "package-json";
  registry: DependencyRegistry;
  package: string;
  spec: string | null;
  locked?: string[];
  lockedFor?: string;
  installed?: string;
  published: { versions: string[]; distTags: Record<string, string> };
  expect: { spec: string | null; version: string; from: string } | null;
}

interface RecordEntryVector {
  name: string;
  entry: {
    registry: string;
    name: string;
    spec: string | null;
    version: string;
  };
  published: string[];
  expect: "use" | "ignore";
}

interface FindingVector {
  name: string;
  registry: DependencyRegistry;
  package: string;
  spec: string | null;
  locked?: string[];
  npm?: Record<string, unknown>;
  npmStatus?: number;
  jsr?: { status: number; body: unknown };
  osv?: { status: number; body: unknown };
  expect: {
    severity: string;
    message: string;
    cause?: string;
    pointsLost: number;
  }[];
}

const vectors = vectorsJson as unknown as {
  resolution: ResolutionVector[];
  record: RecordVector[];
  recordEntries: RecordEntryVector[];
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
      v.installed,
    );
    assertEquals(shipped?.version ?? null, v.expect.version);
    if (v.expect.from) assertEquals(shipped?.from, v.expect.from);
    assertEquals(specifierKind(v.spec), v.expect.kind);
  });
}

for (const v of vectors.record) {
  Deno.test(`dependency audit vectors: records ${v.name}`, () => {
    const specifier = {
      name: v.package,
      version: v.spec,
      registry: v.registry,
      sourceFile: "models/a.ts",
      ...(v.source === "written" ? {} : { importedAs: v.package }),
      ...(v.installed !== undefined ? { installedVersion: v.installed } : {}),
    };
    const shipped = resolveShippedVersion(
      v.registry,
      v.package,
      v.spec,
      lockOf(v.locked, v.lockedFor),
      v.published,
      v.installed,
    );
    const record = buildDependencyAuditRecord(
      shipped ? [{ specifier, shipped }] : [],
    );
    assertEquals(
      record.dependencies,
      v.expect ? [{ registry: v.registry, name: v.package, ...v.expect }] : [],
    );
  });
}

for (const v of vectors.recordEntries) {
  Deno.test(`dependency audit vectors: a record entry whose ${v.name} is ${v.expect}d`, () => {
    const use = auditRecordEntryUsable(v.entry) &&
      v.published.includes(v.entry.version);
    assertEquals(use ? "use" : "ignore", v.expect);
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
      return Promise.resolve(
        Response.json(v.osv?.body ?? { vulns: [] }, {
          status: v.osv?.status ?? 200,
        }),
      );
    }
    if (u.includes("api.npmjs.org/downloads")) {
      return Promise.resolve(Response.json({ downloads: 50_000 }));
    }
    if (u.includes("registry.npmjs.org") && v.npmStatus) {
      return Promise.resolve(
        new Response("unavailable", { status: v.npmStatus }),
      );
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
  const analysis = computeAnalysisFactors({
    entrypointUrls: [],
    readme: null,
    hasLicenseFile: false,
    doc: { version: 1, nodes: {} },
    rawLintOutput: "",
  });
  return composeLocalScore(
    analysis,
    { description: "d", platforms: [] } as unknown as ExtensionManifest,
    {
      dependencyTrustBlockerCount: dependencyTrustBlockerCount(result),
      dependencyNotAuditedCount: notAuditedCount(result),
      dependencyNotAuditedFixes: notAuditedFixes(result),
      dependencyLooseCount: looseSpecifierCount(result),
    },
  ).factors.find((f) => f.id === "dependency-trust")!;
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

for (
  const v of (vectorsJson as unknown as {
    canonical: {
      name: string;
      shipped: string;
      record:
        | { registry: DependencyRegistry; name: string; version: string }[]
        | null;
      expect: "accept" | { cause: string; message: string };
    }[];
  }).canonical
) {
  Deno.test(`dependency audit vectors: push ships ${v.name} only in the canonical form`, () => {
    const record = v.record === null ? null : buildDependencyAuditRecordV2({
      bundleFormat: 1,
      imports: v.record.map((e) => ({
        registry: e.registry,
        name: e.name,
        writtenAs: `${e.registry}:${e.name}@${e.version}`,
        shipped: { version: e.version, from: "exact" },
      })),
      bundles: {},
      unaudited: [],
    });
    const issue = canonicalShippedSpecifierIssue(v.shipped, record);
    assertEquals(
      issue === null ? "accept" : { cause: "not-audited", message: issue },
      v.expect,
    );
  });
}
