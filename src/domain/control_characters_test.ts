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
  CONTROL_CHARACTER_CLASS,
  escapeControlCharacters,
  hasControlCharacter,
} from "./control_characters.ts";

Deno.test("hasControlCharacter: true for C0, DEL and C1 characters", () => {
  for (
    const c of [
      "\u001b",
      "\u0007",
      "\u0000",
      "\t",
      "\n",
      "\r",
      "\u007f",
      "\u0080",
      "\u009b",
      "\u009f",
    ]
  ) {
    assertEquals(hasControlCharacter(`a${c}b`), true, JSON.stringify(c));
  }
});

Deno.test("hasControlCharacter: false for printable text, space and Unicode", () => {
  for (
    const s of [
      "verify build",
      "déploiement ✓",
      "read-${{ self.plate }}",
      "",
      " ",
      String.fromCharCode(0xa0),
      String.fromCharCode(0x2028),
    ]
  ) {
    assertEquals(hasControlCharacter(s), false, JSON.stringify(s));
  }
});

Deno.test("escapeControlCharacters: rewrites each control character as a hex escape", () => {
  assertEquals(
    escapeControlCharacters("deploy\u001b]0;x\u0007"),
    "deploy\\x1b]0;x\\x07",
  );
  assertEquals(escapeControlCharacters("a\tb\nc"), "a\\x09b\\x0ac");
  assertEquals(
    escapeControlCharacters("\u0000\u007f\u009b"),
    "\\x00\\x7f\\x9b",
  );
});

Deno.test("escapeControlCharacters: leaves text without control characters unchanged", () => {
  for (
    const s of ["verify build", "déploiement ✓", "a\\x1b already escaped", ""]
  ) {
    assertEquals(escapeControlCharacters(s), s);
  }
});

Deno.test("CONTROL_CHARACTER_CLASS: builds a character class covering C0, DEL and C1 only", () => {
  const re = new RegExp(`^[${CONTROL_CHARACTER_CLASS}]$`);
  for (let code = 0; code < 0x100; code++) {
    const expected = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    assertEquals(
      re.test(String.fromCharCode(code)),
      expected,
      `U+${code.toString(16)}`,
    );
  }
});
