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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  jsonStringChunks,
  prettyJson,
  prettyJsonChunks,
  writeJsonValue,
  writeTextChunks,
} from "./json_stream.ts";
import {
  deeplyNestedAttributes,
  nestedTreeDepth,
  prettyNestedText,
} from "./json_stream_test_helpers.ts";

function collectingSink(maxPerWrite = Infinity) {
  const parts: Uint8Array[] = [];
  return {
    sink: (bytes: Uint8Array) => {
      const n = Math.min(bytes.length, maxPerWrite);
      parts.push(bytes.slice(0, n));
      return Promise.resolve(n);
    },
    text: () =>
      new TextDecoder().decode(new Uint8Array(parts.flatMap((p) => [...p]))),
  };
}

Deno.test("prettyJsonChunks: joins to JSON.stringify with two-space indent, skipping what JSON skips", () => {
  const value = {
    a: [1, undefined, "é\n", { b: undefined, c: [] }, {}],
    d: new Date(0),
    e: () => 1,
    "__proto__x": null,
    f: { toJSON: () => undefined },
    g: [{ toJSON: () => undefined }],
  };
  assertEquals(
    [...prettyJsonChunks(value)].join(""),
    JSON.stringify(value, null, 2),
  );
});

Deno.test("writeJsonValue: a sink that takes part of each write still receives the whole value and a newline", async () => {
  const value = { step: { key: "x".repeat(200_000), other: [true, null] } };
  const out = collectingSink(7_000);
  await writeJsonValue(value, out.sink);
  assertEquals(out.text(), JSON.stringify(value, null, 2) + "\n");
});

Deno.test("writeTextChunks: writes the pieces verbatim and adds nothing", async () => {
  const out = collectingSink(3);
  await writeTextChunks(["a", "", "é\n", "bc"], out.sink);
  assertEquals(out.text(), "aé\nbc");
});

Deno.test("writeTextChunks: many pieces reach the sink as bounded batches, not one write", async () => {
  const piece = "y".repeat(1000);
  const sizes: number[] = [];
  await writeTextChunks(Array.from({ length: 2000 }, () => piece), (bytes) => {
    sizes.push(bytes.length);
    return Promise.resolve(bytes.length);
  });
  assertEquals(sizes.reduce((a, b) => a + b, 0), 2_000_000);
  assertEquals(sizes.length > 1, true);
  assertEquals(Math.max(...sizes) < 2_000_000, true);
});

Deno.test("writeTextChunks: a piece of at least a batch is written on its own, not joined to queued pieces", async () => {
  const big = "z".repeat(200_000);
  const writes: string[] = [];
  await writeTextChunks(["a", "b", big, "c"], (bytes) => {
    writes.push(new TextDecoder().decode(bytes));
    return Promise.resolve(bytes.length);
  });
  assertEquals(writes, ["ab", big, "c"]);
});

Deno.test("writeTextChunks: nothing to write makes no write", async () => {
  let calls = 0;
  await writeTextChunks([], () => {
    calls++;
    return Promise.resolve(0);
  });
  assertEquals(calls, 0);
});

Deno.test("writeJsonValue: a value whose JSON is too large for one string is written whole", async () => {
  const mebibyte = "x".repeat(1024 * 1024);
  const outputs: Record<string, string> = {};
  // distinct top-level keys, as when each resource has its own attribute
  for (let i = 0; i < 600; i++) outputs[`key-${i}`] = mebibyte;
  let written = 0;
  let last = 0;
  await writeJsonValue({ step: outputs }, (bytes) => {
    written += bytes.length;
    last = bytes[bytes.length - 1];
    return Promise.resolve(bytes.length);
  });

  let expected = '{\n  "step": {\n'.length + "  }\n}\n".length;
  for (let i = 0; i < 600; i++) {
    expected += `    "key-${i}": "`.length + mebibyte.length + 1 +
      (i < 599 ? 2 : 1);
  }
  assertEquals(written, expected);
  assertEquals(last, "\n".charCodeAt(0));
});

// past the depth a recursive walk survives; pretty output grows with depth
// squared, so the chunks are checked in place rather than joined
const DEEP = 5_000;

Deno.test("prettyNestedText: matches JSON.stringify where its recursion survives", () => {
  for (const depth of [0, 1, 2, 50]) {
    assertEquals(
      prettyNestedText(depth),
      JSON.stringify(deeplyNestedAttributes(depth), null, 2),
    );
  }
});

Deno.test("prettyJsonChunks: a deeply nested value yields JSON.stringify(value, null, 2) piece by piece", () => {
  const value = deeplyNestedAttributes(DEEP);
  const expected = prettyNestedText(DEEP);
  let offset = 0;
  for (const chunk of prettyJsonChunks(value)) {
    assertEquals(expected.startsWith(chunk, offset), true);
    offset += chunk.length;
  }
  assertEquals(offset, expected.length);
});

