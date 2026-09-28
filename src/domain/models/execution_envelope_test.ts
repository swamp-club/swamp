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
import { traceHeadersToEnv } from "./execution_envelope.ts";

Deno.test("traceHeadersToEnv: maps traceparent and tracestate to env names", () => {
  assertEquals(
    traceHeadersToEnv({
      traceparent: "00-abc-def-01",
      tracestate: "vendor=value",
    }),
    { TRACEPARENT: "00-abc-def-01", TRACESTATE: "vendor=value" },
  );
});

Deno.test("traceHeadersToEnv: matches header names case-insensitively", () => {
  assertEquals(
    traceHeadersToEnv({ Traceparent: "00-abc-def-01", TRACESTATE: "v=1" }),
    { TRACEPARENT: "00-abc-def-01", TRACESTATE: "v=1" },
  );
});

Deno.test("traceHeadersToEnv: maps a lone traceparent", () => {
  assertEquals(traceHeadersToEnv({ traceparent: "00-abc-def-01" }), {
    TRACEPARENT: "00-abc-def-01",
  });
});

Deno.test("traceHeadersToEnv: returns an empty object for undefined", () => {
  assertEquals(traceHeadersToEnv(undefined), {});
});

Deno.test("traceHeadersToEnv: drops keys that are not W3C trace headers", () => {
  assertEquals(
    traceHeadersToEnv({
      "ld-preload": "/tmp/evil.so",
      path: "/tmp",
      "trace-parent": "00-abc-def-01",
      traceparent_: "00-abc-def-01",
      baggage: "k=v",
      constructor: "x",
      toString: "x",
    }),
    {},
  );
});
