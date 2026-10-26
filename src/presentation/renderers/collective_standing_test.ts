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
import { stripAnsiCode } from "@std/fmt/colors";
import type { WhoamiCollectiveEntitlement } from "../../libswamp/auth/whoami.ts";
import { collectiveLines, standing } from "./collective_standing.ts";

function plainStanding(entitlement: WhoamiCollectiveEntitlement): string {
  return stripAnsiCode(standing(entitlement));
}

function plainLines(entitlements: WhoamiCollectiveEntitlement[]): string[] {
  return collectiveLines(entitlements).map(stripAnsiCode);
}

Deno.test("collectiveLines: an empty list renders no lines", () => {
  assertEquals(collectiveLines([]), []);
});

Deno.test("collectiveLines: a single collective is indented with its standing", () => {
  assertEquals(
    plainLines([{
      slug: "acme",
      plan: "team",
      planName: "Team",
      subscriptionStatus: "active",
    }]),
    ["  acme  Team  active"],
  );
});

Deno.test("collectiveLines: collectives with no standing are bare slugs, unpadded", () => {
  assertEquals(
    plainLines([{ slug: "a" }, { slug: "longer-slug" }]),
    ["  a", "  longer-slug"],
  );
});

Deno.test("collectiveLines: slugs are padded to the longest so standings align", () => {
  assertEquals(
    plainLines([
      { slug: "a", plan: "team", planName: "Team" },
      { slug: "longer-slug", plan: "business", planName: "Business" },
    ]),
    ["  a            Team", "  longer-slug  Business"],
  );
});

Deno.test("standing: a trial with one day left is singular", () => {
  assertEquals(
    plainStanding({
      slug: "keeb",
      plan: "free",
      trial: {
        state: "active",
        startedAt: "2026-07-20T00:00:00.000Z",
        endsAt: "2026-08-19T00:00:00.000Z",
        daysRemaining: 1,
      },
    }),
    "trial: 1 day left (ends 2026-08-19)",
  );
});

Deno.test("standing: an active trial with no end date has no ends suffix", () => {
  assertEquals(
    plainStanding({
      slug: "keeb",
      plan: "free",
      trial: {
        state: "active",
        startedAt: "2026-07-20T00:00:00.000Z",
        endsAt: null,
        daysRemaining: 9,
      },
    }),
    "trial: 9 days left",
  );
});

Deno.test("standing: a paid plan shows its name and billing status", () => {
  assertEquals(
    plainStanding({
      slug: "acme",
      plan: "team",
      planName: "Team",
      subscriptionStatus: "past_due",
    }),
    "Team  past_due",
  );
});

Deno.test("standing: a paid plan without a billing status shows only its name", () => {
  assertEquals(
    plainStanding({ slug: "acme", plan: "team", planName: "Team" }),
    "Team",
  );
  assertEquals(
    plainStanding({
      slug: "acme",
      plan: "team",
      planName: "Team",
      subscriptionStatus: null,
    }),
    "Team",
  );
});

Deno.test("standing: a covered free collective is not shown its ended trial", () => {
  assertEquals(
    plainStanding({
      slug: "keeb",
      plan: "free",
      privateExtensions: "allowed",
      trial: {
        state: "expired",
        startedAt: "2026-06-01T00:00:00.000Z",
        endsAt: "2026-07-01T00:00:00.000Z",
        daysRemaining: 0,
      },
    }),
    "covered",
  );
});
