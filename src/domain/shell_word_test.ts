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
import { quoteShellWord } from "./shell_word.ts";

Deno.test("quoteShellWord: leaves a safe word unquoted", () => {
  assertEquals(quoteShellWord("read-plate"), "read-plate");
  assertEquals(
    quoteShellWord("./infra/a_b@1.0:x=y,z%+"),
    "./infra/a_b@1.0:x=y,z%+",
  );
});

Deno.test("quoteShellWord: single-quotes a forEach template name", () => {
  assertEquals(
    quoteShellWord("read-${{ self.plate }}"),
    "'read-${{ self.plate }}'",
  );
});

Deno.test("quoteShellWord: escapes an embedded single quote", () => {
  assertEquals(quoteShellWord("my repo's dir"), `'my repo'"'"'s dir'`);
});

Deno.test("quoteShellWord: quotes the empty string", () => {
  assertEquals(quoteShellWord(""), "''");
});
