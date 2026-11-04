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

import { assertEquals, assertThrows } from "@std/assert";
import { UserError } from "../../domain/errors.ts";
import { parseVisibilityOptions } from "./extension_visibility.ts";

Deno.test("parseVisibilityOptions: no --set reads", () => {
  assertEquals(parseVisibilityOptions(undefined, false), {
    target: null,
    dryRun: false,
  });
});

Deno.test("parseVisibilityOptions: --set accepts public and private", () => {
  assertEquals(parseVisibilityOptions("public", false).target, "public");
  assertEquals(parseVisibilityOptions("private", true), {
    target: "private",
    dryRun: true,
  });
});

Deno.test("parseVisibilityOptions: an unknown --set value is refused", () => {
  assertThrows(
    () => parseVisibilityOptions("internal", false),
    UserError,
    'Invalid visibility: "internal"',
  );
});

Deno.test("parseVisibilityOptions: --dry-run without --set is refused", () => {
  assertThrows(
    () => parseVisibilityOptions(undefined, true),
    UserError,
    "--dry-run needs --set",
  );
});
