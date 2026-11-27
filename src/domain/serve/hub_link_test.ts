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

import { assertEquals, assertThrows } from "@std/assert";
import {
  decideStart,
  HubLink,
  HubLinkError,
  type HubLinkInstance,
  isInstanceAlive,
} from "./hub_link.ts";

const HUB = "https://hub.example.com";
const OTHER = "https://other.example.com";
const MEMBER = {
  memberId: "6F1C2A4E-1111-4222-8333-944445555666",
  memberName: "edge",
  hubName: "central",
  joinedAt: "2026-11-26T12:00:00.000Z",
};
const MEMBER_ID = MEMBER.memberId.toLowerCase();

function joinedLink(hubUrl = HUB): HubLink {
  return HubLink.unjoined().beginJoin(hubUrl, crypto.randomUUID()).received(
    MEMBER,
  ).joined();
}

Deno.test("HubLink: a join goes joining, then joined once the reply is recorded, with a lower-case member id", () => {
  const link = joinedLink();
  assertEquals(link.state, "joined");
  assertEquals(link.memberId, MEMBER_ID);
  assertEquals(link.checksIn, true);
  assertEquals(link.holdsCredential, true);
});

Deno.test("HubLink: joined before a join reply is refused", () => {
  assertThrows(
    () => HubLink.unjoined().beginJoin(HUB, crypto.randomUUID()).joined(),
    HubLinkError,
    "before a join reply",
  );
});

Deno.test("HubLink: a joined link cannot begin another join; a refused one can", () => {
  assertThrows(
    () => joinedLink().beginJoin(OTHER, crypto.randomUUID()),
    HubLinkError,
  );
  const rejoining = joinedLink().refuse().beginJoin(OTHER, crypto.randomUUID());
  assertEquals(rejoining.state, "joining");
  assertEquals(rejoining.hubUrl, OTHER);
  assertEquals(rejoining.memberId, null);
});

Deno.test("HubLink.fromJSON: round-trips and refuses a link with no member, a non-UUID member id or an extra key", () => {
  const link = joinedLink();
  assertEquals(HubLink.fromJSON(link.toJSON()).toJSON(), link.toJSON());
  assertThrows(
    () => HubLink.fromJSON({ ...link.toJSON(), memberId: null }),
    HubLinkError,
  );
  assertThrows(
    () => HubLink.fromJSON({ ...link.toJSON(), memberId: "edge" }),
    HubLinkError,
  );
  assertThrows(() => HubLink.fromJSON({ ...link.toJSON(), credential: "x" }));
});

Deno.test("decideStart: a joined link with its credential and the same hub checks in", () => {
  const decision = decideStart(joinedLink(), {
    configuredHubUrl: HUB,
    credentialMemberId: MEMBER_ID,
    hasJoinToken: false,
  });
  assertEquals(decision.action, "check-in");
  assertEquals(decision.link.state, "joined");
  assertEquals(decision.discardCredential, false);
});

Deno.test("decideStart: a joined link naming another hub is mismatched and keeps its credential", () => {
  const decision = decideStart(joinedLink(), {
    configuredHubUrl: OTHER,
    credentialMemberId: MEMBER_ID,
    hasJoinToken: true,
  });
  assertEquals(decision.action, "mismatched");
  assertEquals(decision.link.state, "mismatched");
  assertEquals(decision.discardCredential, false);
});

Deno.test("decideStart: a mismatched link whose hub is restored checks in again", () => {
  const decision = decideStart(joinedLink().mismatch(), {
    configuredHubUrl: HUB,
    credentialMemberId: MEMBER_ID,
    hasJoinToken: false,
  });
  assertEquals(decision.action, "check-in");
  assertEquals(decision.link.state, "joined");
});

Deno.test("decideStart: a refused link with another hub and a token joins it", () => {
  const decision = decideStart(joinedLink().refuse(), {
    configuredHubUrl: OTHER,
    credentialMemberId: undefined,
    hasJoinToken: true,
  });
  assertEquals(decision.action, "join");
  assertEquals(decision.link.state, "refused");
});

Deno.test("decideStart: a refused link without a token stays idle", () => {
  const decision = decideStart(joinedLink().refuse(), {
    configuredHubUrl: HUB,
    credentialMemberId: undefined,
    hasJoinToken: false,
  });
  assertEquals(decision.action, "idle");
});

Deno.test("decideStart: a joining link whose credential was stored completes the join", () => {
  const joining = HubLink.unjoined().beginJoin(HUB, crypto.randomUUID())
    .received(MEMBER);
  const decision = decideStart(joining, {
    configuredHubUrl: HUB,
    credentialMemberId: MEMBER_ID,
    hasJoinToken: false,
  });
  assertEquals(decision.action, "check-in");
  assertEquals(decision.link.state, "joined");
});

