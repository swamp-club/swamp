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

// any JSON-clean record reads back identically, through the same parser older
// binaries and serve use

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { writeRunRecordYaml } from "./run_record_yaml.ts";

const char = (code: number) => String.fromCharCode(code);
// deno-lint-ignore no-control-regex
const YAML_PRINTABLE =
  /^[\x09\x0a\x0d\x20-\x7e\x85\xa0-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]*$/u;

const RESERVED = ["true", "false", "null", "yes", "no", "on", "off", "y", "n"];
const TRICKY = [
  ...RESERVED,
  ...RESERVED.map((word) => word.toUpperCase()),
  ...RESERVED.map((word) => word[0].toUpperCase() + word.slice(1)),
  "",
  "~",
  "<<",
  "-",
  "?",
  ":",
  "#",
  "@",
  "!",
  "&a",
  "*a",
  "|",
  ">",
  "'",
  '"',
  "\\",
  "%",
  "`",
  "0",
  "-0",
  "+1",
  "1e3",
  "1E-3",
  "0x1F",
  "0o17",
  "0b1",
  "1_000",
  ".5",
  "5.",
  ".inf",
  "-.Inf",
  ".NaN",
  "2026-11-11",
  "2026-11-11T14:39:13.716Z",
  "2026-11-11 14:39:13",
  "12:30:00",
  " lead",
  "trail ",
  "a\nb",
  "a\r\nb",
  "\n",
  "\t",
  "a: b",
  "a #b",
  "- a",
  "[a]",
  "{a: 1}",
  "__proto__",
  "constructor",
  char(0x7f),
  char(0x85),
  char(0x9f),
  char(0xa0),
  char(0x2028),
  char(0x2029),
  char(0xfeff),
  char(0xfffe),
  char(0xffff),
  char(0xd800),
  char(0xdfff),
  "\u{1f600}",
];

const tricky = fc.constantFrom(...TRICKY);
const baseString = fc.oneof(
  fc.string({ unit: "binary", maxLength: 24 }),
  fc.string({ maxLength: 24 }),
  tricky,
  fc.integer().map(String),
  fc.double().map(String),
  fc.uuid(),
  fc.uuid().map((uuid) => uuid.toUpperCase()),
  fc.date({ noInvalidDate: true }).map((date) => date.toISOString()),
);
const text = fc.oneof(
  { weight: 4, arbitrary: baseString },
  {
    weight: 1,
    arbitrary: fc.tuple(tricky, baseString, tricky).map((parts) =>
      parts.join("")
    ),
  },
);

const scalar = fc.oneof(
  text,
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.boolean(),
  fc.constant(null),
);

const { value } = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { depthSize: "small", maxDepth: 6 },
    scalar,
    fc.array(tie("value"), { maxLength: 4 }),
    fc.dictionary(text, tie("value"), { maxKeys: 4 }),
  ),
}));

// the JSON clone save() makes before writing
const record = fc.dictionary(text, value, { maxKeys: 6 }).map((raw) =>
  JSON.parse(JSON.stringify(raw)) as Record<string, unknown>
);

function assertSameRecord(actual: unknown, expected: unknown): void {
  assertEquals(actual, expected);
  // key order too: a save that changes it is never unchanged
  assertEquals(JSON.stringify(actual), JSON.stringify(expected));
}

Deno.test("writeRunRecordYaml: any string reads back as itself, as a value and as a key", () => {
  fc.assert(
    fc.property(text, (s) => {
      const back = parseYaml(writeRunRecordYaml({ [s]: s }));
      assertSameRecord(back, { [s]: s });
    }),
    { numRuns: 3000 },
  );
});

Deno.test("writeRunRecordYaml: any JSON-clean record reads back identically", () => {
  fc.assert(
    fc.property(record, (data) => {
      assertSameRecord(parseYaml(writeRunRecordYaml(data)), data);
    }),
    { numRuns: 1000 },
  );
});

Deno.test("writeRunRecordYaml: a record reads back as the same data @std/yaml stringify's output does", () => {
  fc.assert(
    fc.property(record, (data) => {
      let before: unknown;
      try {
        before = parseYaml(stringifyYaml(data));
      } catch {
        fc.pre(false);
      }
      // the new writer's contract is the round trip, not the old writer's quirks
      fc.pre(JSON.stringify(before) === JSON.stringify(data));
      assertSameRecord(parseYaml(writeRunRecordYaml(data)), before);
    }),
    { numRuns: 1000 },
  );
});

Deno.test("writeRunRecordYaml: writing what it read back gives the same bytes", () => {
  fc.assert(
    fc.property(record, (data) => {
      const written = writeRunRecordYaml(data);
      const again = writeRunRecordYaml(
        parseYaml(written) as Record<string, unknown>,
      );
      assertEquals(again, written);
    }),
    { numRuns: 500 },
  );
});

Deno.test("writeRunRecordYaml: output is YAML-printable and ends in exactly one newline", () => {
  fc.assert(
    fc.property(record, (data) => {
      const written = writeRunRecordYaml(data);
      assert(YAML_PRINTABLE.test(written));
      assert(written.endsWith("\n"));
      assert(!written.endsWith("\n\n"));
    }),
    { numRuns: 500 },
  );
});
