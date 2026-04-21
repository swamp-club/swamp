// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import {
  detectKindFromSource,
  EXTENSION_EXPORT_NAMES,
  isGlobPattern,
  parseSwampSources,
} from "./swamp_sources.ts";
import { UserError } from "../errors.ts";

Deno.test("parseSwampSources: parses valid sources with paths", () => {
  const yaml = `
sources:
  - path: ~/code/my-extensions
  - path: /absolute/path
`;
  const config = parseSwampSources(yaml);
  assertEquals(config.sources.length, 2);
  assertEquals(config.sources[0].path, "~/code/my-extensions");
  assertEquals(config.sources[1].path, "/absolute/path");
});

Deno.test("parseSwampSources: parses sources with only filter", () => {
  const yaml = `
sources:
  - path: ~/code/extensions
    only: [models, vaults]
`;
  const config = parseSwampSources(yaml);
  assertEquals(config.sources.length, 1);
  assertEquals(config.sources[0].only, ["models", "vaults"]);
});

Deno.test("parseSwampSources: parses sources with glob paths", () => {
  const yaml = `
sources:
  - path: "~/code/swamp-extensions/model/aws/*"
`;
  const config = parseSwampSources(yaml);
  assertEquals(config.sources[0].path, "~/code/swamp-extensions/model/aws/*");
});

Deno.test("parseSwampSources: rejects empty sources array", () => {
  const yaml = `
sources: []
`;
  assertThrows(
    () => parseSwampSources(yaml),
    UserError,
    "At least one source is required",
  );
});

Deno.test("parseSwampSources: rejects empty path", () => {
  const yaml = `
sources:
  - path: ""
`;
  assertThrows(
    () => parseSwampSources(yaml),
    UserError,
    "Source path must not be empty",
  );
});

Deno.test("parseSwampSources: rejects invalid only values", () => {
  const yaml = `
sources:
  - path: ~/code/ext
    only: [invalid_kind]
`;
  assertThrows(() => parseSwampSources(yaml), UserError);
});

Deno.test("parseSwampSources: rejects non-object YAML", () => {
  assertThrows(
    () => parseSwampSources("just a string"),
    UserError,
    "must be a YAML object",
  );
});

Deno.test("parseSwampSources: rejects missing sources field", () => {
  const yaml = `
paths:
  - ~/code/ext
`;
  assertThrows(() => parseSwampSources(yaml), UserError);
});

Deno.test("isGlobPattern: detects glob characters", () => {
  assertEquals(isGlobPattern("~/code/ext/*"), true);
  assertEquals(isGlobPattern("~/code/ext/**"), true);
  assertEquals(isGlobPattern("~/code/ext/{a,b}"), true);
  assertEquals(isGlobPattern("~/code/ext?"), true);
  assertEquals(isGlobPattern("~/code/ext"), false);
  assertEquals(isGlobPattern("/absolute/path"), false);
});

Deno.test("EXTENSION_EXPORT_NAMES: covers every non-workflow kind", () => {
  const expected = ["models", "vaults", "drivers", "datastores", "reports"];
  assertEquals(Object.keys(EXTENSION_EXPORT_NAMES).sort(), expected.sort());
});

Deno.test("detectKindFromSource: detects model export", () => {
  assertEquals(
    detectKindFromSource(`export const model = { type: "a/b" };`),
    "models",
  );
});

Deno.test("detectKindFromSource: detects extension (models kind)", () => {
  assertEquals(
    detectKindFromSource(`export const extension = { type: "a/b" };`),
    "models",
  );
});

Deno.test("detectKindFromSource: detects vault export", () => {
  assertEquals(
    detectKindFromSource(`export const vault = { type: "a/b" };`),
    "vaults",
  );
});

Deno.test("detectKindFromSource: detects driver export", () => {
  assertEquals(
    detectKindFromSource(`export const driver = { type: "a/b" };`),
    "drivers",
  );
});

Deno.test("detectKindFromSource: detects datastore export", () => {
  assertEquals(
    detectKindFromSource(`export const datastore = { type: "a/b" };`),
    "datastores",
  );
});

Deno.test("detectKindFromSource: detects report export", () => {
  assertEquals(
    detectKindFromSource(`export const report = { name: "r" };`),
    "reports",
  );
});

Deno.test("detectKindFromSource: returns undefined for unrelated exports", () => {
  assertEquals(detectKindFromSource(`export const thing = {};`), undefined);
  assertEquals(detectKindFromSource(`// just a comment`), undefined);
  assertEquals(detectKindFromSource(``), undefined);
});

Deno.test("detectKindFromSource: handles type annotation", () => {
  assertEquals(
    detectKindFromSource(`export const model: Model = { type: "a/b" };`),
    "models",
  );
});

Deno.test("detectKindFromSource: skips re-exports (parity with loaders)", () => {
  // Loaders' pre-bundle regex matches `export const model =` or
  // `export const model:` — re-exports are not in that shape and are
  // intentionally ignored so pre-scan detection == loader acceptance.
  assertEquals(
    detectKindFromSource(`export { model } from "./other.ts";`),
    undefined,
  );
});
