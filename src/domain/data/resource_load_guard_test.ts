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
