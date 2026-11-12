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
import {
  readSwampifyCandidateSet,
  readSwampifyComparison,
  readSwampifyOffer,
  swampifyCandidateSetTags,
  swampifyComparisonTags,
  swampifyOfferTags,
} from "../../../../../src/domain/agent_sessions/swampify.ts";
import {
  emptyCandidateSet,
  fixtureCandidateSet,
  fixtureComparison,
  fixtureOffer,
  hostileCandidateSet,
  thinCandidateSet,
} from "./swampify_fixtures.ts";

Deno.test("swampify fixtures: every set reads back through the contract reader and tags", () => {
  for (
    const set of [
      fixtureCandidateSet(),
      thinCandidateSet(),
      emptyCandidateSet(),
      hostileCandidateSet(),
    ]
  ) {
    assertEquals(readSwampifyCandidateSet(set), {
      kind: "record",
      record: set,
    });
    swampifyCandidateSetTags(set);
  }
});

Deno.test("swampify fixtures: an offer in every state reads back through the contract reader", () => {
  for (const state of ["offered", "picked", "built", "declined"] as const) {
    const offer = fixtureOffer(state);
    assertEquals(readSwampifyOffer(offer), { kind: "record", record: offer });
    swampifyOfferTags(offer);
  }
});

Deno.test("swampify fixtures: the comparison reads back through the contract reader", () => {
  const comparison = fixtureComparison();
  assertEquals(readSwampifyComparison(comparison), {
    kind: "record",
    record: comparison,
  });
  swampifyComparisonTags(comparison);
});
