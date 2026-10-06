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
import { resolveActorIdentity } from "./actor_identity.ts";

const user = { kind: "user", id: "sub-1" } as const;
const names = { "sub-1": "configured-name" };

Deno.test("resolveActorIdentity: takes username and email from the OAuth login", () => {
  assertEquals(
    resolveActorIdentity(user, names, {
      username: "alice",
      email: "alice@example.com",
    }),
    { username: "alice", email: "alice@example.com" },
  );
});

Deno.test("resolveActorIdentity: falls back to the configured name for the username", () => {
  assertEquals(
    resolveActorIdentity(user, names, { email: "alice@example.com" }),
    { username: "configured-name", email: "alice@example.com" },
  );
  assertEquals(resolveActorIdentity(user, names, undefined), {
    username: "configured-name",
  });
});

Deno.test("resolveActorIdentity: an unlisted user with only an email gets the email", () => {
  assertEquals(
    resolveActorIdentity(user, {}, { email: "alice@example.com" }),
    { email: "alice@example.com" },
  );
});

Deno.test("resolveActorIdentity: nothing known gives undefined", () => {
  assertEquals(resolveActorIdentity(user, undefined, undefined), undefined);
  assertEquals(resolveActorIdentity(user, {}, {}), undefined);
});

Deno.test("resolveActorIdentity: only users have an identity", () => {
  const identity = { username: "x", email: "x@example.com" };
  assertEquals(resolveActorIdentity(null, names, identity), undefined);
  for (const kind of ["worker", "service"] as const) {
    assertEquals(
      resolveActorIdentity({ kind, id: "sub-1" }, names, identity),
      undefined,
    );
  }
});