Deno.test("writeJsonValue: a deeply nested value is written whole", async () => {
  const value = deeplyNestedAttributes(DEEP);
  const expectedBytes =
    new TextEncoder().encode(prettyNestedText(DEEP)).length +
    1;
  let written = 0;
  let last = 0;
  await writeJsonValue(value, (bytes) => {
    written += bytes.length;
    last = bytes[bytes.length - 1];
    return Promise.resolve(bytes.length);
  });
  assertEquals(written, expectedBytes);
  assertEquals(last, "\n".charCodeAt(0));
});

Deno.test("writeJsonValue: a closed pipe ends the write quietly after the first failed write", async () => {
  const value = { rows: Array.from({ length: 50_000 }, (_, i) => i) };
  let calls = 0;
  await writeJsonValue(value, () => {
    calls++;
    return Promise.reject(new Deno.errors.BrokenPipe("Broken pipe"));
  });
  assertEquals(calls, 1);
});

Deno.test("writeJsonValue: a sink error other than a closed pipe rejects", async () => {
  await assertRejects(
    () =>
      writeJsonValue({ a: 1 }, () => Promise.reject(new Error("disk full"))),
    Error,
    "disk full",
  );
});

Deno.test("prettyJson: returns JSON.stringify(value, null, 2), and still does past its depth limit", () => {
  const shallow = {
    a: [1, undefined, "é\n", { b: undefined }],
    d: new Date(0),
  };
  assertEquals(prettyJson(shallow), JSON.stringify(shallow, null, 2));
  assertEquals(
    prettyJson(deeplyNestedAttributes(DEEP)),
    prettyNestedText(DEEP),
  );
  const tooDeep = deeplyNestedAttributes(6_000);
  assertThrows(() => JSON.stringify(tooDeep, null, 2), RangeError);
  assertEquals(nestedTreeDepth(JSON.parse(prettyJson(tooDeep))), {
    depth: 6_000,
    leaf: [0, 1, 2],
  });
});

const joinChunks = (chunks: Iterable<string>) => [...chunks].join("");

Deno.test("jsonStringChunks: a string at the slice size is one JSON.stringify call", () => {
  assertEquals([...jsonStringChunks("abcd", 4)], ['"abcd"']);
});

Deno.test("jsonStringChunks: a longer string is escaped in slices that join to JSON.stringify", () => {
  const text = 'a"b\\c\nd\u0001e\u2028f';
  const chunks = [...jsonStringChunks(text, 3)];
  assertEquals(chunks.length > 3, true);
  assertEquals(chunks.join(""), JSON.stringify(text));
});

Deno.test("jsonStringChunks: never splits a surrogate pair at a slice boundary", () => {
  const text = "ab\u{1F600}cd\u{1F600}";
  for (let slice = 2; slice <= text.length; slice++) {
    const chunks = [...jsonStringChunks(text, slice)];
    assertEquals(chunks.join(""), JSON.stringify(text), `slice ${slice}`);
    for (const chunk of chunks) {
      assertEquals(chunk.includes("\\ud83d"), false, `slice ${slice}`);
    }
  }
});

Deno.test("jsonStringChunks: a lone surrogate at either end of a slice is escaped as JSON.stringify does", () => {
  const text = "\ud800abc\udc00de\ud800";
  for (let slice = 2; slice <= text.length; slice++) {
    assertEquals(
      joinChunks(jsonStringChunks(text, slice)),
      JSON.stringify(text),
      `slice ${slice}`,
    );
  }
});

Deno.test("prettyJsonChunks: long string values and keys are sliced, joining to JSON.stringify", () => {
  const value = {
    long: "x".repeat(50),
    nested: [1, null, true, { k: "y".repeat(20), when: new Date(0) }],
    dropped: undefined,
    ["k".repeat(30)]: ["v".repeat(50)],
  };
  const chunks = [...prettyJsonChunks(value, 8)];
  assertEquals(chunks.join(""), JSON.stringify(value, null, 2));
  for (const chunk of chunks) {
    assertEquals(chunk.length <= 8 + 4, true, `chunk ${chunk}`);
  }
});

Deno.test("jsonStringChunks: a slice size under two is raised to two, so slicing always advances", () => {
  const text = "ab\u{1F600}c";
  for (const slice of [0, -3, 1, 1.5]) {
    assertEquals(
      joinChunks(jsonStringChunks(text, slice)),
      JSON.stringify(text),
      `slice ${slice}`,
    );
  }
});
