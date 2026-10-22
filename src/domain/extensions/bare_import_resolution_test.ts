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
  hasUnresolvedBareImports,
  installedPackageImports,
  isLocalModuleSpecifier,
  NO_BARE_IMPORT_RESOLUTION,
  uniqueBareImports,
  withPackageSpecifiers,
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

Deno.test("bareImportsFromDenoInfo: a bare import Deno resolves into node_modules is unresolved, keeping the installed file, so it is never taken for a placed local module", () => {
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
    {
      importer: path("models", "a.ts"),
      specifier: "ms",
      installedFile: path("node_modules", "ms", "index.js"),
    },
    {
      importer: path("models", "a.ts"),
      specifier: "@/lib.ts",
      target: url("lib", "lib.ts"),
    },
  ]);
});

Deno.test("withPackageSpecifiers: fills only the unresolved imports, from the second read (swamp-club#3612)", () => {
  const a = path("models", "a.ts");
  const first = [
    { importer: a, specifier: "zod" },
    { importer: a, specifier: "ms", target: "npm:ms@2.1.2" },
    { importer: a, specifier: "nothing-maps-this" },
  ];
  assertEquals(hasUnresolvedBareImports(first), true);
  assertEquals(
    withPackageSpecifiers(first, [
      { importer: a, specifier: "zod", target: "npm:zod@4" },
      { importer: a, specifier: "ms", target: "npm:ms@9.9.9" },
      { importer: a, specifier: "nothing-maps-this" },
    ]),
    [
      { importer: a, specifier: "zod", target: "npm:zod@4" },
      { importer: a, specifier: "ms", target: "npm:ms@2.1.2" },
      { importer: a, specifier: "nothing-maps-this" },
    ],
  );
  assertEquals(withPackageSpecifiers(first, []), first);
});

Deno.test("hasUnresolvedBareImports: false when every import has a target", () => {
  assertEquals(
    hasUnresolvedBareImports([
      { importer: path("a.ts"), specifier: "ms", target: "npm:ms@2" },
    ]),
    false,
  );
  assertEquals(hasUnresolvedBareImports([]), false);
});

/** A manifest reader over `manifests`, keyed by package directory. */
function manifestsAt(
  manifests: Record<string, unknown>,
): (dir: string) => Promise<unknown> {
  return (dir) => Promise.resolve(manifests[dir]);
}

const A = path("models", "a.ts");

Deno.test("installedPackageImports: names the installed package at its installed version, with the declared range (swamp-club#3630)", async () => {
  const { resolutions, stale } = await installedPackageImports(
    [
      {
        importer: A,
        specifier: "ms",
        installedFile: path("node_modules", "ms", "index.js"),
      },
      {
        importer: A,
        specifier: "ms/package.json",
        installedFile: path("node_modules", "ms", "package.json"),
      },
      {
        importer: A,
        specifier: "@scope/pkg/sub",
        installedFile: path("node_modules", "@scope", "pkg", "sub", "x.js"),
      },
      { importer: A, specifier: "node-builtin", target: "node:fs" },
    ],
    {
      dependencies: { "ms": "^2.1.0" },
      devDependencies: { "@scope/pkg": "~1.0.0", "ms": "9.9.9" },
    },
    manifestsAt({
      [path("node_modules", "ms")]: { name: "ms", version: "2.1.3" },
      [path("node_modules", "@scope", "pkg")]: {
        name: "@scope/pkg",
        version: "1.0.4",
      },
    }),
  );
  assertEquals(stale, []);
  assertEquals(resolutions.map((r) => [r.specifier, r.target, r.declared]), [
    ["ms", "npm:ms@2.1.3", "npm:ms@^2.1.0"],
    ["ms/package.json", "npm:ms@2.1.3/package.json", "npm:ms@^2.1.0"],
    ["@scope/pkg/sub", "npm:@scope/pkg@1.0.4/sub", "npm:@scope/pkg@~1.0.0"],
    ["node-builtin", "node:fs", undefined],
  ]);
});

Deno.test("installedPackageImports: reads a deno install layout and an npm: alias", async () => {
  const deno = path("node_modules", ".deno", "ms@2.1.3", "node_modules", "ms");
  const { resolutions } = await installedPackageImports(
    [
      { importer: A, specifier: "ms", installedFile: join(deno, "index.js") },
      {
        importer: A,
        specifier: "pad",
        installedFile: path("node_modules", "pad", "index.js"),
      },
    ],
    { dependencies: { "ms": "2.1.3", "pad": "npm:left-pad@^1.3.0" } },
    manifestsAt({
      [deno]: { name: "ms", version: "2.1.3" },
      [path("node_modules", "pad")]: { name: "left-pad", version: "1.3.0" },
    }),
  );
  assertEquals(resolutions.map((r) => [r.target, r.declared]), [
    ["npm:ms@2.1.3", "npm:ms@2.1.3"],
    ["npm:left-pad@1.3.0", "npm:left-pad@^1.3.0"],
  ]);
});

