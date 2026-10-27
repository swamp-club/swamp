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

import { assertEquals, assertThrows } from "@std/assert";
import { UserError } from "../../errors.ts";
import { applySpecifierRewrites } from "../source_archive_plan.ts";
import {
  canonicalImportRewrites,
  canonicalSpecifier,
  canonicalTarget,
} from "./canonical_form.ts";
import type { PackageVersions } from "./package_versions.ts";

const VERSIONS: PackageVersions = {
  "npm:ms@^2": { specifier: "npm:ms@2.1.3" },
  "npm:@scope/pkg@~1.0.0": { specifier: "npm:@scope/pkg@1.0.4" },
  "jsr:@std/assert@^1/equals": { specifier: "jsr:@std/assert@1.0.19" },
  "npm:dt@latest": { specifier: "npm:dt@3.0.0" },
  "npm:unpinned": { specifier: "npm:unpinned@0.4.0" },
  "npm:installed@^1": { specifier: "npm:installed@1.0.0", installed: true },
};

function pinned(specifier: string): string | undefined {
  const c = canonicalSpecifier(specifier, VERSIONS);
  return c.kind === "pinned" ? c.specifier : c.kind;
}

Deno.test("canonicalSpecifier: a range, dist-tag or unpinned import pins to the graph's version", () => {
  assertEquals(pinned("npm:ms@^2"), "npm:ms@2.1.3");
  assertEquals(pinned("npm:@scope/pkg@~1.0.0"), "npm:@scope/pkg@1.0.4");
  assertEquals(pinned("npm:dt@latest"), "npm:dt@3.0.0");
  assertEquals(pinned("npm:unpinned"), "npm:unpinned@0.4.0");
  assertEquals(pinned("npm:installed@^1"), "npm:installed@1.0.0");
});

Deno.test("canonicalSpecifier: a subpath is kept after the pin", () => {
  assertEquals(pinned("npm:ms@^2/package.json"), "npm:ms@2.1.3/package.json");
  assertEquals(
    pinned("jsr:@std/assert@^1/equals"),
    "jsr:@std/assert@1.0.19/equals",
  );
});

Deno.test("canonicalSpecifier: an exact pin in any spelling ships as plain semver", () => {
  assertEquals(pinned("npm:ms@2.1.3"), "npm:ms@2.1.3");
  assertEquals(pinned("npm:ms@=2.1.3"), "npm:ms@2.1.3");
  assertEquals(pinned("npm:ms@v2.1.3"), "npm:ms@2.1.3");
  assertEquals(pinned("npm:/ms@2.1.3/sub"), "npm:ms@2.1.3/sub");
});

Deno.test("canonicalSpecifier: zod and anything but npm: and jsr: are outside the rule", () => {
  assertEquals(pinned("npm:zod@4"), "outside");
  assertEquals(pinned("npm:zod@^4/mini"), "outside");
  assertEquals(pinned("./local.ts"), "outside");
  assertEquals(pinned("node:fs"), "outside");
  assertEquals(pinned("https://example.com/x.ts"), "outside");
});

Deno.test("canonicalSpecifier: a range the graph has no answer for is unresolved", () => {
  assertEquals(pinned("npm:other@^1"), "unresolved");
});

Deno.test("canonicalTarget: pins an import-map target and throws a UserError naming one it cannot", () => {
  assertEquals(canonicalTarget("npm:ms@^2", VERSIONS, "m.ts"), "npm:ms@2.1.3");
  assertEquals(canonicalTarget("node:fs", VERSIONS, "m.ts"), "node:fs");
  const error = assertThrows(
    () => canonicalTarget("npm:other@^1", VERSIONS, "models/m.ts"),
    UserError,
  );
  assertEquals(error.message.includes('"npm:other@^1"'), true);
  assertEquals(error.message.includes("models/m.ts"), true);
});

Deno.test("canonicalImportRewrites: pins every site kind and leaves canonical ones alone", () => {
  const source = [
    'import ms from "npm:ms@^2";',
    'import type { T } from "npm:@scope/pkg@~1.0.0";',
    'import "npm:dt@latest";',
    'export * from "jsr:@std/assert@^1/equals";',
    'export { x } from "npm:unpinned";',
    'const lazy = await import("npm:ms@^2/package.json");',
    'import pinned from "npm:ms@2.1.3";',
    'import z from "npm:zod@4";',
    'const text = "npm:ms@^2";',
    '// import x from "npm:ms@^2";',
    "",
  ].join("\n");
  const rewrites = canonicalImportRewrites(source, "m.ts", VERSIONS);
  assertEquals(
    applySpecifierRewrites(source, rewrites),
    [
      'import ms from "npm:ms@2.1.3";',
      'import type { T } from "npm:@scope/pkg@1.0.4";',
      'import "npm:dt@3.0.0";',
      'export * from "jsr:@std/assert@1.0.19/equals";',
      'export { x } from "npm:unpinned@0.4.0";',
      'const lazy = await import("npm:ms@2.1.3/package.json");',
      'import pinned from "npm:ms@2.1.3";',
      'import z from "npm:zod@4";',
      'const text = "npm:ms@^2";',
      '// import x from "npm:ms@^2";',
      "",
    ].join("\n"),
  );
});

Deno.test("canonicalImportRewrites: a site the graph has no answer for refuses the push", () => {
  assertThrows(
    () =>
      canonicalImportRewrites('import x from "npm:other@^1";\n', "m.ts", {}),
    UserError,
  );
});
