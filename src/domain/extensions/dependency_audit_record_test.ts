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
  DEPENDENCY_AUDIT_RECORD_FILENAME,
  serializeDependencyAuditRecord,
  type ShippedDependency,
} from "./dependency_audit_record.ts";
import type { DependencySpecifier } from "./extension_dependency_extractor.ts";

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
