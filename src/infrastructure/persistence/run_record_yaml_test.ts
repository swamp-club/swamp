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
import { parse as parseYaml } from "@std/yaml";
import { writeRunRecordYaml } from "./run_record_yaml.ts";

const char = (code: number) => String.fromCharCode(code);
// YAML 1.2 c-printable, plus the line feed the writer emits between lines.
const YAML_PRINTABLE =
  // deno-lint-ignore no-control-regex
  /^[\x09\x0a\x0d\x20-\x7e\x85\xa0-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]*$/u;

function roundTrip(record: Record<string, unknown>): unknown {
  return parseYaml(writeRunRecordYaml(record));
}

function assertRoundTrips(record: Record<string, unknown>): void {
  const back = roundTrip(record);
  assertEquals(back, record);
  // assertEquals ignores key order; the unchanged-save check does not
  assertEquals(JSON.stringify(back), JSON.stringify(record));
}

function valueLine(value: unknown): string {
  return writeRunRecordYaml({ v: value }).slice("v: ".length, -1);
}

Deno.test("writeRunRecordYaml: writes block-style YAML for a nested record", () => {
  const record = {
    id: "0b8aa429-1811-4ae8-988a-ff9df43defe8",
    workflowName: "bench",
    status: "succeeded",
    startedAt: "2026-11-11T14:39:13.716Z",
    count: 3,
    ratio: 0.5,
    done: true,
    parent: null,
    tags: {},
    inputs: [],
    jobs: [
      {
        jobName: "main",
        steps: [
          { stepName: "s1", dataArtifacts: [] },
          { stepName: "s2", output: { lines: ["a b", "c"] } },
        ],
      },
    ],
    grid: [[1, 2], [], [{ x: 1 }], {}],
  };
  assertEquals(
    writeRunRecordYaml(record),
    [
      "id: 0b8aa429-1811-4ae8-988a-ff9df43defe8",
      "workflowName: bench",
      "status: succeeded",
      'startedAt: "2026-11-11T14:39:13.716Z"',
      "count: 3",
      "ratio: 0.5",
      "done: true",
      "parent: null",
      "tags: {}",
      "inputs: []",
      "jobs:",
      "- jobName: main",
      "  steps:",
      "  - stepName: s1",
      "    dataArtifacts: []",
      "  - stepName: s2",
      "    output:",
      "      lines:",
      '      - "a b"',
      "      - c",
      "grid:",
      "- - 1",
      "  - 2",
      "- []",
      "- - x: 1",
      "- {}",
      "",
    ].join("\n"),
  );
  assertRoundTrips(record);
});

Deno.test("writeRunRecordYaml: an empty record is {} and never an empty document", () => {
  assertEquals(writeRunRecordYaml({}), "{}\n");
  assertEquals(roundTrip({}), {});
});

Deno.test("writeRunRecordYaml: writes plain only the strings no YAML type can claim", () => {
  for (
    const plain of [
      "a",
      "running",
      "_x",
      "/usr/bin/env",
      "command/shell",
      "a.b-c_d@e/f",
      "Z9",
      "nan",
      "Infinity",
    ]
  ) {
    assertEquals(valueLine(plain), plain, plain);
    assertRoundTrips({ [plain]: plain });
  }
  for (
    const quoted of [
      "",
      "0",
      "-1",
      "1e3",
      "0x1F",
      "0o7",
      "1_000",
      ".inf",
      ".nan",
      "2026-11-11",
      "2026-11-11T14:39:13.716Z",
      "a b",
      "a:b",
      "a#b",
      "-x",
      "?x",
      ":x",
      "!x",
      "&x",
      "*x",
      "%x",
      "@x",
      "`x",
      "|x",
      ">x",
      "'x",
      '"x',
      "#x",
      ".x",
      "~",
      "<<",
      "a,b",
      "[a]",
      "{a}",
      "\u00e9",
    ]
  ) {
    assertEquals(valueLine(quoted), JSON.stringify(quoted), quoted);
    assertRoundTrips({ [quoted]: quoted });
  }
});

Deno.test("writeRunRecordYaml: quotes every reserved word in every case", () => {
  const words = ["true", "false", "null", "yes", "no", "on", "off", "y", "n"];
  for (const word of words) {
    const upper = word.toUpperCase();
    const title = word[0].toUpperCase() + word.slice(1);
    const mixed = [...word].map((c, i) => i % 2 ? c.toUpperCase() : c).join(
      "",
    );
    for (const form of [word, upper, title, mixed]) {
      assertEquals(valueLine(form), JSON.stringify(form), form);
      assertRoundTrips({ [form]: form });
    }
  }
});

Deno.test("writeRunRecordYaml: a lowercase canonical UUID is plain and reads back as a string", () => {
  for (
    const uuid of [
      "0b8aa429-1811-4ae8-988a-ff9df43defe8",
      "12345678-1234-1234-1234-123456789012",
      "1e345678-1234-1234-1234-123456789012",
      "00000000-0000-0000-0000-000000000000",
    ]
  ) {
    assertEquals(valueLine(uuid), uuid, uuid);
    assertRoundTrips({ [uuid]: uuid });
  }
  for (
    const notCanonical of [
      "0B8AA429-1811-4AE8-988A-FF9DF43DEFE8",
      "{0b8aa429-1811-4ae8-988a-ff9df43defe8}",
      "0b8aa429-1811-4ae8-988a-ff9df43defe",
      "0b8aa4291-811-4ae8-988a-ff9df43defe8",
      "0b8aa4291811-4ae8-988a-ff9df43defe8",
    ]
  ) {
    assertEquals(valueLine(notCanonical), JSON.stringify(notCanonical));
    assertRoundTrips({ [notCanonical]: notCanonical });
  }
});

