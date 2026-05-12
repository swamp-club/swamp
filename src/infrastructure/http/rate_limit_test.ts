// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { assertStringIncludes } from "@std/assert/string-includes";
import { parseRetryAfter, rateLimitError } from "./rate_limit.ts";

Deno.test("parseRetryAfter: returns undefined for null", () => {
  assertEquals(parseRetryAfter(null), undefined);
});

Deno.test("parseRetryAfter: returns undefined for empty string", () => {
  assertEquals(parseRetryAfter(""), undefined);
  assertEquals(parseRetryAfter("   "), undefined);
});

Deno.test("parseRetryAfter: parses integer delta-seconds", () => {
  assertEquals(parseRetryAfter("120"), 120);
  assertEquals(parseRetryAfter("0"), 0);
  assertEquals(parseRetryAfter("  60  "), 60);
});

Deno.test("parseRetryAfter: rounds up fractional delta-seconds", () => {
  assertEquals(parseRetryAfter("1.2"), 2);
  assertEquals(parseRetryAfter("0.1"), 1);
});

Deno.test("parseRetryAfter: parses HTTP-date in the future", () => {
  const future = new Date(Date.now() + 60_000).toUTCString();
  const seconds = parseRetryAfter(future);
  // Allow tiny clock drift between Date.now() calls.
  assertEquals(seconds !== undefined && seconds >= 59 && seconds <= 61, true);
});

Deno.test("parseRetryAfter: clamps HTTP-date in the past to 0", () => {
  const past = new Date(Date.now() - 60_000).toUTCString();
  assertEquals(parseRetryAfter(past), 0);
});

Deno.test("parseRetryAfter: returns undefined for unparseable values", () => {
  assertEquals(parseRetryAfter("soon"), undefined);
  assertEquals(parseRetryAfter("-1"), undefined);
});

Deno.test("rateLimitError: includes wait hint and sign-in hint when retryAfter provided", () => {
  const err = rateLimitError(42);
  assertStringIncludes(err.message, "Rate limit exceeded");
  assertStringIncludes(err.message, "Retry in 42s");
  assertStringIncludes(err.message, "swamp auth login");
});

Deno.test("rateLimitError: omits wait hint when retryAfter undefined", () => {
  const err = rateLimitError(undefined);
  assertStringIncludes(err.message, "Rate limit exceeded");
  assertEquals(err.message.includes("Retry in"), false);
  assertStringIncludes(err.message, "swamp auth login");
});
