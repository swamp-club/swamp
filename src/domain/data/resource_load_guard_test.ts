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

import {
  assertEquals,
  assertInstanceOf,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  defaultResourceLoadGuard,
  estimateParsedJsonBytes,
  type HeapProbe,
  MAX_DECODABLE_BYTES,
  parseTooLargeToLoad,
  ResourceLoadGuard,
  resourceLoadGuardOf,
  ResourceTooLargeToLoadError,
} from "./resource_load_guard.ts";
import { UserError } from "../errors.ts";

function probe(limit: number, used: number): HeapProbe & { reads: number } {
  const p = {
    reads: 0,
    heapLimitBytes: () => {
      p.reads++;
      return limit;
    },
    heapUsedBytes: () => used,
  };
  return p;
}

const item = {
  modelType: "@repro/bigdata",
  modelName: "big",
  dataName: "blob-0",
  version: 3,
};

Deno.test("ResourceLoadGuard.assertLoadable: an item below the floor is never refused or measured", () => {
  const p = probe(100, 99);
  new ResourceLoadGuard(p, 50).assertLoadable(item, 49);
  assertEquals(p.reads, 0);
});

Deno.test("ResourceLoadGuard.assertLoadable: admits an item whose parse fits in the heap left", () => {
  new ResourceLoadGuard(probe(1000, 100), 50).assertLoadable(item, 300);
});

Deno.test("ResourceLoadGuard.assertLoadable: refuses an item needing three times its size past the heap left", () => {
  const error = assertThrows(
    () => new ResourceLoadGuard(probe(1000, 100), 50).assertLoadable(item, 301),
    ResourceTooLargeToLoadError,
  );
  assertInstanceOf(error, UserError);
  assertEquals(error.code, "resource_too_large_to_load");
  assertEquals(error.item, item);
  assertEquals(error.bytes, 301);
});

Deno.test("ResourceTooLargeToLoadError: names the item and size and the query to find large items, never heap figures", () => {
  const error = new ResourceTooLargeToLoadError(item, 419429501);
  assertStringIncludes(error.message, "big/blob-0@v3");
  assertStringIncludes(error.message, "400.0 MiB (419429501 bytes)");
  assertStringIncludes(error.message, "--sort size:desc");
  assertEquals(error.message.includes("heap"), false);
});

Deno.test("ResourceTooLargeToLoadError: falls back to the model type and omits an unnamed version", () => {
  const error = new ResourceTooLargeToLoadError(
    { modelType: "@repro/bigdata", dataName: "blob-0" },
    1,
  );
  assertStringIncludes(error.message, "Cannot load @repro/bigdata/blob-0:");
});

Deno.test("resourceLoadGuardOf: uses a holder's guard, else the default", () => {
  const guard = new ResourceLoadGuard(probe(1, 0), 1);
  assertEquals(resourceLoadGuardOf({ loadGuard: guard }), guard);
  assertEquals(resourceLoadGuardOf({}), defaultResourceLoadGuard);
  assertEquals(resourceLoadGuardOf(undefined), defaultResourceLoadGuard);
});

Deno.test("ResourceLoadGuard.refusalFor: refuses past the text-length limit without measuring the heap", () => {
  const p = probe(10_000, 0);
  const refusal = new ResourceLoadGuard(p, 50, 200).refusalFor(item, 201);
  assertInstanceOf(refusal, ResourceTooLargeToLoadError);
  assertEquals(refusal.reason, "text-length");
  assertEquals(refusal.bytes, 201);
  assertEquals(p.reads, 0);
  assertStringIncludes(refusal.message, "Cannot load big/blob-0@v3:");
  assertStringIncludes(refusal.message, "more than swamp can load as text");
});

Deno.test("ResourceLoadGuard.refusalFor: admits an item at the text-length limit that fits the heap", () => {
  const guard = new ResourceLoadGuard(probe(10_000, 0), 50, 200);
  assertEquals(guard.refusalFor(item, 200), undefined);
  assertEquals(guard.refusalFor(item, 0), undefined);
});

Deno.test("ResourceLoadGuard.refusalFor: returns the heap refusal assertLoadable throws, never throwing", () => {
  const guard = new ResourceLoadGuard(probe(1000, 100), 50, 10_000);
  const refusal = guard.refusalFor(item, 301);
  assertInstanceOf(refusal, ResourceTooLargeToLoadError);
  assertEquals(refusal.reason, "memory");
  assertStringIncludes(refusal.message, "exhaust the memory");
});

Deno.test("ResourceLoadGuard.refusalFor: an item under the floor is measured once held bytes lift the total past it", () => {
  const p = probe(100, 90);
  const guard = new ResourceLoadGuard(p, 50, 10_000);
  assertEquals(guard.refusalFor(item, 40), undefined);
  assertEquals(p.reads, 0);
  const refusal = guard.refusalFor(item, 40, 10);
  assertInstanceOf(refusal, ResourceTooLargeToLoadError);
  assertEquals(refusal.bytes, 40);
  assertEquals(refusal.reason, "memory");
});

