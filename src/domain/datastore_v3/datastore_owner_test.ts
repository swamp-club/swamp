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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { UserError } from "../errors.ts";
import {
  DATASTORE_CLAIMED_CODE,
  DatastoreClaimedError,
  DatastoreOwner,
  normalizeOwnerAddress,
} from "./datastore_owner.ts";

const CLAIMED_AT = "2026-10-28T00:00:00.000Z";

Deno.test("normalizeOwnerAddress: the form clients compare, from any spelling of one address", () => {
  for (
    const spelling of [
      "https://swamp.example.com",
      "HTTPS://Swamp.Example.com/",
      "https://swamp.example.com:443",
      "wss://swamp.example.com",
    ]
  ) {
    assertEquals(normalizeOwnerAddress(spelling), "https://swamp.example.com");
  }
  assertEquals(
    normalizeOwnerAddress("http://10.0.0.1:9090/swamp/"),
    "http://10.0.0.1:9090/swamp",
  );
});

Deno.test("normalizeOwnerAddress: refuses a non-URL, another protocol and an address with credentials, without echoing it", () => {
  for (
    const bad of [
      "swamp.example.com",
      "ftp://swamp.example.com",
      "https://user:secret@swamp.example.com",
    ]
  ) {
    const error = assertThrows(() => normalizeOwnerAddress(bad), UserError);
    assertEquals(error.message.includes("secret"), false);
  }
});

Deno.test("DatastoreOwner.create: refuses a time that is not a date and a negative or fractional log position", () => {
  const address = "https://swamp.example.com";
  assertThrows(
    () =>
      DatastoreOwner.create({ address, claimedAt: "soon", claimedAtCursor: 0 }),
    UserError,
  );
  for (const claimedAtCursor of [-1, 1.5]) {
    assertThrows(
      () =>
        DatastoreOwner.create({
          address,
          claimedAt: CLAIMED_AT,
          claimedAtCursor,
        }),
      UserError,
    );
  }
});

Deno.test("DatastoreOwner.isAddress: matches every spelling of the owner's address and nothing else", () => {
  const owner = DatastoreOwner.create({
    address: "https://swamp.example.com/",
    claimedAt: CLAIMED_AT,
    claimedAtCursor: 0,
  });
  assertEquals(owner.isAddress("HTTPS://swamp.example.com:443"), true);
  assertEquals(owner.isAddress("https://other.example.com"), false);
  assertEquals(owner.isAddress("http://swamp.example.com"), false);
});

Deno.test("DatastoreClaimedError: a user error with a stable code that names the owner and how to write through it", () => {
  const owner = DatastoreOwner.create({
    address: "https://swamp.example.com",
    claimedAt: CLAIMED_AT,
    claimedAtCursor: 0,
  });
  const error = new DatastoreClaimedError(owner);
  assertEquals(error instanceof UserError, true);
  assertEquals(error.code, DATASTORE_CLAIMED_CODE);
  assertEquals(error.code, "datastore_claimed");
  assertStringIncludes(error.message, "https://swamp.example.com");
  assertStringIncludes(error.message, "serverAddress");
  assertStringIncludes(error.message, "SWAMP_SERVE_URL");
  assertStringIncludes(error.message, "swamp auth server-login");
  assertStringIncludes(error.message, "Reads still work");
});

Deno.test("DatastoreClaimedError: a serve's refusal gives the serve's way out instead of a client's", () => {
  const owner = DatastoreOwner.create({
    address: "https://swamp.example.com",
    claimedAt: CLAIMED_AT,
    claimedAtCursor: 0,
  });
  const error = new DatastoreClaimedError(
    owner,
    "This serve was started without --address.",
    "Start the owner serve with --address https://swamp.example.com.",
  );
  assertEquals(error.code, DATASTORE_CLAIMED_CODE);
  assertStringIncludes(error.message, "started without --address");
  assertStringIncludes(error.message, "Start the owner serve");
  assertEquals(error.message.includes("server-login"), false);
  assertStringIncludes(error.message, "Nothing was changed.");
});
