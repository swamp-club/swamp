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
import vectors from "./dependency_audit.json" with { type: "json" };
import {
  auditRecordEntryUsable,
  buildDependencyAuditRecord,
  buildDependencyAuditRecordV2,
  canonicalRecordedVersions,
  canonicalShippedSpecifierIssue,
  type DependencyRegistry,
  type DependencySpecifier,
  dependencyTrustEarnedPoints,
  evaluateJsrPackage,
  evaluateNpmPackage,
  type JsrLookup,
  jsrNameValid,
  type LockedDependencyVersions,
  type Lookup,
  type NpmLookup,
  npmNameValid,
  type OsvVulnerability,
  parseDependencyAuditRecord,
  parseDependencyAuditRecordV2,
  parseJsrMeta,
  parseNpmPackument,
  parseOsvResponse,
  planNpmPackage,
  pushResult,
  resolveShippedVersion,
  scorecardResult,
  serializeDependencyAuditRecordV2,
  type ShippedImport,
  type SpecifierAudit,
  specifierKind,
  type UnauditedDependency,
  withUnauditedCode,
  writtenSpecifiers,
} from "../dependency_audit/mod.ts";

// The registry's path through the shared evaluator: no fetching, the
// answers each vector gives handed straight to it.

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
  scorecard: {
    findings: { list: string; message: string; cause?: string }[];
    earnedPoints: number;
  };
}

function lockOf(
  versions: string[] | undefined,
  lockedFor?: string,
): LockedDependencyVersions | undefined {
  if (!versions) return undefined;
  return {
    source: "deno.lock",
    resolvedFor: () => lockedFor,
    versionsFor: () => versions,
  };
}

function audit(v: FindingVector): {
  spec: DependencySpecifier;
  audit: SpecifierAudit;
} {
  const spec: DependencySpecifier = {
    name: v.package,
    version: v.spec,
    registry: v.registry,
    sourceFile: "model.ts",
  };
  const lock = lockOf(v.locked);
  if (v.registry === "jsr") {
    const jsr = v.jsr!;
    const meta: JsrLookup = !jsrNameValid(v.package)
      ? { kind: "invalid-name" }
      : jsr.status === 404
      ? { kind: "missing" }
      : jsr.status !== 200
      ? { kind: "unavailable", reason: `HTTP ${jsr.status}` }
      : parseJsrMeta(jsr.body);
    return {
      spec,
      audit: evaluateJsrPackage(v.package, [spec], meta, lock)[0],
    };
  }
  const npm: NpmLookup = !npmNameValid(v.package)
    ? { kind: "invalid-name" }
    : v.npmStatus
    ? { kind: "unavailable", reason: `HTTP ${v.npmStatus}` }
    : !v.npm
    ? { kind: "unavailable", reason: "HTTP 404" }
    : {
      kind: "found",
      value: parseNpmPackument(
        { ...v.npm, time: { modified: new Date().toISOString() } },
        { downloads: 50_000 },
      ),
    };
  const plan = planNpmPackage(v.package, [spec], npm, lock);
  const osv = new Map<string, Lookup<OsvVulnerability[]>>();
  for (const version of plan.osvVersions) {
    const status = v.osv?.status ?? 200;
    try {
      osv.set(
        version,
        status === 200
          ? {
            kind: "found",
            value: parseOsvResponse(v.osv?.body ?? { vulns: [] }),
          }
          : { kind: "unavailable", reason: `HTTP ${status}` },
      );
    } catch (error) {
      osv.set(version, {
        kind: "unavailable",
        reason: (error as Error).message,
      });
    }
  }
  return {
    spec,
    audit: evaluateNpmPackage(
      v.package,
      [spec],
      npm,
      plan,
      osv,
      new Date(),
      lock,
    )[0],
  };
}

for (const v of vectors.findings as FindingVector[]) {
  Deno.test(`dependency audit vectors: reports ${v.name}`, () => {
    const entries = [audit(v)];
    const push = pushResult(entries);
    const reported = [
      ...push.errors.map((e) => ({ severity: "error", ...e })),
      ...push.warnings.map((w) => ({ severity: "warning", ...w })),
    ].map(({ severity, message, cause }) => ({
      severity,
      message,
      ...(cause ? { cause } : {}),
    }));
    assertEquals(
      reported,
      v.expect.map(({ severity, message, cause }) => ({
        severity,
        message,
        ...(cause ? { cause } : {}),
      })),
    );

    const scorecard = scorecardResult(entries);
    assertEquals(
      [
        ...scorecard.blockers.map((b) => ({
          list: "blockers",
          message: b.reason,
          ...(b.cause ? { cause: b.cause } : {}),
        })),
        ...scorecard.warnings.map((w) => ({
          list: "warnings",
          message: w.reason,
          ...(w.cause ? { cause: w.cause } : {}),
        })),
        ...scorecard.notAudited.map((n) => ({
          list: "notAudited",
          message: n.reason,
        })),
      ],
      v.scorecard.findings,
    );
    assertEquals(scorecard.earnedPoints, v.scorecard.earnedPoints);
    // each finding costs what the vector says, and the factor what the worst costs
    assertEquals(
      scorecard.earnedPoints,
      2 - Math.max(0, ...v.expect.map((f) => f.pointsLost)),
    );
  });
}

