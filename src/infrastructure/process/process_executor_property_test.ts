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

/** Text over a small alphabet so line endings and repeats are frequent. */
const text = (maxLength: number) =>
  fc.array(fc.constantFrom("a", "b", "\r", "\n"), { maxLength })
    .map((chars) => chars.join(""));

/** Delivers the text split at the given offsets, one chunk per piece. */
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

        // What CRLF normalisation can leave of the secret's text.
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
