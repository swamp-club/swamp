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
import { join, toFileUrl } from "@std/path";
import {
  bareImportResolverFrom,
  bareImportsFromDenoInfo,
  isLocalModuleSpecifier,
  NO_BARE_IMPORT_RESOLUTION,
  uniqueBareImports,
} from "./bare_import_resolution.ts";

const ROOT = Deno.build.os === "windows" ? "C:\\ext" : "/ext";
const path = (...parts: string[]) => join(ROOT, ...parts);
const url = (...parts: string[]) => toFileUrl(path(...parts)).href;

Deno.test("bareImportsFromDenoInfo: each bare import a local module writes, with Deno's target", () => {
  const found = bareImportsFromDenoInfo({
    modules: [{
      specifier: url("models", "a.ts"),
      dependencies: [
        { specifier: "ms", code: { specifier: "npm:ms@2.1.2" } },
        {
          specifier: "@std/path/posix",
          code: { specifier: "jsr:/@std/path@1/posix" },
        },
        { specifier: "./b.ts", code: { specifier: url("models", "b.ts") } },
        { specifier: "npm:zod@4", code: { specifier: "npm:zod@4" } },
        { specifier: "nope", code: { error: "not in import map" } },
        { specifier: "types-only", type: { specifier: "npm:@types/x@1" } },
        {
          specifier: "both",
          code: { specifier: "npm:both@2" },
          type: { specifier: "npm:@types/both@2" },
        },
        {
          specifier: "code-error",
          code: { error: "x" },
          type: {
            specifier: "npm:@types/code-error@1",
          },
        },
      ],
    }],
  });
  const importer = path("models", "a.ts");
  assertEquals(found, [
    { importer, specifier: "ms", target: "npm:ms@2.1.2" },
    {
      importer,
      specifier: "@std/path/posix",
      target: "jsr:/@std/path@1/posix",
    },
    { importer, specifier: "nope" },
    { importer, specifier: "types-only", target: "npm:@types/x@1" },
    { importer, specifier: "both", target: "npm:both@2" },
    { importer, specifier: "code-error" },
  ]);
});

Deno.test("bareImportsFromDenoInfo: remote and node_modules modules are not the extension's source", () => {
  const found = bareImportsFromDenoInfo({
    modules: [
      {
        specifier: "https://jsr.io/@std/path/1.1.6/mod.ts",
        dependencies: [{ specifier: "x", code: { specifier: "npm:x@1" } }],
      },
      {
        specifier: url("node_modules", "ms", "index.js"),
        dependencies: [{ specifier: "y", code: { specifier: "npm:y@1" } }],
      },
      { specifier: "npm:/ms@2.1.2", dependencies: [] },
    ],
  });
  assertEquals(found, []);
});

Deno.test("bareImportsFromDenoInfo: output without a modules list has no bare imports", () => {
  assertEquals(bareImportsFromDenoInfo(undefined), []);
  assertEquals(bareImportsFromDenoInfo({}), []);
  assertEquals(bareImportsFromDenoInfo({ modules: "x" }), []);
  assertEquals(
    bareImportsFromDenoInfo({ modules: [{ specifier: url("a.ts") }] }),
    [],
  );
});

Deno.test("isLocalModuleSpecifier: a file URL outside node_modules", () => {
  assertEquals(isLocalModuleSpecifier(url("a.ts")), true);
  assertEquals(isLocalModuleSpecifier(url("node_modules", "a.js")), false);
  assertEquals(isLocalModuleSpecifier("https://example.com/a.ts"), false);
  assertEquals(isLocalModuleSpecifier(undefined), false);
});

Deno.test("bareImportResolverFrom: answers per importer, never with another importer's target (swamp-club#3612)", () => {
  const inside = path("extensions", "models", "a.ts");
  const outside = path("lib", "b.ts");
  const resolver = bareImportResolverFrom([
    { importer: inside, specifier: "ms", target: "npm:ms@3.0.0" },
    { importer: outside, specifier: "ms", target: "npm:ms@2.1.3" },
    { importer: outside, specifier: "nope" },
  ]);
  assertEquals(resolver.resolve(inside, "ms"), "npm:ms@3.0.0");
  assertEquals(resolver.resolve(outside, "ms"), "npm:ms@2.1.3");
  assertEquals(resolver.resolve(outside, "nope"), undefined);
  assertEquals(resolver.resolve(inside, "nope"), undefined);
  assertEquals(resolver.resolve(path("other.ts"), "ms"), undefined);
});

Deno.test("bareImportResolverFrom: an importer path is compared resolved", () => {
  const resolver = bareImportResolverFrom([
    { importer: path("models", "a.ts"), specifier: "ms", target: "npm:ms@2" },
  ]);
  assertEquals(
    resolver.resolve(join(ROOT, "models", "..", "models", "a.ts"), "ms"),
    "npm:ms@2",
  );
});

Deno.test("NO_BARE_IMPORT_RESOLUTION: resolves nothing", () => {
  assertEquals(
    NO_BARE_IMPORT_RESOLUTION.resolve(path("a.ts"), "ms"),
    undefined,
  );
});

Deno.test("uniqueBareImports: one entry per importer and specifier, the first kept", () => {
  const a = path("a.ts");
  assertEquals(
    uniqueBareImports([
      { importer: a, specifier: "ms", target: "npm:ms@2" },
      { importer: a, specifier: "ms", target: "npm:ms@3" },
      { importer: path("b.ts"), specifier: "ms", target: "npm:ms@3" },
    ]),
    [
      { importer: a, specifier: "ms", target: "npm:ms@2" },
      { importer: path("b.ts"), specifier: "ms", target: "npm:ms@3" },
    ],
  );
});

Deno.test("bareImportsFromDenoInfo: a bare import Deno resolves into node_modules is unresolved, so it is never taken for a placed local module", () => {
  const found = bareImportsFromDenoInfo({
    modules: [{
      specifier: url("models", "a.ts"),
      dependencies: [{
        specifier: "ms",
        code: { specifier: url("node_modules", "ms", "index.js") },
      }, {
        specifier: "@/lib.ts",
        code: { specifier: url("lib", "lib.ts") },
      }],
    }],
  });
  assertEquals(found, [
    { importer: path("models", "a.ts"), specifier: "ms" },
    {
      importer: path("models", "a.ts"),
      specifier: "@/lib.ts",
      target: url("lib", "lib.ts"),
    },
  ]);
});
