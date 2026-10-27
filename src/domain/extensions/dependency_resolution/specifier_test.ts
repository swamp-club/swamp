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
import { isBareSpecifier, jsrDistTag } from "./specifier.ts";

Deno.test("jsrDistTag: the tag a jsr: specifier names in place of a version", () => {
  assertEquals(jsrDistTag("jsr:@std/assert@latest"), "latest");
  assertEquals(jsrDistTag("jsr:/@std/assert@next/equals"), "next");
  for (
    const specifier of [
      "jsr:@std/assert",
      "jsr:@std/assert@1.0.0",
      "jsr:@std/assert@^1/equals",
      "jsr:@std/assert@>=1 <2",
      "jsr:@std/assert@1.x",
      "npm:ms@latest",
      "ms",
    ]
  ) {
    assertEquals(jsrDistTag(specifier), undefined, specifier);
  }
});

Deno.test("isBareSpecifier: only a name a project config resolves", () => {
  assertEquals(isBareSpecifier("ms"), true);
  assertEquals(isBareSpecifier("jsr:@std/assert"), false);
  assertEquals(isBareSpecifier("./m.ts"), false);
});
