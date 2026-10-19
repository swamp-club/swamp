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
  type Fetcher,
} from "./extension_dependency_trust_checker.ts";

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
  expect: { severity: string; message: string; cause?: string }[];
  /** The scorecard's wording of the same finding, where it differs. */
  scorecardMessage?: string;
}

const vectors = JSON.parse(await Deno.readTextFile(VECTORS_PATH)) as {
  resolution: ResolutionVector[];
  findings: FindingVector[];
};

function lockOf(versions: string[] | undefined) {
  if (!versions) return undefined;
  const lock: LockedDependencyVersions = {
    source: "deno.lock",
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
      lockOf(v.locked),
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
    }));
    assertEquals(reported, v.expect);
  });
}
