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
import {
  isZod3Specifier,
  isZod4Specifier,
  rewriteZodImports,
} from "./bundle.ts";

const REAL_ZOD_IMPORT = `import { z } from "npm:zod@4";`;
const REWRITTEN_ZOD_IMPORT = `const { z } = globalThis.__swamp_zod;`;

// Generated code is where zod import text turns up as data, so bias the
// arbitrary towards it instead of waiting for fc.string() to stumble on it.
const arbChunk = fc.oneof(
  fc.string(),
  fc.constantFrom(
    `import { z } from "npm:zod@4";`,
    `import { z as z2 } from 'zod';`,
    `import * as zod from "npm:zod";`,
    "\n",
    "${",
    "`",
    "\\",
    "/*",
    "//",
  ),
);

/** Escapes text so it is the body of a template literal, with no interpolation. */
function templateBody(text: string): string {
  return text.replace(/[\\`]/g, "\\$&").replace(/\$\{/g, "\\${");
}

const arbTemplateLine = fc.array(arbChunk, { maxLength: 8 }).map((chunks) =>
  `export const t = \`${templateBody(chunks.join(""))}\`;`
);

Deno.test("rewriteZodImports: leaves any template literal body byte-identical", () => {
  fc.assert(
    fc.property(arbTemplateLine, (line) => {
      const result = rewriteZodImports(`${REAL_ZOD_IMPORT}\n${line}\n`);
      assertEquals(result, `${REWRITTEN_ZOD_IMPORT}\n${line}\n`);
    }),
  );
});

Deno.test("rewriteZodImports: is idempotent for any template literal body", () => {
  fc.assert(
    fc.property(arbTemplateLine, (line) => {
      const first = rewriteZodImports(`${REAL_ZOD_IMPORT}\n${line}\n`);
      assertEquals(rewriteZodImports(first), first);
    }),
  );
});

const arbVersion = fc.tuple(
  fc.integer({ min: 0, max: 9 }),
  fc.integer({ min: 0, max: 30 }),
  fc.integer({ min: 0, max: 30 }),
);

Deno.test("isZod4Specifier: an exact, caret or tilde version is zod 4 exactly when its major is 4", () => {
  fc.assert(
    fc.property(
      arbVersion,
      fc.constantFrom("", "^", "~"),
      ([major, minor, patch], op) => {
        // ^0.x admits only 0.x, so it never crosses a major either.
        const spec = `npm:zod@${op}${major}.${minor}.${patch}`;
        assertEquals(isZod4Specifier(spec), major === 4, spec);
        assertEquals(isZod3Specifier(spec), major === 3, spec);
      },
    ),
  );
});

Deno.test("isZod4Specifier: a range spanning two majors is neither zod 3 nor zod 4", () => {
  fc.assert(
    fc.property(fc.integer({ min: 2, max: 4 }), (low) => {
      const spec = `npm:zod@>=${low}.0.0 <${low + 2}.0.0`;
      assertEquals(isZod4Specifier(spec), false, spec);
      assertEquals(isZod3Specifier(spec), false, spec);
    }),
  );
});
