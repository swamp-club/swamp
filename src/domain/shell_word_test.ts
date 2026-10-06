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

Deno.test("quoteShellWord: writes a name with an OSC title sequence in escaped ANSI-C form", () => {
  assertEquals(
    quoteShellWord("deploy\u001b]0;pwned\u0007"),
    "$'deploy\\x1b]0;pwned\\x07'",
  );
});

Deno.test("quoteShellWord: escapes every control class — ESC, BEL, NUL, tab, newline, DEL, C1", () => {
  assertEquals(quoteShellWord("a\u001bb"), "$'a\\x1bb'");
  assertEquals(quoteShellWord("a\u0007b"), "$'a\\x07b'");
  assertEquals(quoteShellWord("a\u0000b"), "$'a\\x00b'");
  assertEquals(quoteShellWord("a\tb"), "$'a\\x09b'");
  assertEquals(quoteShellWord("a\nb"), "$'a\\x0ab'");
  assertEquals(quoteShellWord("a\u007fb"), "$'a\\x7fb'");
  assertEquals(quoteShellWord("a\u009bb"), "$'a\\u009bb'");
});

Deno.test("quoteShellWord: in ANSI-C form, escapes backslashes and single quotes too", () => {
  assertEquals(quoteShellWord("it's\u001b"), "$'it\\'s\\x1b'");
  assertEquals(quoteShellWord("a\\b\u001b"), "$'a\\\\b\\x1b'");
});

Deno.test("quoteShellWord: a name without control characters never takes the ANSI-C form", () => {
  assertEquals(quoteShellWord("verify build"), "'verify build'");
  assertEquals(quoteShellWord("a\\x1b"), "'a\\x1b'");
});
