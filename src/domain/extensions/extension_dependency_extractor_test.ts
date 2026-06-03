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
import { extractSpecifiersFromSource } from "./extension_dependency_extractor.ts";

Deno.test("extractSpecifiersFromSource: extracts npm specifier with version", () => {
  const source = `import { z } from "npm:zod@4";
import axios from "npm:axios@1.7.2";`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 1);
  assertEquals(result[0].name, "axios");
  assertEquals(result[0].version, "1.7.2");
  assertEquals(result[0].registry, "npm");
});

Deno.test("extractSpecifiersFromSource: excludes zod (externalized)", () => {
  const source = `import { z } from "npm:zod@4";`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 0);
});

Deno.test("extractSpecifiersFromSource: extracts scoped npm packages", () => {
  const source = `import { S3Client } from "npm:@aws-sdk/client-s3@3.600.0";`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 1);
  assertEquals(result[0].name, "@aws-sdk/client-s3");
  assertEquals(result[0].version, "3.600.0");
  assertEquals(result[0].registry, "npm");
});

Deno.test("extractSpecifiersFromSource: extracts jsr specifiers", () => {
  const source = `import { parse } from "jsr:@std/semver@1.0.8";`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 1);
  assertEquals(result[0].name, "@std/semver");
  assertEquals(result[0].version, "1.0.8");
  assertEquals(result[0].registry, "jsr");
});

Deno.test("extractSpecifiersFromSource: handles missing version", () => {
  const source = `import lodash from "npm:lodash-es";`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 1);
  assertEquals(result[0].name, "lodash-es");
  assertEquals(result[0].version, null);
  assertEquals(result[0].registry, "npm");
});

Deno.test("extractSpecifiersFromSource: deduplicates same package", () => {
  const source = `import { foo } from "npm:axios@1.7.2";
import { bar } from "npm:axios@1.7.2";`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 1);
});

Deno.test("extractSpecifiersFromSource: extracts multiple packages", () => {
  const source = `import { z } from "npm:zod@4";
import mqtt from "npm:mqtt@5.10.3";
import { parse } from "jsr:@std/semver@1.0.8";
import { retry } from "npm:p-retry@6.2.0";`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 3);
  assertEquals(result[0].name, "mqtt");
  assertEquals(result[1].name, "@std/semver");
  assertEquals(result[2].name, "p-retry");
});

Deno.test("extractSpecifiersFromSource: ignores relative imports", () => {
  const source = `import { helper } from "./helpers.ts";
import { util } from "../utils/mod.ts";`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 0);
});

Deno.test("extractSpecifiersFromSource: handles side-effect imports", () => {
  const source = `import "npm:dotenv@16.4.5";`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 1);
  assertEquals(result[0].name, "dotenv");
  assertEquals(result[0].version, "16.4.5");
});

Deno.test("extractSpecifiersFromSource: extracts dynamic imports", () => {
  const source = `const mod = await import("npm:untrusted-pkg@1.0");`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 1);
  assertEquals(result[0].name, "untrusted-pkg");
  assertEquals(result[0].version, "1.0");
});

Deno.test("extractSpecifiersFromSource: ignores commented-out imports", () => {
  const source = `// import old from "npm:deprecated-pkg@1.0";
import active from "npm:good-pkg@2.0";`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 1);
  assertEquals(result[0].name, "good-pkg");
});

Deno.test("extractSpecifiersFromSource: ignores block-commented imports", () => {
  const source = `/* import old from "npm:deprecated-pkg@1.0"; */
import active from "npm:good-pkg@2.0";`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 1);
  assertEquals(result[0].name, "good-pkg");
});

Deno.test("extractSpecifiersFromSource: returns empty for no imports", () => {
  const source = `const x = 42;
export function hello() { return "world"; }`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 0);
});
