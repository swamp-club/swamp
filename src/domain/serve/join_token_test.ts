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
  DEFAULT_JOIN_TOKEN_DURATION_MS,
  joinIdOf,
  JoinToken,
  JoinTokenError,
  joinTokenNameOf,
  MAX_JOIN_TOKEN_DURATION_MS,
} from "./join_token.ts";
import { MemberName } from "./member_name.ts";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const EDGE = MemberName.create("edge-1");

const JOIN_ID = crypto.randomUUID();

function minted() {
  return JoinToken.mint(EDGE, DEFAULT_JOIN_TOKEN_DURATION_MS, NOW);
}

function firstUse(token: JoinToken, plaintext: string): JoinToken {
  const used = JoinToken.use(
    token,
    plaintext,
    JOIN_ID,
    crypto.randomUUID(),
    NOW,
  );
  if (used.kind !== "first-use") throw new Error("expected a first use");
  return used.token;
}

Deno.test("JoinToken.mint: the plaintext is <name>.<secret> and only its hash is kept", () => {
  const { token, plaintext } = minted();
  assertEquals(plaintext.startsWith("edge-1."), true);
  const record = token.toJSON();
  assertEquals(record.state, "unused");
  assertEquals(record.expiresAt, "2026-11-26T13:00:00.000Z");
  assertEquals(JSON.stringify(record).includes(plaintext.split(".")[1]), false);
  assertEquals(/^[0-9a-f]{64}$/.test(record.secretHash), true);
});

Deno.test("JoinToken.mint: refuses a duration over 30 days or not positive", () => {
  for (const ms of [0, -1, 1.5, MAX_JOIN_TOKEN_DURATION_MS + 1]) {
    assertThrows(() => JoinToken.mint(EDGE, ms, NOW), JoinTokenError);
  }
  JoinToken.mint(EDGE, MAX_JOIN_TOKEN_DURATION_MS, NOW);
});

Deno.test("JoinToken.use: marks the token used with the member id and the joinId's hash", () => {
  const { token, plaintext } = minted();
  const memberId = crypto.randomUUID();
  const used = JoinToken.use(token, plaintext, JOIN_ID, memberId, NOW + 1);
  assertEquals(used.kind, "first-use");
  if (used.kind !== "first-use") return;
  assertEquals(used.token.state, "used");
  assertEquals(used.token.memberId, memberId);
  const record = used.token.toJSON();
  assertEquals(record.usedAt, new Date(NOW + 1).toISOString());
  assertEquals(/^[0-9a-f]{64}$/.test(record.joinIdHash ?? ""), true);
  assertEquals(JSON.stringify(record).includes(JOIN_ID), false);
});

Deno.test("JoinToken.use: the same token and joinId on a used token replay its member", () => {
  const { token, plaintext } = minted();
  const memberId = crypto.randomUUID();
  const used = JoinToken.use(token, plaintext, JOIN_ID, memberId, NOW);
  if (used.kind !== "first-use") throw new Error("expected a first use");
  const replay = JoinToken.use(
    used.token,
    plaintext,
    JOIN_ID,
    crypto.randomUUID(),
    NOW + DEFAULT_JOIN_TOKEN_DURATION_MS - 1,
  );
  assertEquals(replay, { kind: "replay", memberId, admitted: false });
});

Deno.test("JoinToken.use: a replay with another joinId, a wrong secret or after expiry is refused", () => {
  const { token, plaintext } = minted();
  const used = firstUse(token, plaintext);
  const other = minted();
  const id = crypto.randomUUID();
  const refusals = [
    JoinToken.use(used, plaintext, crypto.randomUUID(), id, NOW),
    JoinToken.use(used, other.plaintext, JOIN_ID, id, NOW),
    JoinToken.use(
      used,
      plaintext,
      JOIN_ID,
      id,
      NOW + DEFAULT_JOIN_TOKEN_DURATION_MS,
    ),
  ];
  for (const refusal of refusals) {
    assertEquals(refusal, { kind: "refused" });
  }
});

Deno.test("JoinToken.use: a used token recorded without a joinId hash never replays", () => {
  const { token, plaintext } = minted();
  const { joinIdHash: _hash, ...record } = firstUse(token, plaintext).toJSON();
  assertEquals(
    JoinToken.use(
      JoinToken.fromJSON(record),
      plaintext,
      JOIN_ID,
      crypto.randomUUID(),
      NOW,
    ),
    { kind: "refused" },
  );
});

