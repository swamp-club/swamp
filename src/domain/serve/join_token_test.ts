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
  JoinToken,
  JoinTokenError,
  joinTokenNameOf,
  MAX_JOIN_TOKEN_DURATION_MS,
} from "./join_token.ts";
import { MemberName } from "./member_name.ts";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const EDGE = MemberName.create("edge-1");

function minted() {
  return JoinToken.mint(EDGE, DEFAULT_JOIN_TOKEN_DURATION_MS, NOW);
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

Deno.test("JoinToken.use: marks the token used with the member id", () => {
  const { token, plaintext } = minted();
  const memberId = crypto.randomUUID();
  const used = JoinToken.use(token, plaintext, memberId, NOW + 1);
  assertEquals(used.ok, true);
  if (!used.ok) return;
  assertEquals(used.token.state, "used");
  assertEquals(used.token.memberId, memberId);
  assertEquals(used.token.toJSON().usedAt, new Date(NOW + 1).toISOString());
});

Deno.test("JoinToken.use: missing, used, expired, revoked and wrong secrets are one refusal", () => {
  const { token, plaintext } = minted();
  const id = crypto.randomUUID();
  const used = JoinToken.use(token, plaintext, id, NOW);
  if (!used.ok) throw new Error("expected use");
  const other = minted();
  const refusals = [
    JoinToken.use(null, plaintext, id, NOW),
    JoinToken.use(used.token, plaintext, id, NOW),
    JoinToken.use(token, plaintext, id, NOW + DEFAULT_JOIN_TOKEN_DURATION_MS),
    JoinToken.use(token.revoke(NOW), plaintext, id, NOW),
    JoinToken.use(token, other.plaintext, id, NOW),
    JoinToken.use(token, 42, id, NOW),
  ];
  for (const refusal of refusals) {
    assertEquals(refusal, { ok: false, refusal: "invalid" });
  }
});

Deno.test("JoinToken.revoke: only an unused, unexpired token", () => {
  const { token, plaintext } = minted();
  assertEquals(token.revoke(NOW).state, "revoked");
  const used = JoinToken.use(token, plaintext, crypto.randomUUID(), NOW);
  if (!used.ok) throw new Error("expected use");
  assertThrows(() => used.token.revoke(NOW), JoinTokenError, "is used");
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

Deno.test("JoinToken.fromJSON: round-trips and refuses unknown fields", () => {
  const { token } = minted();
  assertEquals(JoinToken.fromJSON(token.toJSON()).toJSON(), token.toJSON());
  assertThrows(() => JoinToken.fromJSON({ ...token.toJSON(), secret: "x" }));
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
