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

import { assertEquals, assertInstanceOf } from "@std/assert";
import { UserError } from "../errors.ts";
import {
  RegistryServerError,
  RegistryUnavailableError,
  serverFaultMessage,
} from "./registry_unavailable_error.ts";

Deno.test("RegistryUnavailableError: is a UserError reported under that name", () => {
  const error = new RegistryUnavailableError("Request timed out.");
  assertInstanceOf(error, UserError);
  assertEquals(error.name, "UserError");
  assertEquals(error.message, "Request timed out.");
  assertEquals(error.code, undefined);
});

Deno.test("RegistryUnavailableError: keeps the underlying failure as its cause", () => {
  const cause = new DOMException("Signal timed out.", "TimeoutError");
  const error = new RegistryUnavailableError("Request timed out.", { cause });
  assertEquals(error.cause, cause);
  assertEquals(Object.keys(error).includes("cause"), false);
});

Deno.test("RegistryUnavailableError: has no cause when none is given", () => {
  const error = new RegistryUnavailableError("Request timed out.");
  assertEquals("cause" in error, false);
});

Deno.test("serverFaultMessage: a 500 is an internal error to report, not to retry", () => {
  assertEquals(
    serverFaultMessage({
      status: 500,
      serverMessage: "Internal server error",
      url: "https://swamp-club.com/api/v1/extensions/%40a%2Fb/versions",
    }),
    "swamp-club hit an internal error (HTTP 500) answering " +
      "https://swamp-club.com/api/v1/extensions/%40a%2Fb/versions. Retrying " +
      "will most likely fail the same way; report it with `swamp issue bug` " +
      "and include this message.",
  );
});

Deno.test("serverFaultMessage: a 503 after retries says to try again later", () => {
  assertEquals(
    serverFaultMessage({
      status: 503,
      retried: " after 6 attempts over 30s",
      serverMessage: "Service Unavailable",
    }),
    "swamp-club is unavailable (HTTP 503, still failing after 6 attempts " +
      "over 30s). Try again in a few minutes.",
  );
});

Deno.test("serverFaultMessage: keeps a server message that says more than the status", () => {
  assertEquals(
    serverFaultMessage({
      status: 503,
      serverMessage: "Down for maintenance until 14:00 UTC.",
      url: "https://swamp-club.com/api/whoami",
    }),
    "swamp-club is unavailable (HTTP 503) answering " +
      "https://swamp-club.com/api/whoami: Down for maintenance until 14:00 " +
      "UTC. Try again in a few minutes.",
  );
});

Deno.test("serverFaultMessage: any 5xx other than 502, 503 and 504 is an internal error", () => {
  for (const status of [500, 501, 505, 599]) {
    assertEquals(
      serverFaultMessage({ status }).startsWith(
        `swamp-club hit an internal error (HTTP ${status}).`,
      ),
      true,
      String(status),
    );
  }
  for (const status of [502, 503, 504]) {
    assertEquals(
      serverFaultMessage({ status }),
      `swamp-club is unavailable (HTTP ${status}). Try again in a few minutes.`,
    );
  }
});

Deno.test("RegistryServerError: is a RegistryUnavailableError carrying the server-fault wording", () => {
  const error = new RegistryServerError({ status: 500 });
  assertInstanceOf(error, RegistryUnavailableError);
  assertEquals(error.name, "UserError");
  assertEquals(error.message, serverFaultMessage({ status: 500 }));
});
