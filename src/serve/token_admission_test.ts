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
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import type { AdmissionLists } from "../domain/access/admission.ts";
import { createTokenAdmissionChecker } from "./token_admission.ts";

await initializeLogging({});

function token(overrides: Record<string, unknown> = {}) {
  return {
    name: "tok-1",
    principalId: "user:sub-alice",
    collectives: [] as string[],
    createdAt: "2026-11-01T00:00:00.000Z",
    vaultName: "default",
    ...overrides,
  };
}

function harness(
  lists: AdmissionLists,
  hasStoredLogin: () => Promise<boolean> = () => Promise.resolve(false),
) {
  let current = lists;
  let lookups = 0;
  const checker = createTokenAdmissionChecker({
    lists: () => current,
    hasStoredLogin: () => {
      lookups++;
      return hasStoredLogin();
    },
  });
  return {
    checker,
    setLists: (next: AdmissionLists) => current = next,
    lookups: () => lookups,
  };
}

const ALICE_ONLY = { allowedCollectives: [], allowedUsers: ["sub-alice"] };
const BOB_ONLY = { allowedCollectives: [], allowedUsers: ["sub-bob"] };

Deno.test("TokenAdmissionChecker: a login token is admitted only while its person is", async () => {
  const { checker, setLists } = harness(ALICE_ONLY);
  const login = token({ oauthIdentity: { email: "a@example.com" } });

  assertEquals((await checker.serverToken(login)).admitted, true);
  setLists(BOB_ONLY);
  assertEquals((await checker.serverToken(login)).admitted, false);
  setLists(ALICE_ONLY);
  assertEquals((await checker.serverToken(login)).admitted, true);
});

Deno.test("TokenAdmissionChecker: a login token passes on a collective still allowed", async () => {
  const { checker } = harness({
    allowedCollectives: ["acme"],
    allowedUsers: [],
  });
  const login = token({ oauthIdentity: { email: "a@example.com" } });
  assertEquals(
    (await checker.serverToken({ ...login, collectives: ["acme"] })).admitted,
    true,
  );
  assertEquals(
    (await checker.serverToken({ ...login, collectives: ["other"] })).admitted,
    false,
  );
});

Deno.test("TokenAdmissionChecker: a manually minted token stays outside admission", async () => {
  const { checker } = harness(BOB_ONLY);
  assertEquals((await checker.serverToken(token())).admitted, true);
});

Deno.test("TokenAdmissionChecker: an older login token is recognised by its stored login", async () => {
  const { checker } = harness(BOB_ONLY, () => Promise.resolve(true));
  assertEquals((await checker.serverToken(token())).admitted, false);
});

Deno.test("TokenAdmissionChecker: the stored-login answer is cached per mint", async () => {
  const { checker, lookups } = harness(BOB_ONLY, () => Promise.resolve(true));
  await checker.serverToken(token());
  await checker.serverToken(token());
  assertEquals(lookups(), 1);
  await checker.serverToken(token({ createdAt: "2026-11-02T00:00:00.000Z" }));
  assertEquals(lookups(), 2);
});

Deno.test("TokenAdmissionChecker: a lookup that fails is not cached and leaves the token outside admission", async () => {
  let fail = true;
  const { checker, lookups } = harness(
    BOB_ONLY,
    () =>
      fail ? Promise.reject(new Error("vault offline")) : Promise.resolve(true),
  );
  assertEquals((await checker.serverToken(token())).admitted, true);
  fail = false;
  assertEquals((await checker.serverToken(token())).admitted, false);
  assertEquals(lookups(), 2);
});

Deno.test("TokenAdmissionChecker: a token that is not a person's never needs a lookup", async () => {
  const { checker, lookups } = harness(BOB_ONLY, () => Promise.resolve(true));
  assertEquals(
    (await checker.serverToken(token({ principalId: "service:ci" }))).admitted,
    true,
  );
  assertEquals(lookups(), 0);
});

Deno.test("TokenAdmissionChecker: a delegation is checked on its linked person", () => {
  const { checker, setLists } = harness(ALICE_ONLY);
  const person = { sub: "sub-alice", collectives: [] };
  assertEquals(checker.delegation(person).admitted, true);
  setLists(BOB_ONLY);
  assertEquals(checker.delegation(person).admitted, false);
});
