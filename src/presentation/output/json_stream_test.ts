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
import { prettyJsonChunks, writeJsonValue } from "./json_stream.ts";

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
