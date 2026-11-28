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
import { STREAMING_JSON_SLICE_UNITS, StreamingJson } from "./streaming_json.ts";

async function bytesOf(json: StreamingJson): Promise<Uint8Array> {
  return await new Response(ReadableStream.from(json.chunks())).bytes();
}

function thrownBy(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("expected a throw");
}

Deno.test("StreamingJson.resolve: throws JSON.stringify's own TypeError for a BigInt", () => {
  const data = { n: 1n, long: "x".repeat(10) };
  const expected = thrownBy(() => JSON.stringify(data));
  const error = assertThrows(
    () => StreamingJson.resolve(data, { longStringUnits: 2 }),
    TypeError,
  );
  assertEquals(error.message, expected.message);
});

Deno.test("StreamingJson.resolve: throws JSON.stringify's own TypeError for a cycle", () => {
  const data: Record<string, unknown> = { long: "x".repeat(10) };
  data.self = { back: data };
  const expected = thrownBy(() => JSON.stringify(data));
  const error = assertThrows(
    () => StreamingJson.resolve(data, { longStringUnits: 2 }),
    TypeError,
  );
  assertEquals(error.message, expected.message);
});

Deno.test("StreamingJson: reads the value once, calling each toJSON and getter once whatever it counts or writes", async () => {
  let toJsonCalls = 0;
  let getterCalls = 0;
  const keys: string[] = [];
  const data = {
    nested: {
      toJSON(key: string) {
        toJsonCalls++;
        keys.push(key);
        return "y".repeat(20);
      },
    },
    get computed() {
      getterCalls++;
      return "z".repeat(20);
    },
    list: [{ toJSON: (key: string) => (keys.push(key), key) }],
  };
  const json = StreamingJson.resolve(data, {
    longStringUnits: 4,
    sliceUnits: 3,
  });
  json.byteLength();
  await bytesOf(json);
  await bytesOf(json);
  assertEquals(toJsonCalls, 1);
  assertEquals(getterCalls, 1);
  assertEquals(keys, ["nested", "0"]);
});

Deno.test("StreamingJson: at the default slice size a pair across the slice edge and a lone surrogate on it escape as JSON.stringify escapes them", async () => {
  const edge = STREAMING_JSON_SLICE_UNITS - 1;
  const paired = "a".repeat(edge) + "😀" + "b".repeat(10);
  const lone = "a".repeat(edge) + "\ud83d" + "b".repeat(10);
  const loneLow = "a".repeat(edge + 1) + "\ude00" + '"\n'.repeat(10);
  for (const long of [paired, lone, loneLow]) {
    const data = { long, after: [long, 1] };
    const json = StreamingJson.resolve(data);
    assert(json.streams);
    const expected = new TextEncoder().encode(JSON.stringify(data));
    assertEquals(await bytesOf(json), expected);
    assertEquals(json.byteLength(), expected.length);
  }
});

Deno.test("StreamingJson: a value JSON.stringify leaves undefined writes no bytes, as encoding undefined does", async () => {
  const json = StreamingJson.resolve({ toJSON: () => undefined });
  assertEquals(json.streams, false);
  assertEquals(json.bytes(), new Uint8Array());
  assertEquals(json.byteLength(), 0);
  assertEquals(await bytesOf(json), new Uint8Array());
});

Deno.test("StreamingJson: small output does not stream and is encoded whole", () => {
  const data = { value: "x".repeat(100), n: -0 };
  const json = StreamingJson.resolve(data);
  assertEquals(json.streams, false);
  assertEquals(json.bytes(), new TextEncoder().encode(JSON.stringify(data)));
});
