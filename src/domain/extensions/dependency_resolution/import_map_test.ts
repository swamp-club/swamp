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
import { importMapTarget } from "./import_map.ts";

Deno.test("importMapTarget: an exact key resolves to its explicit specifier", () => {
  const imports = {
    "zod": "npm:zod@4.3.6",
    "@azure/core-auth": "npm:@azure/core-auth@1.9.0",
  };
  assertEquals(importMapTarget("zod", imports), "npm:zod@4.3.6");
  assertEquals(
    importMapTarget("@azure/core-auth", imports),
    "npm:@azure/core-auth@1.9.0",
  );
});

Deno.test("importMapTarget: the longest trailing-slash prefix key resolves the rest of the path", () => {
  const imports = {
    "@std/": "jsr:@std/",
    "@std/path/": "jsr:@std/path@1.1.0/",
  };
  assertEquals(importMapTarget("@std/assert", imports), "jsr:@std/assert");
  assertEquals(
    importMapTarget("@std/path/posix", imports),
    "jsr:@std/path@1.1.0/posix",
  );
});

Deno.test("importMapTarget: no entry, a non-matching key or a bare target gives no suggestion", () => {
  assertEquals(importMapTarget("zod", undefined), undefined);
  assertEquals(importMapTarget("zod/v4", { "zod": "npm:zod@4" }), undefined);
  assertEquals(importMapTarget("lib", { "lib": "other-bare" }), undefined);
  assertEquals(
    importMapTarget("lib", { "lib": "./lib/mod.ts" }),
    "./lib/mod.ts",
  );
});
