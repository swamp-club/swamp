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

/**
 * Guards the CLI import path against HTTP clients built at module-evaluation
 * time. `Deno.createHttpClient` reads the platform certificate store, so a
 * client constructed while the module graph evaluates makes every command —
 * including offline ones like `swamp help` and `swamp model search` — depend
 * on that read succeeding (swamp-club#2293).
 *
 * This file must NOT statically import `./mod.ts`: the counter has to be in
 * place before the graph is evaluated for the first time in this isolate.
 */

import { assertEquals } from "@std/assert";

Deno.test("importing the CLI entry point constructs no HTTP client", async () => {
  const original = Deno.createHttpClient;
  let constructed = 0;
  Deno.createHttpClient = ((options: Deno.CreateHttpClientOptions = {}) => {
    constructed++;
    return original(options);
  }) as typeof Deno.createHttpClient;
  try {
    await import("./mod.ts");
  } finally {
    Deno.createHttpClient = original;
  }
  assertEquals(
    constructed,
    0,
    "create HTTP clients lazily inside a function — a client built during " +
      "module evaluation crashes every command when the platform " +
      "certificate store is unreadable (swamp-club#2293)",
  );
});
