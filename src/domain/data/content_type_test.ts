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
import { isTextContentType } from "./content_type.ts";

Deno.test("isTextContentType: text/* and text-based application types are text", () => {
  for (
    const type of [
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json",
      "application/x-ndjson",
      "application/yaml",
      "application/x-yaml",
      "application/xml",
      "application/toml",
      "application/javascript",
      "application/x-sh",
      "application/sql",
      "application/graphql",
    ]
  ) {
    assertEquals(isTextContentType(type), true, type);
  }
});

Deno.test("isTextContentType: text-based structured-syntax suffixes are text", () => {
  assertEquals(isTextContentType("application/vnd.api+json"), true);
  assertEquals(isTextContentType("image/svg+xml"), true);
  assertEquals(isTextContentType("application/ld+json"), true);
  assertEquals(isTextContentType("application/vnd.k8s+yaml"), true);
});

Deno.test("isTextContentType: ignores parameters and case", () => {
  assertEquals(isTextContentType("application/json; charset=utf-8"), true);
  assertEquals(isTextContentType("Text/Plain;charset=UTF-8"), true);
  assertEquals(isTextContentType(" APPLICATION/XML "), true);
});

Deno.test("isTextContentType: binary types are not text", () => {
  for (
    const type of [
      "image/png",
      "application/octet-stream",
      "application/gzip",
      "application/x-tar",
      "application/zip",
      "application/pdf",
      "application/vnd.api+zip",
      "",
    ]
  ) {
    assertEquals(isTextContentType(type), false, type);
  }
});
