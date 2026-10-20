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
  exactVersion,
  type LockedDependencyVersions,
  type PublishedPackage,
  resolveShippedVersion,
  specifierKind,
  suggestVersion,
} from "./dependency_version_resolution.ts";

const NPM: PublishedPackage = {
  versions: ["1.0.0", "1.2.0", "1.2.5", "2.0.0", "2.1.0-beta.1"],
  distTags: { latest: "2.0.0", next: "2.1.0-beta.1" },
};

function lockOf(versions: string[]): LockedDependencyVersions {
  return {
    source: "deno.lock",
    resolvedFor: () => undefined,
    versionsFor: () => versions,
  };
}

Deno.test("exactVersion: a plain, = or v version is exact", () => {
  assertEquals(exactVersion("1.2.3"), "1.2.3");
  assertEquals(exactVersion("=1.2.3"), "1.2.3");
  assertEquals(exactVersion("v1.2.3"), "1.2.3");
  assertEquals(exactVersion("^1.2.3"), null);
  assertEquals(exactVersion(null), null);
});

Deno.test("specifierKind: classifies each pin style", () => {
  assertEquals(specifierKind(null), "unpinned");
  assertEquals(specifierKind("1.2.3"), "exact");
  assertEquals(specifierKind("^1.2"), "range");
  assertEquals(specifierKind("~1.2.0"), "range");
  assertEquals(specifierKind("1"), "range");
  assertEquals(specifierKind("next"), "dist-tag");
});

Deno.test("resolveShippedVersion: an exact pin needs neither lock nor registry", () => {
  assertEquals(
    resolveShippedVersion("npm", "x", "=1.0.0", lockOf(["1.2.0"]), null),
    { version: "1.0.0", from: "exact" },
  );
});

Deno.test("resolveShippedVersion: the lock's highest satisfying version wins", () => {
  assertEquals(
    resolveShippedVersion(
      "npm",
      "x",
      "^1.0.0",
      lockOf(["1.0.0", "1.2.0", "2.0.0"]),
      NPM,
    ),
    { version: "1.2.0", from: "lockfile" },
  );
});

Deno.test("resolveShippedVersion: unpinned takes the lock's version when it has one", () => {
  assertEquals(
    resolveShippedVersion("npm", "x", null, lockOf(["1.2.0"]), NPM),
    { version: "1.2.0", from: "lockfile" },
  );
});

Deno.test("resolveShippedVersion: a stale lock falls through to the registry", () => {
  assertEquals(
    resolveShippedVersion("npm", "x", "^1.2.1", lockOf(["1.0.0"]), NPM),
    { version: "1.2.5", from: "registry" },
  );
});

Deno.test("resolveShippedVersion: a dist-tag ignores the lock", () => {
  assertEquals(
    resolveShippedVersion("npm", "x", "next", lockOf(["1.2.0"]), NPM),
    { version: "2.1.0-beta.1", from: "registry" },
  );
});

Deno.test("resolveShippedVersion: npm ranges resolve to the highest release", () => {
  assertEquals(
    resolveShippedVersion("npm", "x", "^1.0.0", undefined, NPM)?.version,
    "1.2.5",
  );
  assertEquals(
    resolveShippedVersion("npm", "x", "~1.2.0", undefined, NPM)?.version,
    "1.2.5",
  );
  assertEquals(
    resolveShippedVersion("npm", "x", null, undefined, NPM)?.version,
    "2.0.0",
  );
});

Deno.test("resolveShippedVersion: nothing resolves without registry data", () => {
  assertEquals(
    resolveShippedVersion("npm", "x", "^1.0.0", undefined, null),
    null,
  );
  assertEquals(
    resolveShippedVersion("npm", "x", "^9.0.0", undefined, NPM),
    null,
  );
});

Deno.test("resolveShippedVersion: JSR prefers a version that is not yanked", () => {
  const jsr: PublishedPackage = {
    versions: ["1.0.0", "1.0.1", "1.1.0-rc.1"],
    distTags: { latest: "1.0.0" },
    yanked: new Set(["1.0.1"]),
  };
  assertEquals(
    resolveShippedVersion("jsr", "@s/p", "^1.0.0", undefined, jsr),
    { version: "1.0.0", from: "registry" },
  );
  assertEquals(
    resolveShippedVersion("jsr", "@s/p", "~1.0.1", undefined, jsr),
    { version: "1.0.1", from: "registry" },
  );
  assertEquals(
    resolveShippedVersion("jsr", "@s/p", null, undefined, jsr),
    { version: "1.0.0", from: "registry" },
  );
});

Deno.test("resolveShippedVersion: the lock's entry for the specifier beats a higher transitive copy", () => {
  const lock: LockedDependencyVersions = {
    source: "deno.lock",
    resolvedFor: (_r, _n, spec) => spec === "^1.0.0" ? "1.0.0" : undefined,
    versionsFor: () => ["1.0.0", "1.2.0"],
  };
  assertEquals(
    resolveShippedVersion("npm", "x", "^1.0.0", lock, NPM),
    { version: "1.0.0", from: "lockfile" },
  );
  // A specifier the lock does not record takes the highest locked match.
  assertEquals(
    resolveShippedVersion("npm", "x", "~1.2.0", lock, NPM),
    { version: "1.2.0", from: "lockfile" },
  );
});

Deno.test("suggestVersion: prefers the newest in the same major", () => {
  assertEquals(
    suggestVersion(
      "1.2.0",
      ["1.2.0", "1.3.0", "1.4.1", "2.0.0"],
      new Set(["1.2.0", "1.4.1"]),
    ),
    "1.3.0",
  );
});

Deno.test("suggestVersion: a 0.x version stays on its minor", () => {
  assertEquals(
    suggestVersion(
      "0.225.0",
      ["0.224.5", "0.225.0", "0.225.3", "0.226.0"],
      new Set(["0.225.0"]),
    ),
    "0.225.3",
  );
});

Deno.test("suggestVersion: falls back to the newest overall", () => {
  assertEquals(
    suggestVersion("1.0.0", ["1.0.0", "0.9.0", "2.0.0"], new Set(["1.0.0"])),
    "2.0.0",
  );
});

Deno.test("suggestVersion: skips excluded, prerelease and unparsable versions", () => {
  assertEquals(
    suggestVersion(
      "1.0.0",
      ["1.0.0", "1.1.0-rc.1", "1.2.0", "not a version\u202e", "1.3.0"],
      new Set(["1.2.0"]),
    ),
    "1.3.0",
  );
});

Deno.test("suggestVersion: null when nothing else qualifies", () => {
  assertEquals(suggestVersion("1.0.0", ["1.0.0"], new Set()), null);
  assertEquals(suggestVersion("1.0.0", [], new Set()), null);
});
