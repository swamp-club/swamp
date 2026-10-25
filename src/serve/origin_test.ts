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

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  validateNoAuthHttpRequest,
  validateWebSocketOrigin,
} from "./origin.ts";

Deno.test("validateNoAuthHttpRequest: rejects an untrusted browser origin on loopback", () => {
  const result = validateNoAuthHttpRequest(
    "https://attacker.example",
    "127.0.0.1:9090",
    "127.0.0.1",
    false,
  );
  assertEquals(result.allowed, false);
  assertStringIncludes(result.reason!, "untrusted origin");
});

Deno.test("validateNoAuthHttpRequest: admits an Origin-less local client", () => {
  assertEquals(
    validateNoAuthHttpRequest(
      null,
      "127.0.0.1:9090",
      "127.0.0.1",
      false,
    ),
    { allowed: true },
  );
});

Deno.test("validateNoAuthHttpRequest: rejects an untrusted Host on loopback", () => {
  const result = validateNoAuthHttpRequest(
    null,
    "rebind.attacker.example:9090",
    "127.0.0.1",
    false,
  );
  assertEquals(result.allowed, false);
  assertStringIncludes(result.reason!, "untrusted host");
});

Deno.test("validateNoAuthHttpRequest: admits a configured trusted proxy authority", () => {
  assertEquals(
    validateNoAuthHttpRequest(
      "https://serve.example.com",
      "serve.example.com:443",
      "127.0.0.1",
      true,
      ["serve.example.com"],
    ),
    { allowed: true },
  );
});

Deno.test("validateWebSocketOrigin: a host:port trusted host admits that exact origin", () => {
  assertEquals(
    validateWebSocketOrigin(
      "https://swamp.example.ts.net:9443",
      "swamp.example.ts.net:9443",
      "127.0.0.1",
      false,
      ["swamp.example.ts.net:9443"],
    ),
    { allowed: true },
  );
});

Deno.test("validateWebSocketOrigin: a host:port trusted host rejects the host on another port", () => {
  for (
    const origin of [
      "https://swamp.example.ts.net",
      "https://swamp.example.ts.net:8443",
    ]
  ) {
    const result = validateWebSocketOrigin(
      origin,
      "swamp.example.ts.net:9443",
      "127.0.0.1",
      false,
      ["swamp.example.ts.net:9443"],
    );
    assertEquals(result.allowed, false);
    assertStringIncludes(result.reason!, "untrusted origin");
  }
});

Deno.test("validateWebSocketOrigin: a host:443 trusted host admits the port-less https origin", () => {
  assertEquals(
    validateWebSocketOrigin(
      "https://swamp.example.test",
      null,
      "127.0.0.1",
      false,
      ["swamp.example.test:443"],
    ),
    { allowed: true },
  );
});

Deno.test("validateWebSocketOrigin: a host:port trusted host matches regardless of case", () => {
  assertEquals(
    validateWebSocketOrigin(
      "https://swamp.example.ts.net:9443",
      null,
      "127.0.0.1",
      false,
      ["Swamp.Example.TS.net:9443"],
    ),
    { allowed: true },
  );
});

Deno.test("validateWebSocketOrigin: a bare trusted host still admits the host on any port", () => {
  for (
    const origin of [
      "https://swamp.example.ts.net",
      "https://swamp.example.ts.net:9443",
      "http://swamp.example.ts.net:9090",
    ]
  ) {
    assertEquals(
      validateWebSocketOrigin(origin, null, "127.0.0.1", false, [
        "swamp.example.ts.net",
      ]),
      { allowed: true },
    );
  }
});

Deno.test("validateWebSocketOrigin: a host:port trusted host admits its hostname as Host off loopback", () => {
  for (
    const host of ["swamp.example.test:9443", "swamp.example.test"]
  ) {
    assertEquals(
      validateWebSocketOrigin(null, host, "0.0.0.0", true, [
        "swamp.example.test:9443",
      ]),
      { allowed: true },
    );
  }
  const result = validateWebSocketOrigin(
    null,
    "rebind.attacker.example:9443",
    "0.0.0.0",
    true,
    ["swamp.example.test:9443"],
  );
  assertEquals(result.allowed, false);
  assertStringIncludes(result.reason!, "untrusted host");
});

Deno.test("validateNoAuthHttpRequest: admits a proxy authority configured as host:port", () => {
  assertEquals(
    validateNoAuthHttpRequest(
      "https://swamp.example.ts.net:9443",
      "swamp.example.ts.net:9443",
      "127.0.0.1",
      false,
      ["swamp.example.ts.net:9443"],
    ),
    { allowed: true },
  );
});
