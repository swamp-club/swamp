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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { AsyncLocalStorage } from "node:async_hooks";
import { runOutsideAmbientContext } from "./ambient_context.ts";

Deno.test("runOutsideAmbientContext: hides a store entered around the call", async () => {
  const store = new AsyncLocalStorage<string>();
  const seen = await store.run(
    "outer",
    () =>
      runOutsideAmbientContext(async () => {
        const before = store.getStore();
        await Promise.resolve();
        return [before, store.getStore()];
      }),
  );
  assertEquals(seen, [undefined, undefined]);
});

Deno.test("runOutsideAmbientContext: a store entered inside works as usual", async () => {
  const store = new AsyncLocalStorage<string>();
  const seen = await store.run(
    "outer",
    () =>
      runOutsideAmbientContext(() =>
        store.run("inner", async () => {
          await Promise.resolve();
          return store.getStore();
        })
      ),
  );
  assertEquals(seen, "inner");
});

Deno.test("runOutsideAmbientContext: returns the value and throws the error of fn", async () => {
  assertEquals(runOutsideAmbientContext(() => 42), 42);
  assertEquals(
    await runOutsideAmbientContext(() => Promise.resolve("ok")),
    "ok",
  );
  assertThrows(
    () =>
      runOutsideAmbientContext(() => {
        throw new Error("sync boom");
      }),
    Error,
    "sync boom",
  );
  await assertRejects(
    () =>
      runOutsideAmbientContext(() => Promise.reject(new Error("async boom"))),
    Error,
    "async boom",
  );
});
