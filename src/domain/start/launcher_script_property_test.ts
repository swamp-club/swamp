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
import fc from "fast-check";
import {
  cmdCallQuote,
  cmdPasteQuote,
  cmdQuote,
  posixQuote,
} from "./launcher_script.ts";

/**
 * A reference reader for one POSIX shell word made only of single-quoted
 * runs and `\'` escapes — the forms `posixQuote` emits.
 */
function parsePosixWord(word: string): string {
  let out = "";
  let i = 0;
  while (i < word.length) {
    const c = word[i];
    if (c === "'") {
      const end = word.indexOf("'", i + 1);
      if (end === -1) throw new Error("unterminated single quote");
      out += word.slice(i + 1, end);
      i = end + 1;
    } else if (c === "\\") {
      if (i + 1 >= word.length) throw new Error("dangling backslash");
      out += word[i + 1];
      i += 2;
    } else {
      throw new Error(`unquoted character ${JSON.stringify(c)}`);
    }
  }
  return out;
}

/** A reference reader for a `cmdQuote`d token: outer quotes, `%%` → `%`. */
function parseCmdToken(token: string): string {
  if (token.length < 2 || !token.startsWith('"') || !token.endsWith('"')) {
    throw new Error("not double-quoted");
  }
  const inner = token.slice(1, -1);
  if (inner.includes('"')) throw new Error("inner double quote");
  if (/(^|[^%])%(%%)*([^%]|$)/.test(inner)) {
    throw new Error("unescaped percent");
  }
  return inner.replace(/%%/g, "%");
}

/**
 * A reference reader for a `cmdPasteQuote`d token at an interactive prompt:
 * quotes toggle, and outside them only `^%` (a literal percent) may appear.
 * Inside quotes no `%` may appear, so nothing can expand.
 */
function parsePasteToken(token: string): string {
  let out = "";
  let quoted = false;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === '"') {
      quoted = !quoted;
    } else if (quoted) {
      if (c === "%") throw new Error("percent inside quotes");
      out += c;
    } else if (c === "^" && token[i + 1] === "%") {
      out += "%";
      i++;
    } else {
      throw new Error(`unquoted character ${JSON.stringify(c)}`);
    }
  }
  if (quoted) throw new Error("unterminated double quote");
  return out;
}

const special = fc.constantFrom(
  "'",
  '"',
  " ",
  "$",
  "`",
  "\\",
  "\n",
  "\r",
  "%",
  "^",
  "&",
  "|",
  "!",
  "*",
  "~",
);

const arbShellish = fc.array(
  fc.oneof(
    special,
    fc.string({ maxLength: 4 }),
    fc.fullUnicodeString({ maxLength: 3 }),
  ),
  {
    maxLength: 20,
  },
).map((parts) => parts.join(""));

Deno.test("posixQuote: round-trips arbitrary strings through a POSIX single-quote reader", () => {
  fc.assert(
    fc.property(arbShellish, (value) => {
      assertEquals(parsePosixWord(posixQuote(value)), value);
    }),
    { numRuns: 500 },
  );
});

Deno.test("cmdQuote: round-trips strings without double quotes or line breaks", () => {
  fc.assert(
    fc.property(
      arbShellish.map((v) => v.replace(/["\r\n]/g, "")),
      (value) => {
        assertEquals(parseCmdToken(cmdQuote(value)), value);
      },
    ),
    { numRuns: 500 },
  );
});

Deno.test("cmdQuote: refuses every string containing a double quote or a line break", () => {
  fc.assert(
    fc.property(
      arbShellish,
      fc.constantFrom('"', "\r", "\n"),
      arbShellish,
      (before, bad, after) => {
        assertThrows(() => cmdQuote(before + bad + after));
      },
    ),
  );
});

const arbCmdSafe = arbShellish.map((v) => v.replace(/["\r\n]/g, ""));

Deno.test("cmdCallQuote: survives the file's and call's percent expansions", () => {
  fc.assert(
    fc.property(arbCmdSafe, (value) => {
      // The batch file's own expansion, then call's second one.
      const afterFile = cmdCallQuote(value).replace(/%%/g, "%");
      assertEquals(parseCmdToken(afterFile), value);
    }),
    { numRuns: 500 },
  );
});

Deno.test("cmdPasteQuote: round-trips through an interactive cmd reader", () => {
  fc.assert(
    fc.property(arbCmdSafe, (value) => {
      assertEquals(parsePasteToken(cmdPasteQuote(value)), value);
    }),
    { numRuns: 500 },
  );
});
