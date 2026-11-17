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

import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  currentProcessRuntime,
  PROCESS_RUNTIME,
  ProcessRuntime,
  processRuntimeSlot,
} from "./process_runtime.ts";

Deno.test("currentProcessRuntime: is the process runtime outside any run", () => {
  assertStrictEquals(currentProcessRuntime(), PROCESS_RUNTIME);
});

Deno.test("ProcessRuntime.run: is current for everything the run awaits, timers included", async () => {
  const other = new ProcessRuntime(`other-${crypto.randomUUID()}`);
  const seen = await other.run(async () => {
    const afterTimeout = await new Promise<ProcessRuntime>((resolve) =>
      setTimeout(() => resolve(currentProcessRuntime()), 1)
    );
    await Promise.resolve();
    return [afterTimeout, currentProcessRuntime()];
  });
  assertStrictEquals(seen[0], other);
  assertStrictEquals(seen[1], other);
  assertStrictEquals(currentProcessRuntime(), PROCESS_RUNTIME);
});

Deno.test("ProcessRuntime.run: two runtimes interleaving never see each other", async () => {
  const a = new ProcessRuntime(`a-${crypto.randomUUID()}`);
  const b = new ProcessRuntime(`b-${crypto.randomUUID()}`);
  const gate = Promise.withResolvers<void>();
  const inA = a.run(async () => {
    await gate.promise;
    return currentProcessRuntime();
  });
  const inB = b.run(async () => {
    gate.resolve();
    await Promise.resolve();
    return currentProcessRuntime();
  });
  assertStrictEquals(await inA, a);
  assertStrictEquals(await inB, b);
});

Deno.test("processRuntimeSlot: each runtime gets its own state, created once", () => {
  let created = 0;
  const slot = processRuntimeSlot(() => {
    created++;
    return new Set<string>();
  });
  const other = new ProcessRuntime(`other-${crypto.randomUUID()}`);
  other.run(() => slot().add("other"));
  other.run(() => slot().add("again"));
  const processState = slot(PROCESS_RUNTIME);
  assertEquals(processState.has("other"), false);
  assertStrictEquals(slot(other), other.run(() => slot()));
  assertEquals([...slot(other)], ["other", "again"]);
  assertStrictEquals(slot(PROCESS_RUNTIME), processState);
  assertEquals(created, 2);
});

Deno.test("processRuntimeSlot: an explicit runtime wins over the current one", () => {
  const slot = processRuntimeSlot(() => ({ owner: "" }));
  const a = new ProcessRuntime(`a-${crypto.randomUUID()}`);
  const b = new ProcessRuntime(`b-${crypto.randomUUID()}`);
  a.run(() => {
    slot(b).owner = "b";
  });
  assertEquals(slot(a).owner, "");
  assertEquals(slot(b).owner, "b");
});
