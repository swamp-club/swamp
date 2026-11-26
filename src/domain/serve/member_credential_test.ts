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

import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import {
  MEMBER_CREDENTIAL_PREFIX,
  MemberCredential,
  MemberCredentialError,
} from "./member_credential.ts";

Deno.test("MemberCredential.issue: the wire form is swfm1.<memberId>.<43 base64url chars>", () => {
  const memberId = crypto.randomUUID();
  const wire = MemberCredential.issue(memberId).toWire();
  const [prefix, id, secret] = wire.split(".");
  assertEquals(prefix, MEMBER_CREDENTIAL_PREFIX);
  assertEquals(id, memberId);
  assertEquals(/^[A-Za-z0-9_-]{43}$/.test(secret), true);
});

Deno.test("MemberCredential.parse: round-trips and verifies against its own hash", () => {
  const issued = MemberCredential.issue(crypto.randomUUID());
  const parsed = MemberCredential.parse(issued.toWire());
  assertEquals(parsed.memberId, issued.memberId);
  assertEquals(parsed.verify(issued.hash()), true);
  assertEquals(/^[0-9a-f]{64}$/.test(issued.hash()), true);
});

Deno.test("MemberCredential.verify: another secret for the same member fails", () => {
  const memberId = crypto.randomUUID();
  const a = MemberCredential.issue(memberId);
  const b = MemberCredential.issue(memberId);
  assertNotEquals(a.toWire(), b.toWire());
  assertEquals(b.verify(a.hash()), false);
  assertEquals(a.verify("not-a-hash"), false);
});

Deno.test("MemberCredential.parse: refuses every malformed form with one message", () => {
  const good = MemberCredential.issue(crypto.randomUUID()).toWire();
  const [, id, secret] = good.split(".");
  const cases: unknown[] = [
    "",
    `${id}.${secret}`,
    `swfm2.${id}.${secret}`,
    `swfm1.not-a-uuid.${secret}`,
    `swfm1.${id.toUpperCase()}.${secret}`,
    `swfm1.${id}.${secret}x`,
    `swfm1.${id}.${secret}.extra`,
    `swfm1.../..${secret}`,
    42,
  ];
  for (const wire of cases) {
    const error = assertThrows(
      () => MemberCredential.parse(wire),
      MemberCredentialError,
    );
    assertEquals(error.message, "Invalid member credential");
  }
});

Deno.test("MemberCredential: string and JSON forms never carry the secret", () => {
  const credential = MemberCredential.issue(crypto.randomUUID());
  const secret = credential.toWire().split(".")[2];
  assertEquals(String(credential).includes(secret), false);
  assertEquals(JSON.stringify({ credential }).includes(secret), false);
  assertEquals(Deno.inspect(credential).includes(secret), false);
});
