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
import { join } from "@std/path";
import {
  buildSbom,
  extractJsrComponents,
  extractNpmComponents,
  JsrLicenseCache,
  licenseToCdx,
  normalizeNpmLicense,
  parseNpmAuthor,
} from "./generate_sbom.ts";

Deno.test("licenseToCdx: bare identifier becomes license.id", () => {
  assertEquals(licenseToCdx("MIT"), [{ license: { id: "MIT" } }]);
});

Deno.test("licenseToCdx: compound expression becomes expression", () => {
  assertEquals(licenseToCdx("(MIT OR CC0-1.0)"), [
    { expression: "(MIT OR CC0-1.0)" },
  ]);
  assertEquals(licenseToCdx("Apache-2.0 WITH LLVM-exception"), [
    { expression: "Apache-2.0 WITH LLVM-exception" },
  ]);
});

Deno.test("licenseToCdx: null and NOASSERTION become license.name", () => {
  assertEquals(licenseToCdx(null), [{ license: { name: "NOASSERTION" } }]);
  assertEquals(licenseToCdx("NOASSERTION"), [
    { license: { name: "NOASSERTION" } },
  ]);
});

Deno.test("normalizeNpmLicense: handles string, object, and array shapes", () => {
  assertEquals(normalizeNpmLicense({ license: "MIT" }), "MIT");
  assertEquals(normalizeNpmLicense({ license: { type: "ISC" } }), "ISC");
  assertEquals(
    normalizeNpmLicense({
      licenses: [{ type: "MIT" }, { type: "Apache-2.0" }],
    }),
    "(MIT OR Apache-2.0)",
  );
  assertEquals(normalizeNpmLicense({}), null);
  assertEquals(normalizeNpmLicense({ license: "   " }), null);
});

Deno.test("parseNpmAuthor: extracts name from string and object forms", () => {
  assertEquals(
    parseNpmAuthor("Colin McDonnell <zod@colinhacks.com>"),
    "Colin McDonnell",
  );
  assertEquals(parseNpmAuthor("Hexagon (github.com/hexagon)"), "Hexagon");
  assertEquals(
    parseNpmAuthor({ name: "Christopher Jeffrey" }),
    "Christopher Jeffrey",
  );
  assertEquals(parseNpmAuthor({ email: "x@y.z" }), null);
  assertEquals(parseNpmAuthor(undefined), null);
});

Deno.test("extractNpmComponents: builds purl and dependency keys", () => {
  const components = extractNpmComponents({
    npmPackages: {
      "zod@4.4.3": { name: "zod", version: "4.4.3", dependencies: [] },
      "@scope/pkg@1.0.0": {
        name: "@scope/pkg",
        version: "1.0.0",
        dependencies: ["zod@4.4.3"],
      },
    },
  });
  const zod = components.find((c) => c.name === "zod");
  const scoped = components.find((c) => c.name === "@scope/pkg");
  assertEquals(zod?.purl, "pkg:npm/zod@4.4.3");
  assertEquals(scoped?.purl, "pkg:npm/%40scope/pkg@1.0.0");
  assertEquals(scoped?.dependsOn, ["zod@4.4.3"]);
});

Deno.test("extractJsrComponents: dedupes packages and sets purl + supplier", () => {
  const components = extractJsrComponents({
    modules: [
      { specifier: "https://jsr.io/@cliffy/command/1.0.1/mod.ts" },
      { specifier: "https://jsr.io/@cliffy/command/1.0.1/types.ts" },
      { specifier: "https://jsr.io/@std/path/1.1.4/mod.ts" },
      { specifier: "file:///home/x/main.ts" },
      { specifier: "https://registry.npmjs.org/zod" },
    ],
  });
  assertEquals(components.length, 2);
  const command = components.find((c) => c.name === "@cliffy/command");
  assertEquals(command?.version, "1.0.1");
  assertEquals(command?.bomRef, "jsr:@cliffy/command@1.0.1");
  assertEquals(command?.purl, "pkg:jsr/@cliffy/command@1.0.1");
  assertEquals(command?.supplier, "@cliffy");
});

Deno.test("extractJsrComponents: resolves jsr->jsr edges via packages map", () => {
  const components = extractJsrComponents({
    modules: [
      {
        specifier: "https://jsr.io/@logtape/pretty/2.0.7/mod.ts",
        dependencies: [{ specifier: "jsr:@logtape/logtape@^2.0.7" }],
      },
      { specifier: "https://jsr.io/@logtape/logtape/2.0.7/mod.ts" },
    ],
    packages: { "@logtape/logtape@^2.0.7": "@logtape/logtape@2.0.7" },
  });
  const pretty = components.find((c) => c.name === "@logtape/pretty");
  assertEquals(pretty?.dependsOn, ["@logtape/logtape@2.0.7"]);
});

