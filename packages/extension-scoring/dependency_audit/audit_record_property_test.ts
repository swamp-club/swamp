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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  auditRecordEntryUsable,
  buildDependencyAuditRecord,
  type ShippedDependency,
} from "./audit_record.ts";
import type { ShippedVersionSource } from "./resolution.ts";

const versionArb = fc.tuple(
  fc.integer({ min: 0, max: 3 }),
  fc.integer({ min: 0, max: 3 }),
  fc.integer({ min: 0, max: 3 }),
).map(([a, b, c]) => `${a}.${b}.${c}`);
const specArb = fc.oneof(
  fc.constant(null),
  fc.constant("latest"),
  fc.tuple(fc.constantFrom("^", "~", ">=", "", "="), versionArb).map((
    [op, v],
  ) => `${op}${v}`),
);
const shippedArb: fc.Arbitrary<ShippedDependency> = fc.record({
  registry: fc.constantFrom("npm" as const, "jsr" as const),
  name: fc.constantFrom("a", "b", "@s/c"),
  spec: specArb,
  installed: fc.option(versionArb, { nil: undefined }),
  version: versionArb,
  from: fc.constantFrom<ShippedVersionSource>(
    "exact",
    "installed",
    "lockfile",
    "registry",
  ),
}).map(({ registry, name, spec, installed, version, from }) => ({
  specifier: {
    registry,
    name,
    version: spec,
    sourceFile: "models/a.ts",
    ...(installed !== undefined ? { installedVersion: installed } : {}),
  },
  shipped: { version, from },
}));

Deno.test("buildDependencyAuditRecord: every entry is usable, unique by key, and in a fixed order", () => {
  fc.assert(
    fc.property(fc.array(shippedArb, { maxLength: 12 }), (shipped) => {
      const { dependencies } = buildDependencyAuditRecord(shipped);
      const keys = dependencies.map((e) =>
        `${e.registry}:${e.name}@${e.spec ?? ""}`
      );
      assertEquals(new Set(keys).size, keys.length);
      for (const entry of dependencies) assert(auditRecordEntryUsable(entry));
      assertEquals(
        buildDependencyAuditRecord([...shipped].reverse()).dependencies.map((
          e,
        ) => `${e.registry}:${e.name}@${e.spec ?? ""}`),
        keys,
      );
    }),
  );
});
