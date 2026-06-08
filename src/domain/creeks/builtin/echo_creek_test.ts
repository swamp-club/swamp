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

import { assert, assertEquals } from "@std/assert";
import { getLogger } from "@logtape/logtape";
import { CreekRegistry } from "../creek_registry.ts";
import { createCreekHandle } from "../creek_handle.ts";
import type { CreekMethodContext } from "../creek.ts";
import { echoCreek } from "./echo_creek.ts";

function buildContext(): CreekMethodContext {
  return {
    signal: new AbortController().signal,
    logger: getLogger(["test", "echo-creek"]),
    extensionFile: (p) => p,
  };
}

Deno.test("echoCreek: echo returns its argument", async () => {
  const registry = new CreekRegistry();
  registry.register(echoCreek);
  const handle = createCreekHandle(
    echoCreek.type,
    new Map(),
    registry,
    buildContext(),
  );

  const result = await handle.call("echo", { value: "hello" });
  assertEquals(result, "hello");
});

Deno.test("echoCreek: concat joins two strings", async () => {
  const registry = new CreekRegistry();
  registry.register(echoCreek);
  const handle = createCreekHandle(
    echoCreek.type,
    new Map(),
    registry,
    buildContext(),
  );

  const result = await handle.call("concat", { a: "foo", b: "bar" });
  assertEquals(result, "foobar");
});

Deno.test("echoCreek: now returns an ISO timestamp", async () => {
  const registry = new CreekRegistry();
  registry.register(echoCreek);
  const handle = createCreekHandle(
    echoCreek.type,
    new Map(),
    registry,
    buildContext(),
  );

  const result = await handle.call("now", {});
  assert(typeof result === "string");
  assert(!Number.isNaN(Date.parse(result as string)));
});
