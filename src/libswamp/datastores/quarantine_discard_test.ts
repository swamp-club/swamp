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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import { datastoreQuarantineDiscard } from "./quarantine_discard.ts";

const TXN = "0f8c57cf-4f22-4233-bf81-ecc6b4492fb8";

Deno.test("datastoreQuarantineDiscard: asks serve for the canonical txnId and reports who discarded it", async () => {
  const asked: string[] = [];
  const events = await collect(
    datastoreQuarantineDiscard(createLibSwampContext(), {
      discard: (txnId) => {
        asked.push(txnId);
        return Promise.resolve({
          discarded: true,
          duplicate: false,
          txnId,
          partition: "model--aws%2Fec2--web",
          principal: "user:bob",
          state: "discarded",
          discardedBy: "user:admin",
          discardedAt: "2026-10-30T13:00:00.000Z",
        });
      },
    }, { txnId: ` ${TXN.toUpperCase()} ` }),
  );
  assertEquals(asked, [TXN]);
  assertEquals(events.map((event) => event.kind), ["discarding", "completed"]);
  const completed = events[1];
  assertEquals(completed.kind === "completed" ? completed.data : undefined, {
    txnId: TXN,
    partition: "model--aws%2Fec2--web",
    author: "user:bob",
    discardedBy: "user:admin",
    discardedAt: "2026-10-30T13:00:00.000Z",
    duplicate: false,
  });
});

Deno.test("datastoreQuarantineDiscard: a value that is not a txnId is refused before serve is asked", async () => {
  let asked = 0;
  const events = await collect(
    datastoreQuarantineDiscard(createLibSwampContext(), {
      discard: () => {
        asked++;
        return Promise.resolve({});
      },
    }, { txnId: "../locks" }),
  );
  assertEquals(asked, 0);
  assertEquals(
    events[0].kind === "error" ? events[0].error.code : undefined,
    "validation_failed",
  );
});
