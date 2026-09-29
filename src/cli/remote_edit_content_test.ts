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
import { UserError } from "../domain/errors.ts";
import { requireRemoteEditContent } from "./remote_edit_content.ts";

Deno.test("requireRemoteEditContent: returns piped content", () => {
  assertEquals(
    requireRemoteEditContent("name: my-vault\n", "swamp vault edit"),
    "name: my-vault\n",
  );
});

Deno.test("requireRemoteEditContent: rejects missing stdin with a usage hint", () => {
  const error = assertThrows(
    () => requireRemoteEditContent(null, "swamp model edit"),
    UserError,
  );
  assertStringIncludes(error.message, "swamp model edit");
  assertStringIncludes(error.message, "--server");
  assertStringIncludes(error.message, "stdin");
});

Deno.test("requireRemoteEditContent: rejects whitespace-only stdin", () => {
  assertThrows(
    () => requireRemoteEditContent("  \n", "swamp workflow edit"),
    UserError,
  );
});