Deno.test("ResourceLoadGuard.refusalFor: held bytes never enter the heap estimate", () => {
  const guard = new ResourceLoadGuard(probe(1000, 100), 50, 10_000);
  assertEquals(guard.refusalFor(item, 300, 1_000_000), undefined);
  assertInstanceOf(
    guard.refusalFor(item, 301, 1_000_000),
    ResourceTooLargeToLoadError,
  );
});

Deno.test("ResourceLoadGuard.assertLoadable: leaves the text-length limit to refusalFor", () => {
  new ResourceLoadGuard(probe(10_000, 0), 50, 200).assertLoadable(item, 201);
});

Deno.test("ResourceLoadGuard: the default text-length limit is V8's maximum string length", () => {
  assertEquals(MAX_DECODABLE_BYTES, 2 ** 29 - 24);
  assertEquals(new ResourceLoadGuard().maxDecodableBytes, MAX_DECODABLE_BYTES);
});

Deno.test("parseTooLargeToLoad: reads a stored marker and rejects any malformed one", () => {
  assertEquals(parseTooLargeToLoad({ bytes: 5, reason: "text-length" }), {
    bytes: 5,
    reason: "text-length",
  });
  assertEquals(parseTooLargeToLoad({ bytes: 5, reason: "memory" }), {
    bytes: 5,
    reason: "memory",
  });
  assertEquals(parseTooLargeToLoad(undefined), undefined);
  assertEquals(
    parseTooLargeToLoad({ bytes: "5", reason: "memory" }),
    undefined,
  );
  assertEquals(parseTooLargeToLoad({ bytes: 5, reason: "other" }), undefined);
  assertEquals(
    parseTooLargeToLoad({ bytes: Infinity, reason: "memory" }),
    undefined,
  );
});

const encode = (text: string) => new TextEncoder().encode(text);

Deno.test("estimateParsedJsonBytes: prices each object, array and array element", () => {
  assertEquals(estimateParsedJsonBytes(encode("{}")), 56);
  assertEquals(estimateParsedJsonBytes(encode("[]")), 48);
  assertEquals(estimateParsedJsonBytes(encode("[1, 2, 3]")), 48 + 3 * 8);
  assertEquals(estimateParsedJsonBytes(encode('[{"a":1},{}]')), 48 + 16 + 112);
});

Deno.test("estimateParsedJsonBytes: an object's first four members are in the object, the rest cost a slot each", () => {
  const four = '{"a":1,"b":2,"c":3,"d":4}';
  const six = '{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6}';
  assertEquals(estimateParsedJsonBytes(encode(four)), 56);
  assertEquals(estimateParsedJsonBytes(encode(six)), 56 + 2 * 8);
});

Deno.test("estimateParsedJsonBytes: braces, brackets and commas inside strings cost nothing", () => {
  const text = JSON.stringify({ log: 'a,b:{c}[d],\\"[{,'.repeat(1000) });
  assertEquals(estimateParsedJsonBytes(encode(text)), 56);
});

Deno.test("estimateParsedJsonBytes: an escaped quote does not end a string", () => {
  const text = JSON.stringify(['say "[1,2]"', "{"]);
  assertEquals(estimateParsedJsonBytes(encode(text)), 48 + 2 * 8);
});

Deno.test("estimateParsedJsonBytes: an array of strings holds one slot per string", () => {
  assertEquals(
    estimateParsedJsonBytes(encode(JSON.stringify(["", "x", "yy"]))),
    48 + 3 * 8,
  );
});

Deno.test("estimateParsedJsonBytes: whitespace and pretty-printing change nothing", () => {
  const value = { a: [1, { b: [] }], c: {} };
  assertEquals(
    estimateParsedJsonBytes(encode(JSON.stringify(value, null, 2))),
    estimateParsedJsonBytes(encode(JSON.stringify(value))),
  );
});

Deno.test("estimateParsedJsonBytes: nesting thousands deep is counted without recursion", () => {
  const depth = 100_000;
  const text = "[".repeat(depth) + "]".repeat(depth);
  assertEquals(
    estimateParsedJsonBytes(encode(text)),
    48 * depth + 8 * (depth - 1),
  );
});

Deno.test("estimateParsedJsonBytes: text that is not JSON never costs more than its balanced containers", () => {
  assertEquals(estimateParsedJsonBytes(encode("a, b, c\n1, 2, 3")), 0);
  assertEquals(estimateParsedJsonBytes(encode("[[[, , ,")), 0);
  assertEquals(estimateParsedJsonBytes(encode("]]}} plain")), 0);
});

// a heap of 1000 and a floor of 50: three times 300 bytes fits, the parse of
// 100 empty strings does not
const dense = encode(JSON.stringify(Array(100).fill("")));
const sparse = encode(JSON.stringify(["x".repeat(dense.length - 4)]));

