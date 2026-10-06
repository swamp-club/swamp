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
import fc from "fast-check";
import { NODE_NAME_PATTERN } from "./node_name.ts";
import {
  escapeControlCharacters,
  hasControlCharacter,
} from "../control_characters.ts";
import { quoteShellWord } from "../shell_word.ts";

const isControl = (code: number): boolean =>
  code < 0x20 || (code >= 0x7f && code <= 0x9f);

/** A single UTF-16 code unit from the printable ranges, including space. */
const arbPrintable = fc.oneof(
  fc.integer({ min: 0x20, max: 0x7e }),
  fc.integer({ min: 0xa0, max: 0xd7ff }),
).map((code) => String.fromCharCode(code));

/** A single control character from C0, DEL or C1. */
const arbControl = fc.oneof(
  fc.integer({ min: 0x00, max: 0x1f }),
  fc.integer({ min: 0x7f, max: 0x9f }),
).map((code) => String.fromCharCode(code));

const arbPrintableName = fc.stringOf(arbPrintable, {
  minLength: 1,
  maxLength: 24,
});

/** A string that holds at least one control character somewhere. */
const arbNameWithControl = fc.tuple(
  fc.stringOf(arbPrintable, { maxLength: 12 }),
  arbControl,
  fc.stringOf(fc.oneof(arbPrintable, arbControl), { maxLength: 12 }),
).map(([head, control, tail]) => `${head}${control}${tail}`);

Deno.test("property: NODE_NAME_PATTERN accepts every non-empty printable name", () => {
  fc.assert(
    fc.property(arbPrintableName, (name) => {
      assertEquals(NODE_NAME_PATTERN.test(name), true);
      assertEquals(hasControlCharacter(name), false);
    }),
  );
});

Deno.test("property: NODE_NAME_PATTERN rejects every name holding a control character", () => {
  fc.assert(
    fc.property(arbNameWithControl, (name) => {
      assertEquals(NODE_NAME_PATTERN.test(name), false);
      assertEquals(hasControlCharacter(name), true);
      assertEquals([...name].some((c) => isControl(c.charCodeAt(0))), true);
    }),
  );
});

Deno.test("property: escapeControlCharacters output never holds a control character and is identity otherwise", () => {
  fc.assert(
    fc.property(
      fc.oneof(arbPrintableName, arbNameWithControl),
      (name) => {
        const escaped = escapeControlCharacters(name);
        assertEquals(hasControlCharacter(escaped), false);
        if (!hasControlCharacter(name)) assertEquals(escaped, name);
      },
    ),
  );
});

Deno.test("property: quoteShellWord never writes a control character to the terminal", () => {
  fc.assert(
    fc.property(
      fc.oneof(arbPrintableName, arbNameWithControl),
      (name) => {
        const quoted = quoteShellWord(name);
        assertEquals(hasControlCharacter(quoted), false);
        if (hasControlCharacter(name)) {
          assertEquals(quoted.startsWith("$'") && quoted.endsWith("'"), true);
        }
      },
    ),
  );
});
