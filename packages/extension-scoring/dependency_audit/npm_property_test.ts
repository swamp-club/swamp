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
import fc from "fast-check";
import { compactNpmPackument, factsFor, parseNpmPackument } from "./npm.ts";

const versionArb = fc.tuple(
  fc.integer({ min: 0, max: 3 }),
  fc.integer({ min: 0, max: 3 }),
  fc.integer({ min: 0, max: 3 }),
).map(([a, b, c]) => `${a}.${b}.${c}`);

const manifestArb = fc.record({
  license: fc.oneof(
    fc.constantFrom("MIT", "GPL-3.0", ""),
    fc.record({ type: fc.constantFrom("MIT", "ISC") }),
    fc.integer(),
  ),
  deprecated: fc.oneof(fc.constantFrom("use b", ""), fc.boolean()),
  maintainers: fc.oneof(
    fc.array(fc.record({ name: fc.string(), email: fc.string() }), {
      maxLength: 4,
    }),
    fc.string(),
  ),
  readme: fc.string(),
  dependencies: fc.dictionary(fc.string(), fc.string()),
}, { requiredKeys: [] });

const bodyArb = fc.record({
  versions: fc.dictionary(versionArb, manifestArb, { maxKeys: 8 }),
  tags: fc.dictionary(fc.constantFrom("latest", "next"), versionArb),
  level: manifestArb,
  modified: fc.option(fc.constant("2025-01-01T00:00:00.000Z")),
  downloads: fc.option(fc.nat()),
});

Deno.test("compactNpmPackument: every fact the audit reads survives the cache's JSON round trip", () => {
  fc.assert(
    fc.property(bodyArb, versionArb, (b, extra) => {
      const packument = parseNpmPackument(
        {
          ...b.level,
          "dist-tags": b.tags,
          versions: b.versions,
          ...(b.modified === null ? {} : { time: { modified: b.modified } }),
        },
        b.downloads === null ? null : { downloads: b.downloads },
      );
      const cached = JSON.parse(
        JSON.stringify(compactNpmPackument(packument)),
      );
      assertEquals(cached.publishedVersions, packument.publishedVersions);
      assertEquals(cached.distTags, packument.distTags);
      for (const version of [...packument.publishedVersions, extra]) {
        assertEquals(
          factsFor(cached, version),
          factsFor(packument, version),
        );
      }
    }),
  );
});
