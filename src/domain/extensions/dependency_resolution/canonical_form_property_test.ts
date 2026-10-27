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
  buildDependencyAuditRecordV2,
  canonicalShippedSpecifierIssue,
  parseSpecifier,
} from "@swamp-club/extension-scoring/dependency-audit";
import { canonicalSpecifier } from "./canonical_form.ts";

const versionArb = fc.tuple(
  fc.integer({ min: 0, max: 20 }),
  fc.integer({ min: 0, max: 20 }),
  fc.integer({ min: 0, max: 20 }),
).map(([a, b, c]) => `${a}.${b}.${c}`);
const nameArb = fc.constantFrom("ms", "@scope/pkg", "left-pad");
const writtenArb = fc.oneof(
  fc.constant(null),
  fc.constant("latest"),
  fc.tuple(fc.constantFrom("^", "~", ">=", ""), versionArb).map(([op, v]) =>
    `${op}${v}`
  ),
  versionArb.map((v) => `=${v}`),
  versionArb.map((v) => `v${v}`),
);
const subpathArb = fc.constantFrom("", "/sub", "/a/b.js");

Deno.test("canonicalSpecifier: every pin it ships keeps the canonical form the registry checks", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("npm", "jsr"),
      nameArb,
      writtenArb,
      subpathArb,
      versionArb,
      (registry, rawName, written, subpath, resolved) => {
        const name = registry === "jsr" && !rawName.startsWith("@")
          ? `@s/${rawName}`
          : rawName;
        const specifier = `${registry}:${name}${
          written === null ? "" : `@${written}`
        }${subpath}`;
        const canonical = canonicalSpecifier(specifier, {
          [specifier]: { specifier: `${registry}:${name}@${resolved}` },
        });
        assertEquals(canonical.kind, "pinned");
        if (canonical.kind !== "pinned") return;
        assert(canonical.specifier.endsWith(subpath));
        const parsed = parseSpecifier(canonical.specifier);
        assert(parsed?.version);
        const record = buildDependencyAuditRecordV2({
          bundleFormat: 1,
          imports: [{
            registry: parsed.registry,
            name: parsed.name,
            writtenAs: specifier,
            shipped: { version: parsed.version, from: "registry" },
          }],
          bundles: {},
          unaudited: [],
        });
        assertEquals(
          canonicalShippedSpecifierIssue(canonical.specifier, record),
          null,
        );
      },
    ),
  );
});
