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
  fenceKey,
  heartbeatKey,
  judgeWriterLease,
  parseWriterLeaseKey,
  releasedKey,
  SERVE_WRITER_LEASE_TTL_MS,
  UNKNOWN_HOLDER_LEASE_TTL_MS,
  WRITER_LEASE_CLOCK_SKEW_MS,
} from "./writer_lease.ts";

const MAX_FENCE = 999_999_999_999;

const KINDS = [
  ["fence", fenceKey],
  ["heartbeat", heartbeatKey],
  ["released", releasedKey],
] as const;

const arbKind = fc.constantFrom(...KINDS);
// Short fences too, so unpadded renderings of them come up.
const arbFence = fc.oneof(
  fc.integer({ min: 1, max: 999 }),
  fc.integer({ min: 1, max: MAX_FENCE }),
);

Deno.test("parseWriterLeaseKey: reads back every key the constructors write", () => {
  fc.assert(
    fc.property(arbKind, arbFence, ([kind, key], fence) => {
      assertEquals(parseWriterLeaseKey(key(fence)), { kind, fence });
    }),
  );
});

Deno.test("parseWriterLeaseKey: ignores a fence written with any other digit count", () => {
  fc.assert(
    fc.property(
      arbKind,
      arbFence,
      fc.integer({ min: 1, max: 24 }).filter((digits) => digits !== 12),
      ([kind], fence, digits) => {
        const written = String(fence);
        fc.pre(written.length <= digits);
        const key = `writer/${kind}-${written.padStart(digits, "0")}`;
        assertEquals(parseWriterLeaseKey(key), undefined);
      },
    ),
  );
});

Deno.test("parseWriterLeaseKey: ignores a 12-digit fence of zero", () => {
  for (const [kind] of KINDS) {
    assertEquals(parseWriterLeaseKey(`writer/${kind}-000000000000`), undefined);
  }
});

// The holder counts itself confirmed for its TTL after it asked for its last
// good renewal (v3WriterLeaseConfirmed); a taker on a clock off by less than
// the skew must judge it held for all of that time, or two leaders serve.
Deno.test("judgeWriterLease: a holder still confirmed by its own clock is held by any taker within the clock skew", () => {
  const T0 = Date.parse("2026-11-17T12:00:00.000Z");
  fc.assert(
    fc.property(
      fc.constantFrom(SERVE_WRITER_LEASE_TTL_MS, UNKNOWN_HOLDER_LEASE_TTL_MS),
      fc.integer({ min: 0, max: 600_000 }),
      fc.integer({ min: 0, max: 20_000 }),
      fc.integer({
        min: -WRITER_LEASE_CLOCK_SKEW_MS,
        max: WRITER_LEASE_CLOCK_SKEW_MS,
      }),
      fc.integer({ min: -60_000, max: 60_000 }),
      fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
      (ttlMs, acquiredAfter, putLatency, offsetDiff, holderOffset, into) => {
        const asked = T0 + acquiredAfter;
        const takerOffset = holderOffset + offsetDiff;
        // the heartbeat is stamped by the holder's clock once the put is made
        const renewedAt = asked + putLatency + holderOffset;
        const confirmedUntil = asked + ttlMs;
        const t = asked + Math.floor(into * (confirmedUntil - asked));
        const verdict = judgeWriterLease(
          {
            fence: 3,
            record: {
              fence: 3,
              holder: "serve@host-a",
              hostname: "host-a",
              pid: 100,
              nonce: "n",
              ttlMs,
              acquiredAt: new Date(T0 + holderOffset).toISOString(),
            },
            renewedAt,
            released: false,
          },
          {
            now: t + takerOffset,
            judgeHolder: () => "unknown",
            ttlMs: SERVE_WRITER_LEASE_TTL_MS,
          },
        );
        assertEquals(verdict.kind, "held");
      },
    ),
  );
});
