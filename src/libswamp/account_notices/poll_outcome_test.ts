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
import { toPollOutcome } from "./poll_outcome.ts";

const SENT = Date.parse("2026-11-02T12:00:00.000Z");

Deno.test("toPollOutcome: maps parsed notices to domain notices", () => {
  assertEquals(
    toPollOutcome({
      kind: "ok",
      notices: [
        {
          kind: "trial-ended",
          slug: "keeb",
          name: "keeb",
          personal: true,
          href: "/billing",
        },
        {
          kind: "trial-ending",
          slug: "acme",
          name: "Acme",
          personal: false,
          href: null,
          endsAt: "2026-11-07T12:00:00+00:00",
          daysRemaining: 5,
        },
      ],
    }, SENT),
    {
      kind: "ok",
      sentAt: SENT,
      notices: [
        {
          kind: "trial-ended",
          collective: { slug: "keeb", name: "keeb", personal: true },
          billingPath: "/billing",
        },
        {
          kind: "trial-ending",
          collective: { slug: "acme", name: "Acme", personal: false },
          billingPath: null,
          endsAt: Date.parse("2026-11-07T12:00:00.000Z"),
          daysRemaining: 5,
        },
      ],
    },
  );
});

Deno.test("toPollOutcome: passes every other outcome through", () => {
  assertEquals(toPollOutcome({ kind: "unsupported" }, SENT), {
    kind: "unsupported",
  });
  assertEquals(toPollOutcome({ kind: "unavailable" }, SENT), {
    kind: "unavailable",
  });
  assertEquals(toPollOutcome({ kind: "rejected" }, SENT), { kind: "rejected" });
  assertEquals(toPollOutcome({ kind: "backoff" }, SENT), { kind: "backoff" });
  assertEquals(
    toPollOutcome({ kind: "backoff", retryAfterSeconds: 60 }, SENT),
    { kind: "backoff", retryAfterSeconds: 60 },
  );
  assertEquals(
    toPollOutcome({ kind: "failed", reason: "timeout" }, SENT),
    { kind: "failed", reason: "timeout" },
  );
});
