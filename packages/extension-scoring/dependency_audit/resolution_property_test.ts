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

import { assert } from "@std/assert";
import { parse, parseRange, satisfies } from "@std/semver";
import fc from "fast-check";
import {
  type LockedDependencyVersions,
  resolveShippedVersion,
  suggestVersion,
} from "./resolution.ts";

const versionArb = fc.tuple(
  fc.integer({ min: 0, max: 3 }),
  fc.integer({ min: 0, max: 3 }),
  fc.integer({ min: 0, max: 3 }),
).map(([a, b, c]) => `${a}.${b}.${c}`);
const rangeArb = fc.tuple(
  fc.constantFrom("^", "~", ">=", ""),
  versionArb,
).map(([op, v]) => `${op}${v}`);
const versionsArb = fc.uniqueArray(versionArb, { maxLength: 8 });

Deno.test("resolveShippedVersion: a resolved range version satisfies the range and is locked or published", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("npm" as const, "jsr" as const),
      rangeArb,
      versionsArb,
      versionsArb,
      versionsArb,
      (registry, spec, locked, published, yanked) => {
        const lock: LockedDependencyVersions = {
          source: "deno.lock",
          resolvedFor: () => undefined,
          versionsFor: () => locked,
        };
        const shipped = resolveShippedVersion(registry, "p", spec, lock, {
          versions: published,
          distTags: {},
          yanked: new Set(yanked.filter((v) => published.includes(v))),
        });
        if (shipped === null || shipped.from === "exact") return;
        assert(satisfies(parse(shipped.version), parseRange(spec)));
        assert(
          shipped.from === "lockfile"
            ? locked.includes(shipped.version)
            : published.includes(shipped.version),
        );
      },
    ),
  );
});

Deno.test("suggestVersion: a suggestion is stable, published, not excluded and not the shipped version", () => {
  fc.assert(
    fc.property(
      versionArb,
      fc.uniqueArray(
        fc.oneof(versionArb, versionArb.map((v) => `${v}-rc.1`)),
        { maxLength: 10 },
      ),
      versionsArb,
      (shipped, candidates, excluded) => {
        const suggested = suggestVersion(
          shipped,
          candidates,
          new Set(excluded),
        );
        if (suggested === null) return;
        assert(candidates.includes(suggested));
        assert(!excluded.includes(suggested));
        assert(suggested !== shipped);
        assert(parse(suggested).prerelease?.length === 0);
      },
    ),
  );
});
