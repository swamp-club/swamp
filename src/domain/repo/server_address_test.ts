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

import { assert, assertStringIncludes, assertThrows } from "@std/assert";
import { UserError } from "../errors.ts";
import { assertStorableServerAddress } from "./server_address.ts";

// Every secret carries a marker that appears nowhere else in these URLs, so
// "the message does not contain the secret" cannot pass or fail by accident.
const USER = "zz9user";
const PASSWORD = "zz9password";
const TOKEN = "zz9token";
const FRAGMENT = "zz9fragment";

function assertRefusedWithoutSecrets(
  value: string,
  expectedParts: string[],
): void {
  const error = assertThrows(
    () => assertStorableServerAddress(value),
    UserError,
  );
  assertStringIncludes(
    error.message,
    "'https://serve.example.com:8443/base'",
  );
  for (const part of expectedParts) {
    assertStringIncludes(error.message, part);
  }
  assert(!error.message.includes("zz9"), error.message);
}

Deno.test("assertStorableServerAddress: accepts http, https, ws and wss URLs", () => {
  for (
    const value of [
      "http://127.0.0.1:9090",
      "https://serve.example.com",
      "ws://localhost:9090/",
      "wss://team-serve.internal:4000/base/path",
    ]
  ) {
    assertStorableServerAddress(value);
  }
});

Deno.test("assertStorableServerAddress: refuses a username without a password", () => {
  assertRefusedWithoutSecrets(
    `https://${USER}@serve.example.com:8443/base`,
    ["a username or password"],
  );
});

Deno.test("assertStorableServerAddress: refuses a username and password", () => {
  assertRefusedWithoutSecrets(
    `https://${USER}:${PASSWORD}@serve.example.com:8443/base`,
    ["a username or password"],
  );
});

Deno.test("assertStorableServerAddress: refuses a token query parameter", () => {
  assertRefusedWithoutSecrets(
    `https://serve.example.com:8443/base?token=${TOKEN}`,
    ["a query string"],
  );
});

Deno.test("assertStorableServerAddress: refuses any other query string", () => {
  assertRefusedWithoutSecrets(
    `https://serve.example.com:8443/base?session=${TOKEN}`,
    ["a query string"],
  );
});

Deno.test("assertStorableServerAddress: refuses a fragment", () => {
  assertRefusedWithoutSecrets(
    `https://serve.example.com:8443/base#${FRAGMENT}`,
    ["a fragment"],
  );
});

Deno.test("assertStorableServerAddress: names every credential part found", () => {
  assertRefusedWithoutSecrets(
    `https://${USER}:${PASSWORD}@serve.example.com:8443/base?token=${TOKEN}#${FRAGMENT}`,
    ["a username or password, a query string and a fragment"],
  );
});

Deno.test("assertStorableServerAddress: points to the token flags and server-login", () => {
  const error = assertThrows(
    () =>
      assertStorableServerAddress(
        `https://serve.example.com:8443/base?token=${TOKEN}`,
      ),
    UserError,
  );
  assertStringIncludes(error.message, "--token");
  assertStringIncludes(error.message, "SWAMP_SERVER_TOKEN");
  assertStringIncludes(
    error.message,
    "swamp auth server-login --server https://serve.example.com:8443/base",
  );
});

Deno.test("assertStorableServerAddress: refuses an unparseable value without echoing it", () => {
  const error = assertThrows(
    () => assertStorableServerAddress(`not a url ${TOKEN}`),
    UserError,
  );
  assertStringIncludes(error.message, "Invalid --server URL");
  assert(!error.message.includes("zz9"), error.message);
});

Deno.test("assertStorableServerAddress: refuses a URL without a host", () => {
  assertThrows(
    () => assertStorableServerAddress(`mailto:${USER}@example.com`),
    UserError,
    "Invalid --server URL",
  );
});

Deno.test("assertStorableServerAddress: refuses unsupported schemes", () => {
  for (const scheme of ["ftp", "file", "swamp"]) {
    const error = assertThrows(
      () =>
        assertStorableServerAddress(
          `${scheme}://${USER}:${PASSWORD}@serve.example.com/base`,
        ),
      UserError,
      "Invalid --server URL",
    );
    assert(!error.message.includes("zz9"), error.message);
  }
});
