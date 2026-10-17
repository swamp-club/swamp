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

import { assertEquals, assertRejects } from "@std/assert";
import { createHash } from "node:crypto";
import {
  STAGED_CONTENT_CHANGED_CODE,
  StagedContentChangedError,
  verifiedContentStream,
} from "./verified_content_stream.ts";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return ReadableStream.from(chunks.map((chunk) => encoder.encode(chunk)));
}

async function read(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

Deno.test("verifiedContentStream: passes the staged content through unchanged", async () => {
  assertEquals(
    await read(
      verifiedContentStream(streamOf("ab", "cd"), "/f", {
        size: 4,
        sha256: sha256("abcd"),
      }),
    ),
    "abcd",
  );
  assertEquals(
    await read(verifiedContentStream(streamOf("abcd"), "/f", { size: 4 })),
    "abcd",
  );
});

Deno.test("verifiedContentStream: a file that shrank, grew or changed in place fails the read", async () => {
  for (
    const [chunks, staged] of [
      [["abc"], { size: 4 }],
      [["abcde"], { size: 4 }],
      [["abzd"], { size: 4, sha256: sha256("abcd") }],
    ] as const
  ) {
    const error = await assertRejects(
      () => read(verifiedContentStream(streamOf(...chunks), "/f", staged)),
      StagedContentChangedError,
    );
    assertEquals(error.code, STAGED_CONTENT_CHANGED_CODE);
  }
});
