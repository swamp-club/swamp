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
  CONTENT_DISPLAY_CAP_BYTES,
  contentKindFor,
  contentPlanFor,
  formatBytes,
  prettyJson,
} from "./content_kind.ts";

Deno.test("contentKindFor: classifies renderable and binary types", () => {
  const cases: Array<[string | undefined, string]> = [
    ["application/json", "json"],
    ["application/json; charset=utf-8", "json"],
    ["application/vnd.api+json", "json"],
    ["text/markdown", "markdown"],
    ["TEXT/MARKDOWN", "markdown"],
    ["application/yaml", "yaml"],
    ["application/x-yaml", "yaml"],
    ["text/yaml", "yaml"],
    ["text/plain", "text"],
    ["text/html", "text"],
    ["image/svg+xml", "text"],
    ["application/octet-stream", "binary"],
    ["image/png", "binary"],
    ["", "binary"],
    [undefined, "binary"],
  ];
  for (const [type, kind] of cases) {
    assertEquals(contentKindFor(type), kind, String(type));
  }
});

Deno.test("contentPlanFor: fetches small renderable items automatically", () => {
  assertEquals(contentPlanFor("text/markdown", 2048), {
    kind: "markdown",
    fetch: "auto",
  });
  assertEquals(
    contentPlanFor("application/json", CONTENT_DISPLAY_CAP_BYTES).fetch,
    "auto",
  );
});

Deno.test("contentPlanFor: never fetches binary or over-cap content", () => {
  assertEquals(contentPlanFor("image/png", 10).fetch, "never");
  assertEquals(contentPlanFor("image/png", undefined).fetch, "never");
  assertEquals(
    contentPlanFor("application/json", CONTENT_DISPLAY_CAP_BYTES + 1).fetch,
    "never",
  );
});

Deno.test("contentPlanFor: unknown size waits for the user", () => {
  assertEquals(contentPlanFor("text/plain", undefined).fetch, "onDemand");
});

Deno.test("prettyJson: indents valid JSON and leaves invalid input alone", () => {
  assertEquals(prettyJson('{"a":1}'), '{\n  "a": 1\n}');
  assertEquals(prettyJson("not json"), "not json");
});

Deno.test("formatBytes: scales units", () => {
  assertEquals(formatBytes(512), "512 B");
  assertEquals(formatBytes(1500), "1.5 kB");
  assertEquals(formatBytes(2_500_000), "2.5 MB");
  assertEquals(formatBytes(42_000_000), "42 MB");
});
