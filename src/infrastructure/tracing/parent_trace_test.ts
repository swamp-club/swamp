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
import { ROOT_CONTEXT } from "@opentelemetry/api";
import { runWithParentTrace } from "./parent_trace.ts";

Deno.test("runWithParentTrace: passes through when parentCtx is undefined", () => {
  const result = runWithParentTrace(undefined, () => 42);
  assertEquals(result, 42);
});

Deno.test("runWithParentTrace: runs fn within the given context", () => {
  const result = runWithParentTrace(ROOT_CONTEXT, () => "hello");
  assertEquals(result, "hello");
});

Deno.test("runWithParentTrace: propagates async return values", async () => {
  const result = await runWithParentTrace(
    ROOT_CONTEXT,
    () => Promise.resolve("async-value"),
  );
  assertEquals(result, "async-value");
});
