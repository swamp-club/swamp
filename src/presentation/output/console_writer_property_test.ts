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

// The summary box draws its right border by padding each row to one width, so
// every row must fit the box's content limit as the terminal measures it.

import { assert, assertEquals } from "@std/assert";
import { unicodeWidth } from "@std/cli/unicode-width";
import { setColorEnabled } from "@std/fmt/colors";
import fc from "fast-check";
import { type DataArtifact, renderDataBox } from "./console_writer.ts";

// deno-lint-ignore no-control-regex
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;
const ZWJ = "‍";

const plainText = fc
  .string({ unit: "grapheme", maxLength: 120 })
  .filter((s) => !CONTROL.test(s) && !s.includes(ZWJ));

const text = fc.oneof(
  plainText,
  plainText.map((s) => `\x1b[31m${s}\x1b[0m`),
  fc.tuple(plainText, plainText).map(([a, b]) => `${a}\n${b}`),
);

const value = fc.oneof(
  text,
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.integer(), { maxLength: 3 }),
  fc.dictionary(plainText, fc.integer(), { maxKeys: 2 }),
);

const fields = fc.dictionary(text, value, { minKeys: 1, maxKeys: 12 });

const artifact: fc.Arbitrary<DataArtifact> = fc.record(
  {
    name: text,
    source: text,
    attributes: fields,
  },
  { requiredKeys: ["name"] },
);

Deno.test("renderDataBox: every line of the box has one visible width within the content limit", () => {
  setColorEnabled(false);
  try {
    fc.assert(
      fc.property(
        fc.array(artifact, { maxLength: 3 }),
        fc.option(fields, { nil: undefined }),
        (artifacts, globalArguments) => {
          const lines = renderDataBox(artifacts, { globalArguments });
          if (lines.length === 0) return;
          const widths = lines.filter((line) => line !== "").map((line) =>
            unicodeWidth(line)
          );
          assertEquals(new Set(widths).size, 1, lines.join("\n"));
          assert(widths[0] <= 86, lines.join("\n"));
          assert(
            !lines.some((line) => line.includes("\x1b")),
            lines.join("\n"),
          );
        },
      ),
    );
  } finally {
    setColorEnabled(true);
  }
});
