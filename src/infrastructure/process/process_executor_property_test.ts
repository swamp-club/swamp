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

import { assert } from "@std/assert";
import fc from "fast-check";
import { streamLines } from "./process_executor.ts";
import { SecretRedactor } from "../../domain/secrets/secret_redactor.ts";

const text = (maxLength: number) =>
  fc.array(fc.constantFrom("a", "b", "\r", "\n"), { maxLength })
    .map((chars) => chars.join(""));

function chunkedStream(
  value: string,
  cuts: number[],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const offsets = [...new Set(cuts.map((cut) => cut % (value.length + 1)))]
    .sort((a, b) => a - b);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let start = 0;
      for (const offset of [...offsets, value.length]) {
        if (offset > start) {
          controller.enqueue(encoder.encode(value.slice(start, offset)));
        }
        start = Math.max(start, offset);
      }
      controller.close();
    },
  });
}

Deno.test("streamLines + SecretRedactor: a secret in CRLF-normalised output is always redacted", async () => {
  await fc.assert(
    fc.asyncProperty(
      text(8).filter((secret) => secret.includes("a")),
      text(4),
      text(4),
      fc.array(fc.nat(), { maxLength: 4 }),
      async (secret, before, after, cuts) => {
        fc.pre(secret.length >= 3);
        const redactor = new SecretRedactor();
        redactor.addSecret(secret);

        const captured = await streamLines(
          chunkedStream(before + secret + after, cuts),
          undefined,
          undefined,
          { normalizeCrlf: true },
        );
        const redacted = redactor.redact(captured);

        const normalised = secret.replace(/\r(?=\n|$)/g, "");
        assert(
          !redacted.includes(secret),
          `secret ${JSON.stringify(secret)} survived in ${
            JSON.stringify(redacted)
          }`,
        );
        if (normalised.length >= 3) {
          assert(
            !redacted.includes(normalised),
            `normalised secret ${JSON.stringify(normalised)} survived in ${
              JSON.stringify(redacted)
            }`,
          );
        }
      },
    ),
    { numRuns: 2000 },
  );
});

Deno.test("streamLines: normalizeCrlf output equals the LF form of the input", async () => {
  await fc.assert(
    fc.asyncProperty(
      text(16),
      fc.array(fc.nat(), { maxLength: 6 }),
      async (value, cuts) => {
        const withCrlf = await streamLines(
          chunkedStream(value, cuts),
          undefined,
          undefined,
          { normalizeCrlf: true },
        );
        const lfOnly = await streamLines(
          chunkedStream(value.replace(/\r\n/g, "\n"), cuts),
        );
        assert(
          withCrlf === lfOnly,
          `${JSON.stringify(value)}: ${JSON.stringify(withCrlf)} !== ${
            JSON.stringify(lfOnly)
          }`,
        );
      },
    ),
    { numRuns: 2000 },
  );
});

/** the re-splitting collector streamLines replaced, kept as the oracle */
async function referenceLines(
  pieces: readonly Uint8Array[],
  normalizeCrlf: boolean,
): Promise<{ text: string; lines: string[] }> {
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let buffer = "";
  for (const piece of pieces) {
    buffer += decoder.decode(piece, { stream: true });
    const bufferLines = buffer.split("\n");
    for (let i = 0; i < bufferLines.length - 1; i++) {
      lines.push(
        normalizeCrlf && bufferLines[i].endsWith("\r")
          ? bufferLines[i].slice(0, -1)
          : bufferLines[i],
      );
    }
    buffer = bufferLines[bufferLines.length - 1];
  }
  if (buffer) lines.push(buffer);
  return await Promise.resolve({ text: lines.join("\n"), lines });
}

function byteSplitStream(
  bytes: Uint8Array,
  cuts: number[],
): { stream: ReadableStream<Uint8Array>; pieces: Uint8Array[] } {
  const offsets = [...new Set(cuts.map((cut) => cut % (bytes.length + 1)))]
    .sort((a, b) => a - b);
  const pieces: Uint8Array[] = [];
  let start = 0;
  for (const offset of [...offsets, bytes.length]) {
    if (offset > start) pieces.push(bytes.slice(start, offset));
    start = offset;
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(piece);
      controller.close();
    },
  });
  return { stream, pieces };
}

Deno.test("streamLines: matches the re-splitting collector for any text cut at any byte, multi-byte characters included", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom("a", "\r", "\n", "é", "€", "😀"), {
        maxLength: 60,
      }).map((chars) => chars.join("")),
      fc.array(fc.nat(), { maxLength: 12 }),
      fc.boolean(),
      async (value, cuts, normalizeCrlf) => {
        const bytes = new TextEncoder().encode(value);
        const { stream, pieces } = byteSplitStream(bytes, cuts);
        const seen: string[] = [];
        const text = await streamLines(
          stream,
          (line) => seen.push(line),
          undefined,
          { normalizeCrlf },
        );
        const expected = await referenceLines(pieces, normalizeCrlf);
        assert(
          text === expected.text,
          `text ${JSON.stringify(text)} != ${JSON.stringify(expected.text)}`,
        );
        assert(
          JSON.stringify(seen) === JSON.stringify(expected.lines),
          `lines ${JSON.stringify(seen)} != ${JSON.stringify(expected.lines)}`,
        );
      },
    ),
    { numRuns: 500 },
  );
});