Deno.test("writeRunRecordYaml: numbers, booleans and null are written as JSON writes them", () => {
  for (
    const value of [
      0,
      -1,
      1.5,
      1e21,
      -1e-7,
      5e-324,
      1.7976931348623157e308,
      Number.MAX_SAFE_INTEGER,
      true,
      false,
      null,
    ]
  ) {
    assertEquals(valueLine(value), JSON.stringify(value));
    assertRoundTrips({ v: value });
  }
});

Deno.test("writeRunRecordYaml: strings with whitespace, breaks and escapes round-trip", () => {
  assertRoundTrips({
    v: [
      " lead",
      "trail ",
      "  ",
      "a\nb",
      "a\r\nb",
      "line\n",
      "\t",
      "back\\slash",
      'say "hi"',
      "it's",
      "a: b # c",
      "- item",
      "x".repeat(5000),
      "word ".repeat(400),
    ],
  });
});

Deno.test("writeRunRecordYaml: escapes the characters JSON leaves raw but YAML forbids or reads as breaks", () => {
  const raw = [
    0x7f,
    0x80,
    0x85,
    0x9f,
    0x2028,
    0x2029,
    0xfeff,
    0xfffe,
    0xffff,
  ];
  for (const code of raw) {
    const text = `a${char(code)}b`;
    const line = valueLine(text);
    assertEquals(
      line,
      `"a\\u${code.toString(16).padStart(4, "0")}b"`,
      code.toString(16),
    );
    assertRoundTrips({ [text]: text });
  }
  assertRoundTrips({ v: char(0xfeff) + "start" });
  assertRoundTrips({ v: char(0xa0) + char(0xd7ff) + char(0xe000) });
});

Deno.test("writeRunRecordYaml: control characters, lone surrogates and astral characters round-trip", () => {
  const controls = Array.from({ length: 32 }, (_, code) => char(code)).join("");
  assertRoundTrips({ v: controls, [controls]: 1 });
  assertRoundTrips({
    high: char(0xd800),
    low: `x${char(0xdfff)}y`,
    reversed: char(0xdc00) + char(0xd800),
    emoji: "\u{1f600}",
    [char(0xd83d)]: "key",
  });
});

Deno.test("writeRunRecordYaml: special and long keys round-trip", () => {
  assertRoundTrips({
    "": "empty",
    "<<": { merge: "not" },
    "~": "tilde",
    "-": "dash",
    "?": "question",
    ":": "colon",
    "null": null,
    "1": "number-like",
    "a b": "space",
    ["k".repeat(2000)]: "plain long key",
    ["k ".repeat(1000)]: "quoted long key",
  });
});

Deno.test("writeRunRecordYaml: a key longer than YAML's implicit-key limit is written as an explicit key", () => {
  const atLimit = "k".repeat(1024);
  const overLimit = "k".repeat(1025);
  const quotedOver = "k ".repeat(512);
  const record = {
    [atLimit]: 1,
    [overLimit]: "scalar",
    [quotedOver]: { nested: [1, [2]] },
    list: [{ [overLimit]: [3] }, { [overLimit]: {} }],
  };
  assertEquals(
    writeRunRecordYaml(record),
    [
      `${atLimit}: 1`,
      `? ${overLimit}`,
      ": scalar",
      `? ${JSON.stringify(quotedOver)}`,
      ":",
      "  nested:",
      "  - 1",
      "  - - 2",
      "list:",
      `- ? ${overLimit}`,
      "  :",
      "    - 3",
      `- ? ${overLimit}`,
      "  : {}",
      "",
    ].join("\n"),
  );
  assertRoundTrips(record);
});

Deno.test("writeRunRecordYaml: a __proto__ key reads back as an own property", () => {
  const record = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}');
  const back = roundTrip(record) as Record<string, unknown>;
  assert(Object.hasOwn(back, "__proto__"));
  assertEquals(Object.getPrototypeOf(back), Object.prototype);
  assertEquals(JSON.stringify(back), JSON.stringify(record));
  assertEquals(({} as Record<string, unknown>).polluted, undefined);
});

Deno.test("writeRunRecordYaml: empty collections inside sequences and mappings round-trip", () => {
  assertRoundTrips({
    v: [[], {}, [[]], [{}], [[], [[]]], { a: [], b: {}, c: [{}] }],
    nested: { deeper: { deepest: [] } },
  });
});

Deno.test("writeRunRecordYaml: output holds only YAML-printable characters and ends in one newline", () => {
  const everyBmpUnit = Array.from({ length: 0x10000 }, (_, code) => char(code))
    .join("");
  const output = writeRunRecordYaml({ [everyBmpUnit]: everyBmpUnit });
  assert(YAML_PRINTABLE.test(output));
  assert(output.endsWith("\n") && !output.endsWith("\n\n"));
  assertRoundTrips({ [everyBmpUnit]: everyBmpUnit });
});

Deno.test("writeRunRecordYaml: 500 levels of alternating nesting round-trip", () => {
  const depth = 500;
  let value: unknown = "leaf";
  for (let level = 0; level < depth; level++) {
    value = level % 2 === 0 ? [value] : { k: value };
  }
  const record = { v: value };
  const expected = JSON.stringify(record);
  assertEquals(JSON.stringify(roundTrip(record)), expected);
});

Deno.test("writeRunRecordYaml: refuses a value JSON cannot hold", () => {
  assertThrows(
    () => writeRunRecordYaml({ v: undefined }),
    TypeError,
    "only JSON values",
  );
  assertThrows(() => writeRunRecordYaml({ v: [1n] }), TypeError, "bigint");
});
