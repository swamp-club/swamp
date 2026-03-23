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
import { extractTraceContext, injectTraceContext } from "./propagation.ts";

Deno.test("injectTraceContext: returns empty object when tracing is not initialized", () => {
  const headers = injectTraceContext();
  // Without an active span/provider, propagation injects nothing
  assertEquals(typeof headers, "object");
  assertEquals(Object.keys(headers).length, 0);
});

Deno.test("extractTraceContext: returns a context object", () => {
  const ctx = extractTraceContext({ traceparent: "00-abc-def-01" });
  // Should return a context (even if the traceparent is not parseable by
  // the no-op propagator, the function should not throw)
  assertEquals(typeof ctx, "object");
});