interface Published {
  versions: string[];
  distTags: Record<string, string>;
  yanked?: string[];
}

const resolution = vectors.resolution as unknown as {
  name: string;
  registry: string;
  spec: string | null;
  locked?: string[];
  lockedFor?: string;
  installed?: string;
  published: Published;
  expect: { version: string | null; from?: string; kind: string };
}[];

const records = vectors.record as unknown as {
  name: string;
  source: string;
  registry: string;
  package: string;
  spec: string | null;
  locked?: string[];
  lockedFor?: string;
  installed?: string;
  published: Published;
  expect: { spec: string | null; version: string; from: string } | null;
}[];

for (const v of resolution) {
  Deno.test(`dependency audit vectors: resolves ${v.name}`, () => {
    const shipped = resolveShippedVersion(
      v.registry as DependencyRegistry,
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

for (const v of records) {
  Deno.test(`dependency audit vectors: records ${v.name} and reads it back`, () => {
    const registry = v.registry as DependencyRegistry;
    const specifier: DependencySpecifier = {
      name: v.package,
      version: v.spec,
      registry,
      sourceFile: "models/a.ts",
      ...(v.source === "written" ? {} : { importedAs: v.package }),
      ...(v.installed !== undefined ? { installedVersion: v.installed } : {}),
    };
    const shipped = resolveShippedVersion(
      registry,
      v.package,
      v.spec,
      lockOf(v.locked, v.lockedFor),
      { versions: v.published.versions, distTags: v.published.distTags },
      v.installed,
    );
    const record = buildDependencyAuditRecord(
      shipped ? [{ specifier, shipped }] : [],
    );
    assertEquals(
      record.dependencies,
      v.expect ? [{ registry, name: v.package, ...v.expect }] : [],
    );
    if (!v.expect) return;
    const read = parseDependencyAuditRecord(JSON.stringify(record));
    assertEquals(
      read?.recordedFor(registry, v.package, v.expect.spec)?.version,
      v.expect.version,
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

const scoring = vectors.scoring as {
  name: string;
  findings: { severity: string; cause?: string }[];
  earnedPoints: number;
}[];

for (const sc of scoring) {
  Deno.test(`dependency audit vectors: scores ${sc.name}`, () => {
    const costs = (f: { severity: string; cause?: string }) =>
      f.severity === "error" ||
      ["not-audited", "deprecated-version", "jsr-yanked"].includes(
        f.cause ?? "",
      );
    assertEquals(
      dependencyTrustEarnedPoints({
        blockerCount: sc.findings.filter((f) =>
          costs(f) && f.cause !== "not-audited"
        ).length,
        notAuditedCount: sc.findings.filter((f) => f.cause === "not-audited")
          .length,
        looseCount: sc.findings.filter((f) => f.cause === "loose-specifier")
          .length,
      }),
      sc.earnedPoints,
    );
  });
}

const written = vectors.written as {
  name: string;
  path: string;
  source: string;
  expect:
    | { registry: DependencyRegistry; name: string; version: string }[]
    | null;
}[];

for (const w of written) {
  Deno.test(`dependency audit vectors: reads ${w.name}`, () => {
    assertEquals(
      writtenSpecifiers(w.source, w.path)?.map((
        { registry, name, version },
      ) => ({
        registry,
        name,
        version,
      })) ?? null,
      w.expect,
    );
  });
}

interface RecordV2Vector {
  name: string;
  imports: ShippedImport[];
  bundles?: Record<string, string>;
  unaudited?: UnauditedDependency[];
  expect: {
    bundles?: Record<string, string>;
    dependencies: unknown[];
    unaudited?: UnauditedDependency[];
  };
}

for (const v of vectors.recordV2 as RecordV2Vector[]) {
  Deno.test(`dependency audit vectors: records v2 ${v.name} and reads it back`, () => {
    const record = buildDependencyAuditRecordV2({
      bundleFormat: 1,
      imports: v.imports,
      bundles: v.bundles ?? {},
      unaudited: v.unaudited ?? [],
    });
    assertEquals(record.dependencies, v.expect.dependencies);
    assertEquals(record.bundles, v.expect.bundles ?? {});
    assertEquals(record.unaudited, v.expect.unaudited ?? []);
    const text = serializeDependencyAuditRecordV2(record);
    assertEquals(parseDependencyAuditRecordV2(text), record);
    // a reader that knows only v1 reads it as no record
    assertEquals(parseDependencyAuditRecord(text), null);
  });
}

interface CanonicalVector {
  name: string;
  shipped: string;
  record:
    | { registry: DependencyRegistry; name: string; version: string }[]
    | null;
  expect: "accept" | { cause: "not-audited"; message: string };
}

for (const v of vectors.canonical as CanonicalVector[]) {
  Deno.test(`dependency audit vectors: canonical form, ${v.name}`, () => {
    const record = v.record === null ? null : {
      dependencies: v.record.map((e) => ({
        ...e,
        spec: e.version,
        from: "exact" as const,
        locked: false,
        writtenAs: [],
      })),
    };
    const issue = canonicalShippedSpecifierIssue(v.shipped, record);
    assertEquals(
      issue === null ? "accept" : { cause: "not-audited", message: issue },
      v.expect,
    );
  });
}

interface CanonicalScoringVector {
  name: string;
  path: string;
  source: string;
  locked?: string[];
  record: unknown;
  expect: {
    blockers: unknown[];
    warnings: unknown[];
    notAudited: unknown[];
    earnedPoints: number;
  };
}

const canonicalRegistry = vectors.canonicalRegistry as {
  npm: Record<string, Record<string, unknown>>;
  jsr: Record<string, unknown>;
};

/** The registry's path for a v2 archive: the record decides each version. */
function scoreV2Archive(v: CanonicalScoringVector) {
  const record = parseDependencyAuditRecordV2(JSON.stringify(v.record))!;
  const recorded = canonicalRecordedVersions(record);
  const lock = lockOf(v.locked);
  const audits: { spec: DependencySpecifier; audit: SpecifierAudit }[] = [];
  for (const written of writtenSpecifiers(v.source, v.path) ?? []) {
    const spec: DependencySpecifier = { ...written, sourceFile: v.path };
    if (spec.registry === "jsr") {
      const body = canonicalRegistry.jsr[spec.name];
      const meta: JsrLookup = body ? parseJsrMeta(body) : { kind: "missing" };
      audits.push({
        spec,
        audit: evaluateJsrPackage(spec.name, [spec], meta, lock, recorded)[0],
      });
      continue;
    }
    const packument = canonicalRegistry.npm[spec.name];
    const npm: NpmLookup = packument
      ? {
        kind: "found",
        value: parseNpmPackument(
          { ...packument, time: { modified: new Date().toISOString() } },
          { downloads: 50_000 },
        ),
      }
      : { kind: "unavailable", reason: "HTTP 404" };
    const plan = planNpmPackage(spec.name, [spec], npm, lock, recorded);
    const osv = new Map<string, Lookup<OsvVulnerability[]>>(
      plan.osvVersions.map((version) => [version, {
        kind: "found",
        value: [],
      }]),
    );
    audits.push({
      spec,
      audit: evaluateNpmPackage(
        spec.name,
        [spec],
        npm,
        plan,
        osv,
        new Date(),
        lock,
      )[0],
    });
  }
  return scorecardResult(audits, [], record.unaudited);
}

for (const v of vectors.canonicalScoring as CanonicalScoringVector[]) {
  Deno.test(`dependency audit vectors: scores a v2 archive, ${v.name}`, () => {
    const result = scoreV2Archive(v);
    assertEquals(
      {
        blockers: result.blockers,
        warnings: result.warnings,
        notAudited: result.notAudited,
        earnedPoints: result.earnedPoints,
      },
      v.expect,
    );
  });
}

for (
  const v of vectors.unauditedCode as {
    name: string;
    unaudited: UnauditedDependency[];
    expect: unknown[];
    earnedPoints: number;
  }[]
) {
  Deno.test(`dependency audit vectors: push and quality charge ${v.name}`, () => {
    const result = withUnauditedCode(
      { errors: [], warnings: [], audited: [], passed: true },
      v.unaudited,
    );
    assertEquals(result.warnings, v.expect);
    assertEquals(
      dependencyTrustEarnedPoints({
        blockerCount: 0,
        notAuditedCount: new Set(result.warnings.map((w) => w.dependency))
          .size,
        looseCount: 0,
      }),
      v.earnedPoints,
    );
  });
}
