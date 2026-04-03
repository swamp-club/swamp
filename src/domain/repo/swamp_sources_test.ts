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
import { isGlobPattern, parseSwampSources } from "./swamp_sources.ts";
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
