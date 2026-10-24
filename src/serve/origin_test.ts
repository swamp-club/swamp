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
import { validateNoAuthHttpRequest } from "./origin.ts";

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