Deno.test("ResourceLoadGuard.assertParsable: refuses dense JSON the byte factor passes", () => {
  const guard = new ResourceLoadGuard(probe(1000, 0), 50);
  guard.assertLoadable(item, dense.length);
  const error = assertThrows(
    () => guard.assertParsable(item, dense),
    ResourceTooLargeToLoadError,
  );
  assertEquals(error.bytes, dense.length);
  assertEquals(error.reason, "memory");
});

Deno.test("ResourceLoadGuard.assertParsable: loads sparse JSON of the same size", () => {
  assertEquals(sparse.length, dense.length);
  new ResourceLoadGuard(probe(1000, 0), 50).assertParsable(item, sparse);
});

Deno.test("ResourceLoadGuard.assertParsable: content below the floor is never scanned or refused", () => {
  const p = probe(10, 9);
  new ResourceLoadGuard(p, dense.length + 1).assertParsable(item, dense);
  assertEquals(p.reads, 0);
});

Deno.test("ResourceLoadGuard.assertParsable: never estimates below the byte factor", () => {
  const text = encode(JSON.stringify("x".repeat(400)));
  assertThrows(
    () => new ResourceLoadGuard(probe(1000, 0), 50).assertParsable(item, text),
    ResourceTooLargeToLoadError,
  );
});

Deno.test("ResourceLoadGuard.parseRefusalFor: returns the structure refusal, and the text-length one first", () => {
  const guard = new ResourceLoadGuard(probe(1000, 0), 50, dense.length + 10);
  assertInstanceOf(
    guard.parseRefusalFor(item, dense),
    ResourceTooLargeToLoadError,
  );
  assertEquals(guard.parseRefusalFor(item, sparse), undefined);
  const long = new Uint8Array(dense.length + 11);
  assertEquals(guard.parseRefusalFor(item, long)?.reason, "text-length");
});

Deno.test("ResourceLoadGuard.parseRefusalFor: held bytes lift content under the floor into the structure scan", () => {
  const p = probe(1000, 0);
  const guard = new ResourceLoadGuard(p, dense.length + 1, dense.length + 10);
  assertEquals(guard.parseRefusalFor(item, dense), undefined);
  assertEquals(p.reads, 0);
  assertInstanceOf(
    guard.parseRefusalFor(item, dense, 1),
    ResourceTooLargeToLoadError,
  );
});

Deno.test("estimateParsedJsonBytes: stops once the count passes cap, returning a figure over it", () => {
  const deep = encode("[".repeat(1_000_000));
  const estimate = estimateParsedJsonBytes(deep, 4800);
  assertEquals(estimate > 4800, true);
  assertEquals(estimate <= 4800 + 48, true);
  const wide = encode(JSON.stringify(Array(10_000).fill([])));
  assertEquals(estimateParsedJsonBytes(wide, 1000) > 1000, true);
  assertEquals(estimateParsedJsonBytes(wide, 1000) < 2000, true);
  // the inner array alone passes the cap when it closes, so the outer is not counted
  const nested = encode(JSON.stringify([Array(200).fill(1)]));
  assertEquals(estimateParsedJsonBytes(nested), 48 + 8 * 200 + 48 + 8);
  assertEquals(estimateParsedJsonBytes(nested, 1000), 48 + 8 * 200);
});

Deno.test("estimateParsedJsonBytes: ordinary log text with bracketed tags stays under the byte factor", () => {
  const log = encode(
    "2026-11-24T22:00:00Z [INFO] request served in 12 ms for /api/data\n"
      .repeat(1000),
  );
  assertEquals(
    log.length + estimateParsedJsonBytes(log) < log.length * 3,
    true,
  );
});

Deno.test("estimateParsedJsonBytes: prices only the first top-level value, as JSON.parse builds no more before failing", () => {
  const ndjson = encode('{"id":1}\n'.repeat(10_000));
  assertEquals(estimateParsedJsonBytes(ndjson), 56);
  const tagged = encode("[INFO] served\n[INFO] served\n".repeat(10_000));
  assertEquals(estimateParsedJsonBytes(tagged), 48 + 8);
});

Deno.test("estimateParsedJsonBytes: content that does not open with an object or array costs nothing", () => {
  for (
    const text of [
      "2026-11-24T22:00:00Z [INFO] {a} [b]\n".repeat(1000),
      '"a string with [brackets] and {braces}"',
      "42",
      "",
      "   ",
    ]
  ) {
    assertEquals(estimateParsedJsonBytes(encode(text)), 0);
  }
  assertEquals(estimateParsedJsonBytes(encode("  \n [1, 2]")), 48 + 16);
});

Deno.test("estimateParsedJsonBytes: a leading byte-order mark is skipped, as TextDecoder drops it before the parse", () => {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const body = encode(JSON.stringify(Array(100).fill({})));
  const withBom = new Uint8Array(bom.length + body.length);
  withBom.set(bom);
  withBom.set(body, bom.length);
  assertEquals(estimateParsedJsonBytes(withBom), estimateParsedJsonBytes(body));
  assertEquals(estimateParsedJsonBytes(body) > 0, true);
  assertEquals(JSON.parse(new TextDecoder().decode(withBom)).length, 100);
});
