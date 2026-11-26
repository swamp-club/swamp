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

import { assert, assertEquals, assertFalse } from "@std/assert";
import fc from "fast-check";
import {
  compareTickets,
  formatTicketName,
  nextSeq,
  parseTicketName,
  type WaitTicket,
} from "./lock_queue.ts";

const hex = (length: number) =>
  fc.stringMatching(new RegExp(`^[0-9a-f]{${length}}$`));

const ticketArb: fc.Arbitrary<WaitTicket> = fc.record({
  seq: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
  hostIdHash: hex(8),
  pid: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
  nonce: hex(32),
});

Deno.test("formatTicketName/parseTicketName: every ticket round-trips and its name never ends in .lock", () => {
  fc.assert(
    fc.property(ticketArb, (ticket) => {
      const name = formatTicketName(ticket);
      assertEquals(parseTicketName(name), ticket);
      assertFalse(/\.lock$/.test(name));
    }),
  );
});

Deno.test("compareTickets: a strict total order over distinct tickets", () => {
  fc.assert(
    fc.property(ticketArb, ticketArb, ticketArb, (a, b, c) => {
      const ab = compareTickets(a, b);
      const ba = compareTickets(b, a);
      assertEquals(Math.sign(ab), -Math.sign(ba));
      const sameKey = a.seq === b.seq && a.nonce === b.nonce;
      assertEquals(ab === 0, sameKey);
      if (ab < 0 && compareTickets(b, c) < 0) assert(compareTickets(a, c) < 0);
    }),
  );
});

Deno.test("compareTickets: sorting names as tickets keeps arrival order by seq", () => {
  fc.assert(
    fc.property(fc.array(ticketArb, { maxLength: 30 }), (tickets) => {
      const sorted = [...tickets].sort(compareTickets);
      for (let i = 1; i < sorted.length; i++) {
        assert(sorted[i - 1].seq <= sorted[i].seq);
      }
    }),
  );
});

Deno.test("nextSeq: greater than every listed seq", () => {
  fc.assert(
    fc.property(
      fc.array(
        ticketArb.map((t) => ({ ...t, seq: t.seq % 1_000_000_000 })),
        { maxLength: 30 },
      ),
      (tickets) => {
        const next = nextSeq(tickets);
        assert(next >= 1);
        for (const ticket of tickets) assert(next > ticket.seq);
      },
    ),
  );
});
