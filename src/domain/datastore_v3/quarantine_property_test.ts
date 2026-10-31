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
import fc from "fast-check";
import {
  chunksOf,
  chunksToWire,
  MAX_QUARANTINED_PER_PRINCIPAL,
  parseQuarantineRecord,
  parseQuarantineRecordKey,
  quarantineHasRoom,
  type QuarantineRecord,
  quarantineRecordKey,
  serializeQuarantineRecord,
} from "./quarantine.ts";

const arbText = fc.string({ minLength: 1, maxLength: 64 });
const arbHex = fc.stringMatching(/^[0-9a-f]{64}$/);
const arbRecord: fc.Arbitrary<QuarantineRecord> = fc.record({
  txnId: fc.uuid().map((id) => id.toLowerCase()),
  partition: arbText,
  principal: arbText,
  reason: arbText,
  depositedAt: arbText,
  bytes: fc.nat(),
  state: fc.constantFrom("held" as const, "accepted" as const),
}).chain((base) =>
  fc.record({
    acceptedBy: fc.option(arbText, { nil: undefined }),
    seq: fc.option(fc.integer({ min: 1, max: 2 ** 40 }), { nil: undefined }),
  }).map((extra) => ({
    ...base,
    ...(extra.acceptedBy === undefined ? {} : { acceptedBy: extra.acceptedBy }),
    ...(extra.seq === undefined ? {} : { seq: extra.seq }),
  }))
);

Deno.test("parseQuarantineRecord: every serialized record reads back as written", () => {
  fc.assert(
    fc.property(arbRecord, (record) => {
      assertEquals(parseQuarantineRecord(serializeQuarantineRecord(record)), {
        ...record,
      });
    }),
  );
});

Deno.test("parseQuarantineRecordKey: every record key names its state, txnId and author", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("held" as const, "accepted" as const),
      fc.uuid().map((id) => id.toLowerCase()),
      arbHex,
      (state, txnId, principalKey) => {
        assertEquals(
          parseQuarantineRecordKey(
            quarantineRecordKey(state, txnId, principalKey),
          ),
          { state, txnId, principalKey },
        );
      },
    ),
  );
});

Deno.test("chunksOf: every chunk put on the wire reads back with its bytes", async () => {
  await fc.assert(
    fc.asyncProperty(
      // Distinct contents: a chunk named twice is refused.
      fc.uniqueArray(fc.uint8Array({ maxLength: 256 }), {
        maxLength: 4,
        selector: (bytes) => [...bytes].join(","),
      }),
      async (contents) => {
        const chunks = await Promise.all(contents.map(async (bytes) => {
          const digest = await crypto.subtle.digest(
            "SHA-256",
            bytes as Uint8Array<ArrayBuffer>,
          );
          const sha256 = [...new Uint8Array(digest)].map((b) =>
            b.toString(16).padStart(2, "0")
          ).join("");
          return { sha256, bytes };
        }));
        assertEquals(await chunksOf(chunksToWire(chunks)), chunks);
      },
    ),
    { numRuns: 50 },
  );
});

Deno.test("quarantineHasRoom: an author never holds more than its cap, whatever others hold", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("a", "b", "c"), { maxLength: 120 }),
      (authors) => {
        const keys: string[] = [];
        const held = new Map<string, number>();
        for (const author of authors) {
          const principalKey = author.repeat(64);
          if (!quarantineHasRoom(keys, principalKey)) continue;
          keys.push(
            quarantineRecordKey("held", crypto.randomUUID(), principalKey),
          );
          held.set(author, (held.get(author) ?? 0) + 1);
        }
        for (const count of held.values()) {
          if (count > MAX_QUARANTINED_PER_PRINCIPAL) {
            throw new Error(`an author held ${count}`);
          }
        }
      },
    ),
  );
});
