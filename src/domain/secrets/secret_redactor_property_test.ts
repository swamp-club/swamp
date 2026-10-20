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
import { SecretRedactor } from "./secret_redactor.ts";

Deno.test("SecretRedactor: unwrapped inspected secrets remain masked across quote styles and enclosing text", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.constantFrom(
          "a",
          '"',
          "'",
          "`",
          "\\",
          "\n",
          "\r",
          "\t",
          "\0",
          "\x1b",
          "${x}",
        ),
        { minLength: 1, maxLength: 100 },
      ),
      (chars) => {
        const secret = `secret-${chars.join("")}-value`;
        const redactor = new SecretRedactor();
        redactor.addSecret(secret);
        for (const prefix of ["", "quote'", 'quote"', "quote`", "all'\"`"]) {
          for (const value of [prefix + secret, { token: prefix + secret }]) {
            const rendered = Deno.inspect(value, {
              colors: false,
              strAbbreviateSize: Infinity,
              breakLength: Infinity,
            });
            const redacted = redactor.redact(rendered);
            assertEquals(redacted.includes("secret-"), false, rendered);
            assertEquals(redacted.includes("-value"), false, rendered);
            assertEquals(redacted.includes("***"), true, rendered);
          }
        }
      },
    ),
    { numRuns: 500 },
  );
});
