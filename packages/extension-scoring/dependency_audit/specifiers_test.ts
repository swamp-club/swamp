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
  isAuditedCodeFile,
  parseSpecifier,
  writtenSpecifiers,
  writtenSpecifiersFromSites,
} from "./specifiers.ts";
import { importedSpecifiersAt } from "../source/imports.ts";

const names = (source: string) =>
  (writtenSpecifiers(source, "models/a.ts") ?? []).map((s) =>
    `${s.registry}:${s.name}@${s.version ?? ""}`
  );

Deno.test("writtenSpecifiers: static, side-effect and dynamic imports and re-exports", () => {
  assertEquals(
    names([
      'import { a } from "npm:left-pad@1.0.0";',
      'import "npm:side@2";',
      'export { b } from "jsr:@std/path@1";',
      'const c = await import("npm:dyn@3");',
    ].join("\n")),
    ["npm:left-pad@1.0.0", "npm:side@2", "jsr:@std/path@1", "npm:dyn@3"],
  );
});

Deno.test("writtenSpecifiers: a commented-out import is not a dependency", () => {
  assertEquals(names('// import a from "npm:left-pad@1.0.0";'), []);
  assertEquals(names('/* import a from "npm:left-pad@1.0.0"; */'), []);
});

Deno.test("writtenSpecifiers: a specifier-shaped string is not a dependency", () => {
  assertEquals(names('export const DEP = "npm:lodash@4.17.20";'), []);
});

Deno.test("writtenSpecifiers: a /* inside a string does not hide the imports after it", () => {
  assertEquals(
    names([
      'const pattern = "src/*";',
      'const lodash = await import("npm:lodash@4.17.21");',
    ].join("\n")),
    ["npm:lodash@4.17.21"],
  );
});

Deno.test("writtenSpecifiers: zod is excluded, an unscoped jsr: name is kept for the audit to refuse", () => {
  assertEquals(
    names('import { z } from "npm:zod@4";\nimport x from "jsr:foo@1";'),
    ["jsr:foo@1"],
  );
});

Deno.test("parseSpecifier: a subpath is dropped", () => {
  assertEquals(parseSpecifier("npm:@scope/pkg@1.2.3/sub/path"), {
    name: "@scope/pkg",
    version: "1.2.3",
    registry: "npm",
  });
  assertEquals(parseSpecifier("jsr:@std/path@1/posix"), {
    name: "@std/path",
    version: "1",
    registry: "jsr",
  });
  assertEquals(parseSpecifier("https://example.com/x.ts"), null);
});

Deno.test("isAuditedCodeFile: code modules count, tests do not", () => {
  for (const path of ["models/a.ts", "lib/b.mjs", "_shared/c.tsx", "x.js"]) {
    assertEquals(isAuditedCodeFile(path), true, path);
  }
  for (
    const path of [
      "models/a_test.ts",
      "models/a.test.ts",
      "README.md",
      "a.json",
    ]
  ) {
    assertEquals(isAuditedCodeFile(path), false, path);
  }
});

Deno.test("writtenSpecifiers: null for a module that does not parse", () => {
  assertEquals(
    writtenSpecifiers(
      'import a from "npm:left-pad@1.0.0";\nexport const broken = ;\n',
      "models/a.ts",
    ),
    null,
  );
});

Deno.test("writtenSpecifiersFromSites: reads the sites a scan found, null when it found none", () => {
  const source = [
    'import a from "npm:a@1.0.0";',
    'import "./local.ts";',
    'const b = await import("jsr:@s/b@2");',
    'import again from "npm:a@1.0.0";',
  ].join("\n");
  const sites = importedSpecifiersAt(source, { path: "models/a.ts" });
  assertEquals(
    writtenSpecifiersFromSites(sites, "models/a.ts"),
    writtenSpecifiers(source, "models/a.ts"),
  );
  assertEquals(
    writtenSpecifiersFromSites(sites, "models/a.ts")?.map((s) => s.name),
    ["a", "@s/b"],
  );
  assertEquals(writtenSpecifiersFromSites(null, "models/a.ts"), null);
});
