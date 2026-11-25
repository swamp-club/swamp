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
  assert,
  assertEquals,
  assertInstanceOf,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  defaultResourceLoadGuard,
  distinctBitsFor,
  DistinctStrings,
  estimateParsedJsonBytes,
  type HeapProbe,
  MAX_DECODABLE_BYTES,
  PARSE_ESTIMATE_MARGIN,
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

// a distinct key adds its layout and its string, a distinct short value its string
const keyCost = (length: number) => 40 + 24 + Math.ceil(length / 8) * 8;
const stringCost = (length: number) => 24 + Math.ceil(length / 8) * 8;

Deno.test("estimateParsedJsonBytes: prices each object, array and array element", () => {
  assertEquals(estimateParsedJsonBytes(encode("{}")), 56);
  assertEquals(estimateParsedJsonBytes(encode("[]")), 48);
  assertEquals(estimateParsedJsonBytes(encode("[1, 2, 3]")), 48 + 3 * 8);
  assertEquals(estimateParsedJsonBytes(encode("[[1],[]]")), 48 + 16 + 56 + 48);
  assertEquals(
    estimateParsedJsonBytes(encode('[{"a":1},{}]')),
    48 + 16 + 112 + keyCost(1),
  );
});

Deno.test("estimateParsedJsonBytes: an object's first four members are in the object, the rest cost a slot each", () => {
  const four = '{"a":1,"b":2,"c":3,"d":4}';
  const six = '{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6}';
  assertEquals(estimateParsedJsonBytes(encode(four)), 56 + 4 * keyCost(1));
  assertEquals(
    estimateParsedJsonBytes(encode(six)),
    56 + 2 * 8 + 6 * keyCost(1),
  );
});

const objectOf = (members: number) =>
  Object.fromEntries(Array.from({ length: members }, (_, i) => ["k" + i, i]));

Deno.test("estimateParsedJsonBytes: an object wider than V8 keeps in fast mode costs a dictionary entry per member", () => {
  // the same keys in many objects, so only the members' layout differs
  const fast = encode(JSON.stringify(Array(100).fill(objectOf(64))));
  const wide = encode(JSON.stringify(Array(100).fill(objectOf(65))));
  const keys = (n: number) =>
    Array.from({ length: n }, (_, i) => keyCost(String("k" + i).length))
      .reduce((a, b) => a + b, 0);
  assertEquals(
    estimateParsedJsonBytes(fast),
    48 + 100 * 8 + 100 * (56 + 60 * 8) + keys(64),
  );
  assertEquals(
    estimateParsedJsonBytes(wide),
    48 + 100 * 8 + 100 * (56 + 65 * 48) + keys(65),
  );
});

Deno.test("estimateParsedJsonBytes: keys and short values cost once per distinct string, at the distinct ones' length", () => {
  const sharedKeys = encode(JSON.stringify(Array(1000).fill({ id: 1 })));
  assertEquals(
    estimateParsedJsonBytes(sharedKeys),
    48 + 1000 * 8 + 1000 * 56 + keyCost(2),
  );
  const uniqueKeys = encode(
    JSON.stringify(
      Array.from({ length: 1000 }, (_, i) => ({ ["key" + i]: 1 })),
    ),
  );
  const unique = estimateParsedJsonBytes(uniqueKeys) -
    (48 + 1000 * 8 + 1000 * 56);
  // linear counting is within a few percent while the bitmap is far from full
  assertEquals(
    Math.abs(unique - 1000 * keyCost(6)) < 1000 * keyCost(6) * 0.02,
    true,
  );

  const repeated = encode(JSON.stringify(Array(1000).fill("ok")));
  assertEquals(
    estimateParsedJsonBytes(repeated),
    48 + 1000 * 8 + stringCost(2),
  );
});

Deno.test("estimateParsedJsonBytes: many repeated short keys do not dilute the length of a few long distinct ones", () => {
  const uuids = Object.fromEntries(
    Array.from({ length: 500 }, (_, i) => [crypto.randomUUID() + i, 0]),
  );
  const records = Array.from({ length: 20_000 }, () => ({ id: 1, n: 2 }));
  const mixed = encode(JSON.stringify([uuids, records]));
  const withoutKeys = 48 + 16 + (56 + 500 * 48) +
    (48 + 20_000 * 8 + 20_000 * 56);
  const keys = estimateParsedJsonBytes(mixed) - withoutKeys;
  // 500 long distinct keys among many repeated short ones, never priced at the short length
  assertEquals(keys >= 500 * keyCost(36), true);
});

