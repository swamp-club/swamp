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
import { RunCancelRegistry } from "./run_cancel_registry.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";

await initializeLogging({});

Deno.test("RunCancelRegistry.register: adds an entry", () => {
  const registry = new RunCancelRegistry();
  const controller = new AbortController();
  registry.register("workflow-run", "run-1", controller);
  assertEquals(registry.size, 1);
});

Deno.test("RunCancelRegistry.deregister: removes an entry", () => {
  const registry = new RunCancelRegistry();
  const controller = new AbortController();
  registry.register("workflow-run", "run-1", controller);
  registry.deregister("workflow-run", "run-1");
  assertEquals(registry.size, 0);
});

Deno.test("RunCancelRegistry.deregister: no-ops for missing entry", () => {
  const registry = new RunCancelRegistry();
  registry.deregister("workflow-run", "missing");
  assertEquals(registry.size, 0);
});

Deno.test("RunCancelRegistry.cancel: aborts the controller and returns true", () => {
  const registry = new RunCancelRegistry();
  const controller = new AbortController();
  registry.register("workflow-run", "run-1", controller);

  const result = registry.cancel("workflow-run", "run-1");
  assertEquals(result, true);
  assertEquals(controller.signal.aborted, true);
});

Deno.test("RunCancelRegistry.cancel: returns false for missing entry", () => {
  const registry = new RunCancelRegistry();
  const result = registry.cancel("workflow-run", "missing");
  assertEquals(result, false);
});

Deno.test("RunCancelRegistry.cancelAll: aborts all entries of matching type", () => {
  const registry = new RunCancelRegistry();
  const c1 = new AbortController();
  const c2 = new AbortController();
  const c3 = new AbortController();
  registry.register("workflow-run", "run-1", c1);
  registry.register("workflow-run", "run-2", c2);
  registry.register("method-run", "run-3", c3);

  const count = registry.cancelAll("workflow-run");
  assertEquals(count, 2);
  assertEquals(c1.signal.aborted, true);
  assertEquals(c2.signal.aborted, true);
  assertEquals(c3.signal.aborted, false);
});

Deno.test("RunCancelRegistry.cancelAll: aborts all entries when no type filter", () => {
  const registry = new RunCancelRegistry();
  const c1 = new AbortController();
  const c2 = new AbortController();
  registry.register("workflow-run", "run-1", c1);
  registry.register("method-run", "run-2", c2);

  const count = registry.cancelAll();
  assertEquals(count, 2);
  assertEquals(c1.signal.aborted, true);
  assertEquals(c2.signal.aborted, true);
});

Deno.test("RunCancelRegistry.list: returns entries filtered by type", () => {
  const registry = new RunCancelRegistry();
  registry.register("workflow-run", "run-1", new AbortController());
  registry.register("method-run", "run-2", new AbortController());

  assertEquals(registry.list("workflow-run").length, 1);
  assertEquals(registry.list("method-run").length, 1);
  assertEquals(registry.list().length, 2);
});
