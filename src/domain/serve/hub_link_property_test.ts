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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { decideStart, HubLink } from "./hub_link.ts";

const HUBS = ["https://a.example.com", "https://b.example.com"];
const MEMBERS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];

const memberArb = fc.constantFrom(...MEMBERS);
const hubArb = fc.constantFrom(...HUBS);

// every link a member can hold, built through the entity's own transitions
const linkArb: fc.Arbitrary<HubLink> = fc.oneof(
  fc.constant(HubLink.unjoined()),
  hubArb.map((hub) => HubLink.unjoined().beginJoin(hub)),
  fc.tuple(hubArb, memberArb).chain(([hub, memberId]) => {
    const received = HubLink.unjoined().beginJoin(hub).received({
      memberId,
      memberName: "edge",
      hubName: "central",
      joinedAt: "2026-11-26T12:00:00.000Z",
    });
    const joined = received.joined();
    return fc.constantFrom(
      received,
      joined,
      joined.mismatch(),
      joined.refuse(),
    );
  }),
);

const factsArb = fc.record({
  configuredHubUrl: hubArb,
  credentialMemberId: fc.option(memberArb, { nil: undefined }),
  hasJoinToken: fc.boolean(),
});

Deno.test("decideStart property: checks in only on a joined link with its own credential and the configured hub", () => {
  fc.assert(fc.property(linkArb, factsArb, (link, facts) => {
    const decision = decideStart(link, facts);
    if (decision.action === "check-in") {
      assertEquals(decision.link.state, "joined");
      assertEquals(decision.link.memberId, facts.credentialMemberId);
      assertEquals(decision.link.hubUrl, facts.configuredHubUrl);
      assertEquals(decision.discardCredential, false);
    }
  }));
});

Deno.test("decideStart property: a refused or mismatched outcome never checks in", () => {
  fc.assert(fc.property(linkArb, factsArb, (link, facts) => {
    const decision = decideStart(link, facts);
    if (decision.link.state === "refused" || decision.action === "mismatched") {
      assert(decision.action !== "check-in");
    }
    if (link.state === "refused") assert(decision.action !== "check-in");
  }));
});

Deno.test("decideStart property: a link that keeps a credential is the credential's own, and one that does not discards any", () => {
  fc.assert(fc.property(linkArb, factsArb, (link, facts) => {
    const decision = decideStart(link, facts);
    if (decision.link.holdsCredential) {
      assertEquals(decision.link.memberId, facts.credentialMemberId);
      assertEquals(decision.discardCredential, false);
    } else {
      assertEquals(
        decision.discardCredential,
        facts.credentialMemberId !== undefined,
      );
    }
  }));
});

Deno.test("decideStart property: joins only with a token, and never from a link that holds a credential", () => {
  fc.assert(fc.property(linkArb, factsArb, (link, facts) => {
    const decision = decideStart(link, facts);
    if (decision.action === "join") {
      assert(facts.hasJoinToken);
      assert(!decision.link.holdsCredential);
    }
  }));
});