Deno.test("estimateParsedJsonBytes: a value string longer than V8 shares is its own string each time", () => {
  const long = "x".repeat(12);
  assertEquals(
    estimateParsedJsonBytes(encode(JSON.stringify(Array(100).fill(long)))),
    48 + 100 * 8 + 100 * stringCost(12),
  );
});

Deno.test("estimateParsedJsonBytes: fractions and wide integers among non-numbers are heap numbers, a pure number array is not", () => {
  const mixed = encode(JSON.stringify([1.5, "a", 12345678901, 7]));
  assertEquals(
    estimateParsedJsonBytes(mixed),
    48 + 4 * 8 + 2 * 16 + stringCost(1),
  );
  const pure = encode(JSON.stringify([1.5, 2.5, 12345678901, 7]));
  assertEquals(estimateParsedJsonBytes(pure), 48 + 4 * 8);
  assertEquals(estimateParsedJsonBytes(encode("[1e5, true]")), 48 + 16 + 16);
});

Deno.test("estimateParsedJsonBytes: braces, brackets and commas inside strings cost only the string's length", () => {
  const value = 'a,b:{c}[d],\\"[{,'.repeat(1000);
  const plain = "x".repeat(JSON.stringify(value).length - 2);
  assertEquals(
    estimateParsedJsonBytes(encode(JSON.stringify({ log: value }))),
    estimateParsedJsonBytes(encode(JSON.stringify({ log: plain }))),
  );
});

Deno.test("estimateParsedJsonBytes: an escaped quote does not end a string", () => {
  const text = JSON.stringify(['say "[1,2]"', "{"]);
  const plain = JSON.stringify(["x".repeat(13), "y"]);
  assertEquals(
    estimateParsedJsonBytes(encode(text)),
    estimateParsedJsonBytes(encode(plain)),
  );
});

