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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { z } from "zod";
import { NODE_NAME_PATTERN, nodeName } from "./node_name.ts";

Deno.test("NODE_NAME_PATTERN: accepts any printable name with spaces", () => {
  for (
    const name of [
      "build",
      "verify build",
      "read-${{ self.plate }}",
      "déploiement ✓",
      "a/b.c:d",
      "x",
    ]
  ) {
    assertEquals(NODE_NAME_PATTERN.test(name), true, name);
  }
});

Deno.test("NODE_NAME_PATTERN: rejects control characters, tab, newline and the empty string", () => {
  for (
    const name of [
      "deploy\u001b]0;x\u0007",
      "a\tb",
      "a\nb",
      "a\rb",
      "a\u0000b",
      "a\u007fb",
      "a\u009bb",
      "",
      "\u001b",
    ]
  ) {
    assertEquals(NODE_NAME_PATTERN.test(name), false, JSON.stringify(name));
  }
});

Deno.test("nodeName: the schema refuses a control character and names the node kind", () => {
  const error = assertThrows(() => nodeName("Step").parse("gate\u001b"));
  assertStringIncludes(
    String(error),
    "Step name must not contain control characters, tab or newline; space is the only whitespace allowed",
  );
  const jobError = assertThrows(() => nodeName("Job").parse("a\tb"));
  assertStringIncludes(
    String(jobError),
    "Job name must not contain control characters",
  );
});

Deno.test("nodeName: the schema accepts an ordinary name and the empty string is still refused", () => {
  assertEquals(nodeName("Step").parse("verify build"), "verify build");
  assertThrows(() => nodeName("Step").parse(""));
});

Deno.test("nodeName: publishes the pattern in the JSON schema", () => {
  const schema = z.toJSONSchema(nodeName("Step")) as {
    pattern?: string;
    minLength?: number;
  };
  assertEquals(schema.pattern, NODE_NAME_PATTERN.source);
  assertEquals(schema.minLength, 1);
});
