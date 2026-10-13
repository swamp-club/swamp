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
import { MAX_TASK_BYTES, MAX_TITLE_CHARS, StartTask } from "./start_task.ts";

const arbText = fc.oneof(
  fc.string({ maxLength: 300 }),
  fc.fullUnicodeString({ maxLength: 300 }),
  fc.array(
    fc.oneof(fc.string({ maxLength: 200 }), fc.constantFrom("", " ", "\t")),
    { maxLength: 6 },
  ).map((lines) => lines.join("\n")),
);

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

Deno.test("StartTask.create: accepts exactly the non-blank texts within the limit", () => {
  fc.assert(
    fc.property(arbText, (text) => {
      const trimmed = text.trim();
      if (trimmed.length === 0 || utf8Length(trimmed) > MAX_TASK_BYTES) {
        assertThrows(() => StartTask.create(text), UserError);
        return;
      }
      assertEquals(StartTask.create(text).text, trimmed);
    }),
  );
});

Deno.test("StartTask.create: round-trips its own text", () => {
  fc.assert(
    fc.property(arbText.filter((t) => t.trim().length > 0), (text) => {
      const task = StartTask.create(text);
      assertEquals(StartTask.create(task.text).text, task.text);
    }),
  );
});

Deno.test("StartTask.create: rejects any oversized text", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 4096 }),
      fc.constantFrom("a", "é", "🦆"),
      (extra, unit) => {
        const count = Math.ceil((MAX_TASK_BYTES + extra) / utf8Length(unit));
        assertThrows(() => StartTask.create(unit.repeat(count)), UserError);
      },
    ),
    { numRuns: 20 },
  );
});

Deno.test("StartTask.title: is single-line and at most 121 characters", () => {
  fc.assert(
    fc.property(arbText.filter((t) => t.trim().length > 0), (text) => {
      const title = StartTask.create(text).title();
      assert(
        !title.includes("\n"),
        `title has a line break: ${JSON.stringify(title)}`,
      );
      assert(Array.from(title).length <= MAX_TITLE_CHARS + 1);
      assert(title.length <= (MAX_TITLE_CHARS + 1) * 2);
      assert(title.trim().length > 0);
    }),
  );
});