Deno.test("estimateParsedJsonBytes: an array of strings holds one slot per string, and its distinct short strings once", () => {
  assertEquals(
    estimateParsedJsonBytes(encode(JSON.stringify(["", "x", "yy"]))),
    48 + 3 * 8 + 3 * stringCost(1),
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

Deno.test("estimateParsedJsonBytes: containers still open at the end are priced as if they closed there", () => {
  assertEquals(estimateParsedJsonBytes(encode("a, b, c\n1, 2, 3")), 0);
  assertEquals(estimateParsedJsonBytes(encode("]]}} plain")), 0);
  // the parse builds the open arrays before it fails at the end
  assertEquals(
    estimateParsedJsonBytes(encode("[[[1, 2")),
    (48 + 2 * 8) + (48 + 8) + (48 + 8),
  );
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
  assertEquals(estimateParsedJsonBytes(ndjson), 56 + keyCost(2));
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

// FNV-1a of a distinct string per integer, as the estimator hashes it but unseeded
const spread = (i: number) => {
  let hash = 0x811c9dc5;
  for (const byte of encode("s" + i)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash;
};

Deno.test("DistinctStrings: counts distinct strings within a few percent while the bitmap is far from full", () => {
  const distinct = new DistinctStrings(1 << 16, 0);
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 5000; i++) distinct.add(spread(i), 8);
  }
  const counted = distinct.bytes(0) / stringCost(8);
  assertEquals(Math.abs(counted - 5000) < 5000 * 0.03, true);
});

Deno.test("DistinctStrings: a full bitmap counts every string it saw, never fewer", () => {
  const distinct = new DistinctStrings(64, 0);
  for (let i = 0; i < 1000; i++) distinct.add(spread(i), 8);
  assertEquals(distinct.bytes(0), 1000 * stringCost(8));
});

Deno.test("DistinctStrings: prices at the average length of the distinct strings, not of every occurrence", () => {
  const distinct = new DistinctStrings(1 << 16);
  distinct.add(spread(1), 36);
  for (let i = 0; i < 10_000; i++) distinct.add(spread(2), 1);
  assertEquals(distinct.bytes(0), 2 * stringCost((36 + 1) / 2));
});

const words = "the quick brown fox jumps over the lazy dog".split(" ");
const sentence = (i: number, n: number) =>
  Array.from({ length: n }, (_, j) => words[(i + j) % words.length]).join(" ");

// each admitted by three times its bytes, each costing more once parsed
const expensive: Record<string, unknown> = {
  "a map of unique keys": Object.fromEntries(
    Array.from({ length: 10_000 }, (_, i) => ["id-" + i, 0]),
  ),
  "unique short strings": Array.from({ length: 10_000 }, (_, i) => "s" + i),
  "fractions among strings": Array.from(
    { length: 10_000 },
    (_, i) => i % 2 ? i + 0.5 : "a",
  ),
};

Deno.test("ResourceLoadGuard.assertParsable: refuses shapes that parse to more than three times their bytes", () => {
  for (const [name, value] of Object.entries(expensive)) {
    const content = encode(JSON.stringify(value));
    const guard = new ResourceLoadGuard(probe(content.length * 3, 0), 1);
    guard.assertLoadable(item, content.length);
    assertThrows(
      () => guard.assertParsable(item, content),
      ResourceTooLargeToLoadError,
      undefined,
      name,
    );
  }
});

// each shape's parse cost in multiples of its bytes, text included
const ordinary: [string, unknown, number][] = [
  [
    "small objects",
    Array.from({ length: 10_000 }, () => ({ a: 1, b: "xyzxyzxyz" })),
    3.0,
  ],
  ["numbers", Array.from({ length: 10_000 }, (_, i) => i * 1.5), 1.88],
  [
    "records with long text",
    Array.from({ length: 2_000 }, (_, i) => ({
      id: "rec-" + i,
      title: sentence(i, 6),
      description: sentence(i, 30),
      status: i % 3 ? "active" : "closed",
    })),
    2.27,
  ],
  ["a single large text", { body: sentence(1, 50_000) }, 2.0],
];

Deno.test("estimateParsedJsonBytes: ordinary shapes are estimated within 1.6 times their measured cost", () => {
  for (const [name, value, measured] of ordinary) {
    const content = encode(JSON.stringify(value));
    const estimate = Math.max(
      3 * content.length,
      content.length + PARSE_ESTIMATE_MARGIN * estimateParsedJsonBytes(content),
    );
    assert(
      estimate <= 1.6 * measured * content.length,
      `${name}: ${(estimate / content.length).toFixed(2)} times its bytes`,
    );
  }
});

Deno.test("estimateParsedJsonBytes: NDJSON and log text stay priced by their first value", () => {
  const ndjson = encode(
    Array.from(
      { length: 1000 },
      (_, i) =>
        JSON.stringify({ ts: "2026-11-25T00:00:00Z", msg: sentence(i, 8) }),
    )
      .join("\n"),
  );
  assertEquals(estimateParsedJsonBytes(ndjson) < 1000, true);
  const log = encode("2026-11-25 [INFO] {served} in 12 ms\n".repeat(1000));
  assertEquals(estimateParsedJsonBytes(log), 0);
});

Deno.test("ResourceLoadGuard.assertParsable: adds the margin to the structure estimate before deciding", () => {
  const content = encode(JSON.stringify(Array(1000).fill([])));
  const structure = estimateParsedJsonBytes(content);
  const limit = content.length + structure + 1;
  assertEquals(content.length * 3 < limit, true);
  assertEquals(PARSE_ESTIMATE_MARGIN > 1, true);
  assertThrows(
    () =>
      new ResourceLoadGuard(probe(limit, 0), 1).assertParsable(item, content),
    ResourceTooLargeToLoadError,
  );
});

Deno.test("ResourceLoadGuard.assertParsable: refuses an item whose scan stopped past the cap, at any rounding", () => {
  const dense = encode(JSON.stringify(Array(9).fill("")));
  // 132 bytes of headroom over 1.1 is just under the 120 the array alone costs
  const guard = new ResourceLoadGuard(probe(dense.length + 132, 0), 10);
  assertThrows(
    () => guard.assertParsable(item, dense),
    ResourceTooLargeToLoadError,
  );
});

Deno.test("estimateParsedJsonBytes: fractions and wide integers in object fields are each a heap number", () => {
  const fractions = encode(
    JSON.stringify({ a: 0.5, b: 0.5, c: 12345678901, d: 7 }),
  );
  const integers = encode(JSON.stringify({ a: 1, b: 2, c: 3, d: 7 }));
  assertEquals(
    estimateParsedJsonBytes(fractions) - estimateParsedJsonBytes(integers),
    3 * 16,
  );
});

Deno.test("estimateParsedJsonBytes: a string holding a character past Latin-1 is priced at two bytes per UTF-16 unit, and the text too", () => {
  const ascii = "a".repeat(40);
  const wide = "a".repeat(38) + "ж";
  assertEquals(encode(wide).length, encode(ascii).length);
  const asciiText = encode(JSON.stringify([ascii]));
  const wideText = encode(JSON.stringify([wide]));
  // 39 characters, one of them two UTF-8 bytes; the decoded text is two-byte too
  const textUnits = wideText.length - 1;
  assertEquals(
    estimateParsedJsonBytes(wideText),
    48 + 8 + stringCost(2 * 39) + (2 * textUnits - wideText.length),
  );
  assertEquals(estimateParsedJsonBytes(asciiText), 48 + 8 + stringCost(40));
});

Deno.test("estimateParsedJsonBytes: Latin-1 accents stay one byte per character, an escape past Latin-1 makes only its string two-byte", () => {
  const latin = encode(JSON.stringify(["é".repeat(20)]));
  assertEquals(estimateParsedJsonBytes(latin), 48 + 8 + stringCost(20));
  // the text stays ASCII, so only the decoded string is two-byte
  const escaped = encode('["\\u4e2d' + "a".repeat(20) + '"]');
  assertEquals(estimateParsedJsonBytes(escaped), 48 + 8 + stringCost(2 * 26));
});

Deno.test("estimateParsedJsonBytes: escapes of ASCII and Latin-1, as Go and Python write them, stay one-byte", () => {
  for (const escape of ["\\u003c", "\\u0026", "\\u00e9"]) {
    const text = encode('["' + escape + "a".repeat(20) + '"]');
    assertEquals(
      estimateParsedJsonBytes(text),
      48 + 8 + stringCost(26),
      escape,
    );
  }
});

Deno.test("DistinctStrings: refuses a bitmap size that is not a power of two of 8 or more", () => {
  for (const size of [0, 4, 100, 1000]) {
    assertThrows(() => new DistinctStrings(size), RangeError);
  }
  new DistinctStrings(8);
});

Deno.test("estimateParsedJsonBytes: CJK and astral characters are priced by UTF-16 units, not UTF-8 bytes", () => {
  const cjk = encode(JSON.stringify(["中".repeat(20)]));
  // 60 UTF-8 bytes, 20 units at two bytes; the text holds 2 + 20 + 2 units
  assertEquals(
    estimateParsedJsonBytes(cjk),
    48 + 8 + stringCost(2 * 20) + Math.max(0, 2 * 24 - cjk.length),
  );
  const emoji = encode(JSON.stringify(["😀".repeat(10)]));
  // each is four UTF-8 bytes and two UTF-16 units
  assertEquals(
    estimateParsedJsonBytes(emoji),
    48 + 8 + stringCost(2 * 20) + Math.max(0, 2 * 24 - emoji.length),
  );
});

const withBytes = (before: string, bytes: number[], after: string) => {
  const head = encode(before);
  const tail = encode(after);
  const all = new Uint8Array(head.length + bytes.length + tail.length);
  all.set(head);
  all.set(bytes, head.length);
  all.set(tail, head.length + bytes.length);
  return all;
};

Deno.test("estimateParsedJsonBytes: invalid UTF-8 decodes to U+FFFD, so its string and the text are two-byte", () => {
  const ascii = withBytes('["' + "a".repeat(30), [0x61], '"]');
  const plain = estimateParsedJsonBytes(ascii);
  for (
    const [name, bytes] of [
      ["a stray continuation", [0x80]],
      ["an overlong pair, well formed but for its lead", [0xc0, 0x80]],
      ["a lead past U+10FFFF", [0xf5]],
      ["a Latin-1 lead cut short by the closing quote", [0xc3]],
    ] as [string, number[]][]
  ) {
    const invalid = withBytes('["' + "a".repeat(30), bytes, '"]');
    assert(estimateParsedJsonBytes(invalid) > plain, name);
  }
});

Deno.test("estimateParsedJsonBytes: a character past Latin-1 after the first value still makes the text two-byte", () => {
  const asciiTail = encode('{"a":1}\n' + '{"b":"plain"}\n'.repeat(100));
  const wideTail = encode('{"a":1}\n' + '{"b":"жжжжж"}\n'.repeat(100));
  // the same first value; only the decoded text differs
  assertEquals(estimateParsedJsonBytes(asciiTail), 56 + keyCost(1));
  assert(estimateParsedJsonBytes(wideTail) > 56 + keyCost(1));
});

Deno.test("DistinctStrings: hashes that agree in their low bits still count as distinct", () => {
  const distinct = new DistinctStrings(1 << 16, 0);
  // unmixed, both would pick the same bit
  distinct.add(5, 8);
  distinct.add(5 + (1 << 16), 8);
  assertEquals(distinct.bytes(0), 2 * stringCost(8));
});

Deno.test("distinctBitsFor: sizes the bitmap to the content, between 64 bits and the 1 MiB cap", () => {
  assertEquals(distinctBitsFor(0), 64);
  assertEquals(distinctBitsFor(1), 64);
  assertEquals(distinctBitsFor(200), 16_384);
  assertEquals(distinctBitsFor(1 << 20), 1 << 23);
  assertEquals(distinctBitsFor(1 << 30), 1 << 23);
});

Deno.test("estimateParsedJsonBytes: a second byte TextDecoder refuses decodes each byte to U+FFFD, more units than the valid sequence", () => {
  for (
    const [name, invalid, valid] of [
      ["an overlong three-byte sequence", [0xe0, 0x80, 0x80], [
        0xe0,
        0xa0,
        0x80,
      ]],
      ["an encoded surrogate", [0xed, 0xa0, 0x80], [0xed, 0x9f, 0x80]],
      ["an overlong four-byte sequence", [0xf0, 0x80, 0x80, 0x80], [
        0xf0,
        0x90,
        0x80,
        0x80,
      ]],
      ["a sequence past U+10FFFF", [0xf4, 0x90, 0x80, 0x80], [
        0xf4,
        0x8f,
        0x80,
        0x80,
      ]],
    ] as [string, number[], number[]][]
  ) {
    const prefix = '["' + "a".repeat(30);
    assert(
      estimateParsedJsonBytes(withBytes(prefix, invalid, '"]')) >
        estimateParsedJsonBytes(withBytes(prefix, valid, '"]')),
      name,
    );
  }
});

Deno.test("DistinctStrings: a few distinct strings are counted exactly, never in the bitmap", () => {
  // a bitmap this small would be full, and count every string seen twice over
  const distinct = new DistinctStrings(64);
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 100; i++) distinct.add(spread(i), 8);
  }
  assertEquals(distinct.bytes(0), 100 * stringCost(8));
});

Deno.test("DistinctStrings: past the exact limit the count carries into the bitmap", () => {
  const distinct = new DistinctStrings(1 << 20, 10);
  for (let i = 0; i < 2000; i++) distinct.add(spread(i), 8);
  const counted = distinct.bytes(0) / stringCost(8);
  assertEquals(Math.abs(counted - 2000) < 2000 * 0.02, true);
});

Deno.test("DistinctStrings: strings that collide as they move into the bitmap do not inflate the average length", () => {
  // forty strings into 64 bits collide, so only the bits they set may carry a length
  const distinct = new DistinctStrings(64, 40);
  for (let i = 0; i < 41; i++) distinct.add(spread(i), 8);
  assert(distinct.bytes(0) <= 41 * stringCost(8), `${distinct.bytes(0)}`);
});
