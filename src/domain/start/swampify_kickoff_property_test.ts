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

import { assert, assertEquals, assertThrows } from "@std/assert";
import fc from "fast-check";
import { UserError } from "../errors.ts";
import { SwampifyKickoff } from "./swampify_kickoff.ts";

const arbPathText = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.fullUnicodeString({ maxLength: 40 }),
);

const arbPath = fc.oneof(
  arbPathText.map((s) => `/${s}`),
  arbPathText.map((s) => `~/${s}`),
  arbPathText,
);

Deno.test("SwampifyKickoff.render: accepted paths round-trip through the JSON block and nothing else is added", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 365 }),
      fc.array(arbPath, { maxLength: 6 }),
      (windowDays, exclude) => {
        let kickoff: SwampifyKickoff;
        try {
          kickoff = SwampifyKickoff.create({ windowDays, exclude }, "linux");
        } catch (error) {
          assert(error instanceof UserError);
          return;
        }
        const text = kickoff.render();
        const empty = SwampifyKickoff.create({ windowDays }, "linux").render();
        if (kickoff.exclude.length === 0) {
          assertEquals(text, empty);
          return;
        }
        const block = /\n```json\n(.*)\n```\n/.exec(text);
        assert(block, text);
        assertEquals(JSON.parse(block[1]), kickoff.exclude);
        // Removing the block gives back the text with no paths: no path
        // text appears anywhere else.
        assertEquals(
          text.replace(
            `Excluded paths:\n\n\`\`\`json\n${block[1]}\n\`\`\``,
            "Excluded paths: none",
          ),
          empty,
        );
      },
    ),
  );
});

Deno.test("SwampifyKickoff.create: every accepted path is a single line with no quoting characters", () => {
  fc.assert(
    fc.property(fc.array(arbPath, { maxLength: 6 }), (exclude) => {
      try {
        const kickoff = SwampifyKickoff.create(
          { windowDays: 30, exclude },
          "linux",
        );
        for (const path of kickoff.exclude) {
          assert(!/[\n\r'"`$<>\u2028\u2029]/.test(path), path);
          assert(path.startsWith("/") || path === "~" || path.startsWith("~/"));
        }
      } catch (error) {
        assert(error instanceof UserError);
      }
    }),
  );
});

Deno.test("SwampifyKickoff.create: a path with a control character is always refused", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 20 }),
      fc.integer({ min: 0, max: 0x1f }),
      fc.string({ maxLength: 20 }),
      (a, code, b) => {
        assertThrows(
          () =>
            SwampifyKickoff.create({
              windowDays: 30,
              exclude: [`/${a}${String.fromCharCode(code)}x${b}`],
            }, "linux"),
          UserError,
        );
      },
    ),
  );
});
