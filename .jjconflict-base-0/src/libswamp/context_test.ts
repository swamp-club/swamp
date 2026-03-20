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
import { getLogger } from "@logtape/logtape";
import { createLibSwampContext } from "./context.ts";

Deno.test("default context has non-aborted signal", () => {
  const ctx = createLibSwampContext();
  assertEquals(ctx.signal.aborted, false);
});

Deno.test("custom signal is propagated", () => {
  const controller = new AbortController();
  const ctx = createLibSwampContext({ signal: controller.signal });
  assertEquals(ctx.signal.aborted, false);
  controller.abort();
  assertEquals(ctx.signal.aborted, true);
});

Deno.test("custom logger is propagated", () => {
  const logger = getLogger(["test", "custom"]);
  const ctx = createLibSwampContext({ logger });
  assertEquals(ctx.logger, logger);
});

Deno.test("withTimeout creates child that aborts after timeout", async () => {
  const ctx = createLibSwampContext();
  const child = ctx.withTimeout(50);
  assertEquals(child.signal.aborted, false);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assertEquals(child.signal.aborted, true);
});

Deno.test("withSignal creates child that aborts when given signal aborts", () => {
  const ctx = createLibSwampContext();
  const controller = new AbortController();
  const child = ctx.withSignal(controller.signal);
  assertEquals(child.signal.aborted, false);
  controller.abort();
  assertEquals(child.signal.aborted, true);
});

Deno.test("parent abort propagates to children", () => {
  const controller = new AbortController();
  const parent = createLibSwampContext({ signal: controller.signal });
  const childTimeout = parent.withTimeout(60000);
  const childSignal = parent.withSignal(new AbortController().signal);
  assertEquals(childTimeout.signal.aborted, false);
  assertEquals(childSignal.signal.aborted, false);
  controller.abort();
  assertEquals(childTimeout.signal.aborted, true);
  assertEquals(childSignal.signal.aborted, true);
});

Deno.test("withTimeout preserves parent logger", () => {
  const logger = getLogger(["test"]);
  const ctx = createLibSwampContext({ logger });
  const child = ctx.withTimeout(5000);
  assertEquals(child.logger, logger);
});

Deno.test("withSignal preserves parent logger", () => {
  const logger = getLogger(["test"]);
  const ctx = createLibSwampContext({ logger });
  const child = ctx.withSignal(new AbortController().signal);
  assertEquals(child.logger, logger);
});