Deno.test("installedPackageImports: an installed package package.json does not declare ships at its installed version, with no declared range", async () => {
  const { resolutions, stale } = await installedPackageImports(
    [{
      importer: A,
      specifier: "debug",
      installedFile: path("node_modules", "debug", "index.js"),
    }],
    { dependencies: {} },
    manifestsAt({
      [path("node_modules", "debug")]: { name: "debug", version: "4.3.4" },
    }),
  );
  assertEquals(stale, []);
  assertEquals(resolutions, [{
    importer: A,
    specifier: "debug",
    target: "npm:debug@4.3.4",
    installedFile: path("node_modules", "debug", "index.js"),
  }]);
});

Deno.test("installedPackageImports: a repo-controlled manifest names nothing it cannot prove", async () => {
  const at = (name: string) => path("node_modules", name);
  const imports = ["quote", "renamed", "range", "upper", "missing"].map((
    name,
  ) => ({
    importer: A,
    specifier: name,
    installedFile: join(at(name), "index.js"),
  }));
  const { resolutions, stale } = await installedPackageImports(
    imports,
    {},
    manifestsAt({
      [at("quote")]: { name: "quote", version: '1.0.0";evil("' },
      [at("renamed")]: { name: "lodash", version: "4.17.21" },
      [at("range")]: { name: "range", version: "^1.0.0" },
      [at("upper")]: { name: "Upper", version: "1.0.0" },
    }),
  );
  assertEquals(stale, []);
  assertEquals(
    resolutions,
    imports.map((r) => ({ importer: r.importer, specifier: r.specifier })),
  );
});

Deno.test("installedPackageImports: a non-registry declaration ships as written", async () => {
  const deps = {
    "a": "file:../a",
    "b": "github:user/b",
    "c": "user/c",
    "d": "workspace:*",
    "e": "https://example.com/e.tgz",
  };
  const imports = Object.keys(deps).map((name) => ({
    importer: A,
    specifier: name,
    installedFile: path("node_modules", name, "index.js"),
  }));
  const manifests: Record<string, unknown> = {};
  for (const name of Object.keys(deps)) {
    manifests[path("node_modules", name)] = { name, version: "1.0.0" };
  }
  const { resolutions, stale } = await installedPackageImports(
    imports,
    { dependencies: deps },
    manifestsAt(manifests),
  );
  assertEquals(stale, []);
  assertEquals(resolutions.every((r) => r.target === undefined), true);
});

Deno.test("installedPackageImports: a declared dependency not installed, or installed outside its range, is stale", async () => {
  const { resolutions, stale } = await installedPackageImports(
    [
      { importer: A, specifier: "is-odd" },
      {
        importer: A,
        specifier: "ms",
        installedFile: path("node_modules", "ms", "index.js"),
      },
      { importer: A, specifier: "not-declared" },
    ],
    { dependencies: { "is-odd": "^3.0.1", "ms": "^3.0.0" } },
    manifestsAt({
      [path("node_modules", "ms")]: { name: "ms", version: "2.1.3" },
    }),
  );
  assertEquals(stale, [
    {
      importer: A,
      specifier: "is-odd",
      packageName: "is-odd",
      declaredRange: "^3.0.1",
    },
    {
      importer: A,
      specifier: "ms",
      packageName: "ms",
      declaredRange: "^3.0.0",
      installedVersion: "2.1.3",
    },
  ]);
  assertEquals(resolutions.every((r) => r.target === undefined), true);
});

Deno.test("installedPackageImports: a dist-tag declaration accepts the installed version", async () => {
  const { resolutions, stale } = await installedPackageImports(
    [{
      importer: A,
      specifier: "ms",
      installedFile: path("node_modules", "ms", "index.js"),
    }],
    { dependencies: { "ms": "latest" } },
    manifestsAt({
      [path("node_modules", "ms")]: { name: "ms", version: "2.1.3" },
    }),
  );
  assertEquals(stale, []);
  assertEquals(resolutions[0].target, "npm:ms@2.1.3");
  assertEquals(resolutions[0].declared, "npm:ms@latest");
});

Deno.test("bareImportResolverFrom: answers the declared specifier only for a resolved import (swamp-club#3630)", () => {
  const resolver = bareImportResolverFrom([
    {
      importer: A,
      specifier: "ms",
      target: "npm:ms@2.1.3",
      declared: "npm:ms@^2.1.0",
    },
    { importer: A, specifier: "x", declared: "npm:x@1" },
  ]);
  assertEquals(resolver.declared?.(A, "ms"), "npm:ms@^2.1.0");
  assertEquals(resolver.declared?.(A, "x"), undefined);
  assertEquals(resolver.declared?.(A, "other"), undefined);
});