Deno.test("decideStart: a joining link with no credential stays joining, to replay with its joinId", () => {
  const joinId = crypto.randomUUID();
  for (
    const joining of [
      HubLink.unjoined().beginJoin(HUB, joinId),
      HubLink.unjoined().beginJoin(HUB, joinId).received(MEMBER),
    ]
  ) {
    const decision = decideStart(joining, {
      configuredHubUrl: OTHER,
      credentialMemberId: undefined,
      hasJoinToken: true,
    });
    assertEquals(decision.action, "join");
    assertEquals(decision.link.state, "joining");
    assertEquals(decision.link.joinId, joinId);
    const idle = decideStart(joining, {
      configuredHubUrl: HUB,
      credentialMemberId: crypto.randomUUID(),
      hasJoinToken: false,
    });
    assertEquals(idle.action, "idle");
    assertEquals(idle.link.joinId, joinId);
    assertEquals(idle.discardCredential, true);
  }
});

Deno.test("HubLink.beginJoin: a joining link keeps its joinId and takes the new hub; others use the fresh one", () => {
  const joinId = crypto.randomUUID();
  const joining = HubLink.unjoined().beginJoin(HUB, joinId).received(MEMBER);
  const again = joining.beginJoin(OTHER, crypto.randomUUID());
  assertEquals(again.joinId, joinId);
  assertEquals(again.hubUrl, OTHER);
  assertEquals(again.memberId, null);
  const fresh = crypto.randomUUID();
  assertEquals(joinedLink().refuse().beginJoin(OTHER, fresh).joinId, fresh);
  assertThrows(
    () => HubLink.unjoined().beginJoin(HUB, fresh.toUpperCase()),
    HubLinkError,
  );
});

Deno.test("HubLink: a settled link holds no joinId; abandonJoin starts afresh", () => {
  assertEquals(joinedLink().joinId, null);
  assertEquals(joinedLink().refuse().joinId, null);
  const joining = HubLink.unjoined().beginJoin(HUB, crypto.randomUUID());
  assertEquals(joining.abandonJoin().toJSON(), HubLink.unjoined().toJSON());
  assertEquals(joining.received(MEMBER).abandonJoin().state, "unjoined");
  assertThrows(() => joinedLink().abandonJoin(), HubLinkError);
});

Deno.test("HubLink.fromJSON: a joining link needs a joinId, a settled one holds none, and an older record reads without one", () => {
  const joining = HubLink.unjoined().beginJoin(HUB, crypto.randomUUID());
  assertEquals(HubLink.fromJSON(joining.toJSON()).toJSON(), joining.toJSON());
  assertThrows(
    () => HubLink.fromJSON({ ...joining.toJSON(), joinId: null }),
    HubLinkError,
  );
  assertThrows(
    () =>
      HubLink.fromJSON({
        ...joinedLink().toJSON(),
        joinId: crypto.randomUUID(),
      }),
    HubLinkError,
  );
  const { joinId: _id, ...older } = joinedLink().toJSON();
  assertEquals(HubLink.fromJSON(older).joinId, null);
});

Deno.test("decideStart: a joined link whose credential is gone is refused", () => {
  const decision = decideStart(joinedLink(), {
    configuredHubUrl: HUB,
    credentialMemberId: undefined,
    hasJoinToken: false,
  });
  assertEquals(decision.link.state, "refused");
  assertEquals(decision.action, "idle");
});

Deno.test("decideStart: a credential stored beside no live link is discarded", () => {
  const decision = decideStart(HubLink.unjoined(), {
    configuredHubUrl: HUB,
    credentialMemberId: MEMBER_ID,
    hasJoinToken: false,
  });
  assertEquals(decision.discardCredential, true);
});

Deno.test("isInstanceAlive: alive within the window and not stopped", () => {
  const now = Date.parse("2026-11-26T12:05:00.000Z");
  const instance: HubLinkInstance = {
    instanceId: "a",
    startedAt: "2026-11-26T12:00:00.000Z",
    aliveAt: "2026-11-26T12:04:00.000Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    result: null,
    consecutiveFailures: 0,
    nextAttemptAt: null,
    stoppedAt: null,
  };
  assertEquals(isInstanceAlive(instance, now), true);
  assertEquals(
    isInstanceAlive({ ...instance, aliveAt: "2026-11-26T12:02:00.000Z" }, now),
    false,
  );
  assertEquals(
    isInstanceAlive(
      { ...instance, stoppedAt: "2026-11-26T12:04:30.000Z" },
      now,
    ),
    false,
  );
});