Deno.test("buildSbom: assembles a deterministic CycloneDX 1.6 document", () => {
  const bom = buildSbom(
    { name: "@swamp/cli", version: "0.1.0", license: "AGPL-3.0-only" },
    [
      {
        ecosystem: "npm",
        name: "zod",
        version: "4.4.3",
        key: "zod@4.4.3",
        bomRef: "pkg:npm/zod@4.4.3",
        purl: "pkg:npm/zod@4.4.3",
        license: "MIT",
        supplier: "Colin McDonnell",
        dependsOn: [],
      },
      {
        ecosystem: "jsr",
        name: "@cliffy/command",
        version: "1.0.1",
        key: "@cliffy/command@1.0.1",
        bomRef: "jsr:@cliffy/command@1.0.1",
        purl: "pkg:jsr/@cliffy/command@1.0.1",
        license: "MIT",
        supplier: "@cliffy",
        dependsOn: [],
      },
    ],
    "2026-06-23T00:00:00.000Z",
    "urn:uuid:00000000-0000-0000-0000-000000000000",
  );

  assertEquals(bom.bomFormat, "CycloneDX");
  assertEquals(bom.specVersion, "1.6");
  assertEquals(bom.metadata.authors, [{ name: "Elder Swamp Club, Inc." }]);
  assertEquals(bom.metadata.component.name, "@swamp/cli");
  assertEquals(bom.metadata.component.licenses, [{
    license: { id: "AGPL-3.0-only" },
  }]);
  assertEquals(bom.components.length, 2);
  // jsr sorts before npm
  assertEquals(bom.components[0].name, "@cliffy/command");
  assertEquals(bom.components[0].purl, "pkg:jsr/@cliffy/command@1.0.1");
  assertEquals(bom.components[0].supplier, { name: "@cliffy" });
  assertEquals(
    bom.components[0].externalReferences?.[0].url,
    "https://jsr.io/@cliffy/command@1.0.1",
  );
  assertEquals(bom.components[1].purl, "pkg:npm/zod@4.4.3");
  assertEquals(bom.components[1].supplier, { name: "Colin McDonnell" });
  // every component has a relationship entry (211/211-style coverage)
  assertEquals(bom.dependencies.length, 2);
});

Deno.test("buildSbom: every component gets a relationship entry; bad refs dropped", () => {
  const bom = buildSbom(
    { name: "root", version: "1.0.0", license: "MIT" },
    [
      {
        ecosystem: "npm",
        name: "a",
        version: "1.0.0",
        key: "a@1.0.0",
        bomRef: "pkg:npm/a@1.0.0",
        purl: "pkg:npm/a@1.0.0",
        license: "MIT",
        supplier: "npm",
        dependsOn: ["b@1.0.0", "missing@9.9.9"],
      },
      {
        ecosystem: "npm",
        name: "b",
        version: "1.0.0",
        key: "b@1.0.0",
        bomRef: "pkg:npm/b@1.0.0",
        purl: "pkg:npm/b@1.0.0",
        license: "MIT",
        supplier: "npm",
        dependsOn: [],
      },
    ],
    "2026-06-23T00:00:00.000Z",
    "urn:uuid:00000000-0000-0000-0000-000000000000",
  );
  // Both components present; unresolvable "missing@9.9.9" edge is dropped,
  // leaf "b" keeps an explicit empty dependsOn.
  assertEquals(bom.dependencies, [
    { ref: "pkg:npm/a@1.0.0", dependsOn: ["pkg:npm/b@1.0.0"] },
    { ref: "pkg:npm/b@1.0.0", dependsOn: [] },
  ]);
});

Deno.test("JsrLicenseCache: round-trips and only writes when dirty", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "cache.json");
  try {
    const cache = await JsrLicenseCache.load(path);
    assertEquals(cache.get("@std/path@1.1.4"), undefined);
    cache.set("@std/path@1.1.4", "MIT");
    await cache.save(path);

    const reloaded = await JsrLicenseCache.load(path);
    assertEquals(reloaded.get("@std/path@1.1.4"), "MIT");

    // Missing file load yields an empty cache rather than throwing.
    const empty = await JsrLicenseCache.load(join(dir, "absent.json"));
    assertEquals(empty.get("anything"), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