Deno.test("JoinToken.use: refuses to run with a joinId that is not a lower-case UUID", () => {
  const { token, plaintext } = minted();
  for (const joinId of ["", "not-a-uuid", JOIN_ID.toUpperCase()]) {
    assertThrows(
      () => JoinToken.use(token, plaintext, joinId, crypto.randomUUID(), NOW),
      JoinTokenError,
    );
  }
});

Deno.test("JoinToken.use: missing, expired, revoked and wrong secrets are one refusal", () => {
  const { token, plaintext } = minted();
  const id = crypto.randomUUID();
  const other = minted();
  const refusals = [
    JoinToken.use(null, plaintext, JOIN_ID, id, NOW),
    JoinToken.use(
      token,
      plaintext,
      JOIN_ID,
      id,
      NOW + DEFAULT_JOIN_TOKEN_DURATION_MS,
    ),
    JoinToken.use(token.revoke(NOW), plaintext, JOIN_ID, id, NOW),
    JoinToken.use(token, other.plaintext, JOIN_ID, id, NOW),
    JoinToken.use(token, 42, JOIN_ID, id, NOW),
  ];
  for (const refusal of refusals) {
    assertEquals(refusal, { kind: "refused" });
  }
});

Deno.test("JoinToken.revoke: only an unused, unexpired token", () => {
  const { token, plaintext } = minted();
  assertEquals(token.revoke(NOW).state, "revoked");
  const used = firstUse(token, plaintext);
  assertThrows(() => used.revoke(NOW), JoinTokenError, "is used");
  assertThrows(
    () => token.revoke(NOW + DEFAULT_JOIN_TOKEN_DURATION_MS),
    JoinTokenError,
    "is expired",
  );
  assertThrows(() => token.revoke(NOW).revoke(NOW), JoinTokenError);
});

Deno.test("JoinToken.expire: records expiry once it has passed", () => {
  const { token } = minted();
  assertEquals(token.expire(NOW), undefined);
  assertEquals(token.stateAt(NOW + DEFAULT_JOIN_TOKEN_DURATION_MS), "expired");
  assertEquals(
    token.expire(NOW + DEFAULT_JOIN_TOKEN_DURATION_MS)?.state,
    "expired",
  );
});

Deno.test("JoinToken.fromJSON: round-trips, and keeps a newer hub's unknown fields for the rewrite but never in a view", () => {
  const { token } = minted();
  assertEquals(JoinToken.fromJSON(token.toJSON()).toJSON(), token.toJSON());
  const newer = JoinToken.fromJSON({ ...token.toJSON(), later: "x" });
  assertEquals(newer.toJSON() as unknown, { ...token.toJSON(), later: "x" });
  assertEquals(
    (newer.revoke(NOW).toJSON() as unknown as Record<string, unknown>).later,
    "x",
  );
  assertEquals("later" in newer.view(NOW), false);
  assertEquals("secretHash" in newer.view(NOW), false);
  assertThrows(() =>
    JoinToken.fromJSON({ ...token.toJSON(), secretHash: "x" })
  );
});

Deno.test("joinIdOf: accepts a lower-case UUID only", () => {
  assertEquals(joinIdOf(JOIN_ID), JOIN_ID);
  for (const value of [JOIN_ID.toUpperCase(), "", "x", 1, null, undefined]) {
    assertEquals(joinIdOf(value), undefined);
  }
});

Deno.test("joinTokenNameOf: reads the claimed name from a well-formed token only", () => {
  const { plaintext } = minted();
  assertEquals(joinTokenNameOf(plaintext)?.value, "edge-1");
  for (
    const wire of ["edge-1", "edge-1.short", "../x.y", `.${"a".repeat(43)}`, 1]
  ) {
    assertEquals(joinTokenNameOf(wire), undefined);
  }
});

const ADMIT_MEMBER = crypto.randomUUID();

Deno.test("JoinToken.admit: only a used token, once; a replay reports whether it was admitted", () => {
  const { token, plaintext } = minted();
  assertThrows(() => token.admit(NOW), JoinTokenError);
  const spent = JoinToken.use(token, plaintext, JOIN_ID, ADMIT_MEMBER, NOW);
  if (spent.kind !== "first-use") throw new Error(spent.kind);
  const before = JoinToken.use(
    spent.token,
    plaintext,
    JOIN_ID,
    ADMIT_MEMBER,
    NOW,
  );
  assertEquals(before.kind === "replay" && before.admitted, false);
  const admitted = spent.token.admit(NOW + 1);
  assertEquals(admitted.admittedAt, new Date(NOW + 1).toISOString());
  assertEquals(admitted.admit(NOW + 2), admitted);
  const after = JoinToken.use(admitted, plaintext, JOIN_ID, ADMIT_MEMBER, NOW);
  assertEquals(after.kind === "replay" && after.admitted, true);
});
