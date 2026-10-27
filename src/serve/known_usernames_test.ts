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
import type { ServerToken } from "../domain/models/access/server_token_model.ts";
import {
  addUnknownUsernames,
  displayPrincipal,
  usernameFromLogin,
  usernamesFromServerTokens,
} from "./known_usernames.ts";

function token(overrides: Partial<ServerToken>): ServerToken {
  return {
    name: "t",
    state: "active",
    principalId: "user:sub-1",
    principalEmail: "typed@example.com",
    collectives: [],
    groups: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    vaultName: "v",
    secretKey: "k",
    ...overrides,
  };
}

Deno.test("usernameFromLogin: keys the provider's user name by the user's id", () => {
  assertEquals(
    usernameFromLogin("user:sub-1", {
      email: "a@example.com",
      username: "alice",
    }),
    { "sub-1": "alice" },
  );
});

Deno.test("usernameFromLogin: is empty without a user name or for another kind of principal", () => {
  assertEquals(usernameFromLogin("user:sub-1", { email: "a@example.com" }), {});
  assertEquals(usernameFromLogin("user:sub-1", undefined), {});
  assertEquals(
    usernameFromLogin("worker:w-1", { email: "a@example.com", username: "w" }),
    {},
  );
  assertEquals(
    usernameFromLogin("user:", { email: "a@example.com", username: "x" }),
    {},
  );
});

Deno.test("usernamesFromServerTokens: takes names only from OAuth-minted tokens", () => {
  assertEquals(
    usernamesFromServerTokens([
      token({
        principalId: "user:sub-1",
        oauthIdentity: { email: "a@example.com", username: "alice" },
      }),
      token({ principalId: "user:sub-2" }),
      token({
        principalId: "user:sub-3",
        oauthIdentity: { email: "c@example.com" },
      }),
    ]),
    { "sub-1": "alice" },
  );
});

Deno.test("usernamesFromServerTokens: the newest login's name wins", () => {
  const older = token({
    createdAt: "2026-01-01T00:00:00.000Z",
    oauthIdentity: { email: "a@example.com", username: "old-name" },
  });
  const newer = token({
    createdAt: "2026-02-01T00:00:00.000Z",
    oauthIdentity: { email: "a@example.com", username: "new-name" },
  });
  assertEquals(usernamesFromServerTokens([older, newer]), {
    "sub-1": "new-name",
  });
  assertEquals(usernamesFromServerTokens([newer, older]), {
    "sub-1": "new-name",
  });
});

Deno.test("displayPrincipal: names a user whose name is known", () => {
  assertEquals(
    displayPrincipal({ kind: "user", id: "sub-1" }, { "sub-1": "alice" }),
    "user:alice",
  );
  assertEquals(
    displayPrincipal({ kind: "user", id: "sub-2" }, { "sub-1": "alice" }),
    "user:sub-2",
  );
  assertEquals(
    displayPrincipal({ kind: "user", id: "sub-1" }, undefined),
    "user:sub-1",
  );
});

Deno.test("displayPrincipal: never names another kind of principal or reads inherited keys", () => {
  assertEquals(
    displayPrincipal({ kind: "worker", id: "sub-1" }, { "sub-1": "alice" }),
    "worker:sub-1",
  );
  assertEquals(
    displayPrincipal({ kind: "user", id: "constructor" }, {}),
    "user:constructor",
  );
});

Deno.test("displayPrincipal: an empty user name is not a name", () => {
  assertEquals(
    displayPrincipal({ kind: "user", id: "sub-1" }, { "sub-1": "" }),
    "user:sub-1",
  );
});

Deno.test("addUnknownUsernames: names only users without a name", () => {
  const names: Record<string, string> = { "sub-1": "new-name" };
  addUnknownUsernames(names, { "sub-1": "old-name", "sub-2": "bob" });
  assertEquals(names, { "sub-1": "new-name", "sub-2": "bob" });
});

Deno.test("addUnknownUsernames: two tokens of a renamed user never make the name alternate", () => {
  const names: Record<string, string> = {};
  addUnknownUsernames(names, { "sub-1": "old-name" });
  // A login gives the new name, which replaces it.
  Object.assign(names, { "sub-1": "new-name" });
  for (let i = 0; i < 3; i++) {
    addUnknownUsernames(names, { "sub-1": "old-name" });
    assertEquals(names["sub-1"], "new-name");
  }
});
