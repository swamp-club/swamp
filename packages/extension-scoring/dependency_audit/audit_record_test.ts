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
  auditRecordEntryUsable,
  buildDependencyAuditRecord,
  buildDependencyAuditRecordV2,
  DEFAULT_BUNDLE_FORMAT,
  DEPENDENCY_AUDIT_RECORD_FILENAME,
  parseDependencyAuditRecordV2,
  serializeDependencyAuditRecord,
  serializeDependencyAuditRecordV2,
  type ShippedDependency,
} from "./audit_record.ts";
import type { DependencySpecifier } from "./specifiers.ts";

function spec(
  name: string,
  version: string | null,
  extra: Partial<DependencySpecifier> = {},
): DependencySpecifier {
  return {
    name,
    version,
    registry: "npm",
    sourceFile: "models/a.ts",
    ...extra,
  };
}

Deno.test("DEPENDENCY_AUDIT_RECORD_FILENAME: is dependency-audit.json", () => {
  assertEquals(DEPENDENCY_AUDIT_RECORD_FILENAME, "dependency-audit.json");
});

Deno.test("buildDependencyAuditRecord: an empty audit records no dependencies", () => {
  assertEquals(buildDependencyAuditRecord([]), {
    recordVersion: 1,
    dependencies: [],
  });
});

Deno.test("buildDependencyAuditRecord: keys an installed import by the version the shipped source pins", () => {
  const record = buildDependencyAuditRecord([{
    specifier: spec("ms", "^2.0.0", {
      importedAs: "ms",
      installedVersion: "2.1.3",
    }),
    shipped: { version: "2.1.3", from: "installed" },
  }]);
  assertEquals(record.dependencies, [
    {
      registry: "npm",
      name: "ms",
      spec: "2.1.3",
      version: "2.1.3",
      from: "installed",
    },
  ]);
});

Deno.test("buildDependencyAuditRecord: records each installed copy under one declared range (swamp-club#3793)", () => {
  const record = buildDependencyAuditRecord([
    {
      specifier: spec("ms", "^2.1.0", {
        importedAs: "ms",
        installedVersion: "2.1.3",
      }),
      shipped: { version: "2.1.3", from: "installed" },
    },
    {
      specifier: spec("ms", "^2.1.0", {
        importedAs: "ms",
        installedVersion: "2.1.2",
        sourceFile: "models/b.ts",
      }),
      shipped: { version: "2.1.2", from: "installed" },
    },
  ]);
  assertEquals(record.dependencies, [
    {
      registry: "npm",
      name: "ms",
      spec: "2.1.2",
      version: "2.1.2",
      from: "installed",
    },
    {
      registry: "npm",
      name: "ms",
      spec: "2.1.3",
      version: "2.1.3",
      from: "installed",
    },
  ]);
});

Deno.test("buildDependencyAuditRecord: sorts by registry, name and spec, unpinned first, and keeps one entry per key", () => {
  const shipped: ShippedDependency[] = [
    {
      specifier: spec("zod-like", "^1.0.0"),
      shipped: { version: "1.2.0", from: "registry" },
    },
    {
      specifier: spec("@std/path", "^1.0.0", { registry: "jsr" }),
      shipped: { version: "1.0.5", from: "lockfile" },
    },
    {
      specifier: spec("ms", "~2.1.0"),
      shipped: { version: "2.1.3", from: "lockfile" },
    },
    {
      specifier: spec("ms", null),
      shipped: { version: "2.1.3", from: "registry" },
    },
    {
      specifier: spec("ms", "~2.1.0", { importedAs: "ms" }),
      shipped: { version: "2.1.3", from: "lockfile" },
    },
  ];
  assertEquals(
    buildDependencyAuditRecord(shipped).dependencies.map((e) =>
      `${e.registry}:${e.name}@${e.spec}`
    ),
    [
      "jsr:@std/path@^1.0.0",
      "npm:ms@null",
      "npm:ms@~2.1.0",
      "npm:zod-like@^1.0.0",
    ],
  );
});

Deno.test("buildDependencyAuditRecord: leaves out an entry the registry would ignore", () => {
  const record = buildDependencyAuditRecord([
    {
      specifier: spec("ms", "^2.0.0"),
      shipped: { version: "3.0.0", from: "lockfile" },
    },
    {
      specifier: spec("ms", "2.0.0"),
      shipped: { version: "2.0.0", from: "exact" },
    },
  ]);
  assertEquals(record.dependencies.map((e) => e.spec), ["2.0.0"]);
});

Deno.test("auditRecordEntryUsable: an exact spec in = or v form names its version", () => {
  for (const s of ["=1.2.0", "v1.2.0", "1.2.0"]) {
    assertEquals(
      auditRecordEntryUsable({
        registry: "npm",
        name: "p",
        spec: s,
        version: "1.2.0",
      }),
      true,
    );
  }
});

Deno.test("auditRecordEntryUsable: refuses an empty name", () => {
  assertEquals(
    auditRecordEntryUsable({
      registry: "npm",
      name: "",
      spec: null,
      version: "1.0.0",
    }),
    false,
  );
});

Deno.test("serializeDependencyAuditRecord: writes stable two-space JSON with a trailing newline", () => {
  const text = serializeDependencyAuditRecord({
    recordVersion: 1,
    dependencies: [
      {
        registry: "npm",
        name: "ms",
        spec: null,
        version: "2.1.3",
        from: "registry",
      },
    ],
  });
  assertEquals(
    text,
    '{\n  "recordVersion": 1,\n  "dependencies": [\n    {\n      "registry": "npm",\n      "name": "ms",\n      "spec": null,\n      "version": "2.1.3",\n      "from": "registry"\n    }\n  ]\n}\n',
  );
});

function v2Body(extra: Record<string, unknown>): string {
  return JSON.stringify({
    recordVersion: 2,
    bundles: { "bundles/m.js": "sha256:00" },
    dependencies: [],
    unaudited: [],
    ...extra,
  });
}

Deno.test("serializeDependencyAuditRecordV2: writes bundleFormat after recordVersion (swamp-club#3972)", () => {
  const text = serializeDependencyAuditRecordV2(
    buildDependencyAuditRecordV2({
      imports: [],
      bundleFormat: 3,
      bundles: {},
      unaudited: [],
    }),
  );
  assertEquals(
    text,
    '{\n  "recordVersion": 2,\n  "bundleFormat": 3,\n  "bundles": {},\n  "dependencies": [],\n  "unaudited": []\n}\n',
  );
  assertEquals(parseDependencyAuditRecordV2(text)?.bundleFormat, 3);
});

Deno.test("parseDependencyAuditRecordV2: a record without bundleFormat reads as the default format", () => {
  assertEquals(DEFAULT_BUNDLE_FORMAT, 1);
  assertEquals(
    parseDependencyAuditRecordV2(v2Body({}))?.bundleFormat,
    DEFAULT_BUNDLE_FORMAT,
  );
});

Deno.test("parseDependencyAuditRecordV2: a bundleFormat that is not a positive integer is no record", () => {
  for (const bundleFormat of [0, -1, 1.5, "1", null, true, Number.MAX_VALUE]) {
    assertEquals(
      parseDependencyAuditRecordV2(v2Body({ bundleFormat })),
      null,
      `bundleFormat ${JSON.stringify(bundleFormat)}`,
    );
  }
});
