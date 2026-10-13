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
  parseWriterLeaseKey,
  releasedKey,
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
