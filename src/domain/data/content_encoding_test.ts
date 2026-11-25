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

import { assertEquals, assertThrows } from "@std/assert";
import {
  decodePreview,
  encodeContent,
  encodeLoadableContent,
} from "./content_encoding.ts";
import {
  ResourceLoadGuard,
  ResourceTooLargeToLoadError,
} from "./resource_load_guard.ts";

const PNG_HEADER = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x00,
  0x00,
  0x00,
  0x0d,
]);

Deno.test("encodeContent: returns ASCII as utf-8 text", () => {
  const result = encodeContent(new TextEncoder().encode("hello world\n"));
  assertEquals(result, { content: "hello world\n", contentEncoding: "utf-8" });
});

Deno.test("encodeContent: returns multi-byte UTF-8 as utf-8 text", () => {
  const text = "héllo wörld ✓ — 日本語 🐊";
  const result = encodeContent(new TextEncoder().encode(text));
  assertEquals(result, { content: text, contentEncoding: "utf-8" });
});

Deno.test("encodeContent: base64-encodes PNG bytes losslessly", () => {
  const result = encodeContent(PNG_HEADER);
  assertEquals(result.contentEncoding, "base64");
  assertEquals(result.content, "iVBORw0KGgoAAAAN");
  assertEquals(Uint8Array.fromBase64(result.content), PNG_HEADER);
});

Deno.test("encodeContent: base64-encodes a lone continuation byte", () => {
  const bytes = new Uint8Array([0x61, 0x80, 0x62]);
  const result = encodeContent(bytes);
  assertEquals(result.contentEncoding, "base64");
  assertEquals(Uint8Array.fromBase64(result.content), bytes);
});

Deno.test("encodeContent: base64-encodes a truncated multi-byte sequence", () => {
  const bytes = new Uint8Array([0x6f, 0x6b, 0xe2, 0x9c]);
  const result = encodeContent(bytes);
  assertEquals(result.contentEncoding, "base64");
  assertEquals(Uint8Array.fromBase64(result.content), bytes);
});

Deno.test("encodeContent: returns empty input as empty utf-8 text", () => {
  const result = encodeContent(new Uint8Array());
  assertEquals(result, { content: "", contentEncoding: "utf-8" });
});

Deno.test("encodeContent: drops a leading byte-order mark from utf-8 text", () => {
  const json = new TextEncoder().encode('{"a":1}');
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...json]);
  const result = encodeContent(bytes);
  assertEquals(result, { content: '{"a":1}', contentEncoding: "utf-8" });
});

const item = { modelType: "m", modelName: "m", dataName: "d", version: 1 };

function guard(
  limit: number,
  used: number,
  maxDecodableBytes = 10_000,
): ResourceLoadGuard {
  return new ResourceLoadGuard(
    {
      heapLimitBytes: () => limit,
      heapUsedBytes: () => used,
    },
    50,
    maxDecodableBytes,
  );
}

Deno.test("encodeLoadableContent: encodes what the guard admits as encodeContent does", () => {
  const text = new TextEncoder().encode("hello\n");
  assertEquals(
    encodeLoadableContent(guard(1000, 0), item, text),
    encodeContent(text),
  );
  const binary = new Uint8Array([0xff, 0xfe, 0x00]);
  assertEquals(
    encodeLoadableContent(guard(1000, 0), item, binary),
    encodeContent(binary),
  );
});

Deno.test("encodeLoadableContent: refuses bytes the heap cannot hold, with held bytes and remedy in the message", () => {
  const error = assertThrows(
    () =>
      encodeLoadableContent(
        guard(1000, 900),
        item,
        new Uint8Array(40),
        20,
        "fewer, please",
      ),
    ResourceTooLargeToLoadError,
  );
  assertEquals(error.reason, "memory");
  assertEquals(error.detail.heldBytes, 20);
  assertEquals(error.detail.remedy, "fewer, please");
});

Deno.test("encodeLoadableContent: refuses a binary body whose base64 form passes the text limit, and keeps UTF-8 text of its size", () => {
  const error = assertThrows(
    () =>
      encodeLoadableContent(
        guard(1_000_000, 0, 400),
        item,
        new Uint8Array(320).fill(0xff),
      ),
    ResourceTooLargeToLoadError,
  );
  assertEquals(error.reason, "text-length");
  assertEquals(error.bytes, 320);
  assertEquals(error.detail.encodedChars, 428);
  const text = new TextEncoder().encode("x".repeat(320));
  assertEquals(
    encodeLoadableContent(guard(1_000_000, 0, 400), item, text),
    { content: "x".repeat(320), contentEncoding: "utf-8" },
  );
});

Deno.test("decodePreview: returns all of a short body, and the start of a long one without a broken character", () => {
  assertEquals(decodePreview(new TextEncoder().encode("abc"), 3), {
    text: "abc",
    truncated: false,
  });
  // the euro sign is three bytes; a cut inside it drops it, never U+FFFD
  const bytes = new TextEncoder().encode("ab\u20accd");
  assertEquals(decodePreview(bytes, 3), { text: "ab", truncated: true });
  assertEquals(decodePreview(bytes, 5), { text: "ab\u20ac", truncated: true });
});
