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
import { EmbeddedDenoRuntime } from "./embedded_deno_runtime.ts";

// The Stream 0 multi-line `which`/`where` parsing regression is exercised
// directly against `defaultCommandResolver` in
// `src/infrastructure/process/resolve_command_test.ts` — that's where the
// parser lives. `EmbeddedDenoRuntime` only forwards to the resolver, so
// duplicating the test here would not catch any additional drift; the
// constructor's `commandResolver` argument is the seam should that change.

Deno.test("EmbeddedDenoRuntime returns system deno in dev mode", async () => {
  // When running from source (not compiled), Deno.build.standalone is falsy
  const runtime = new EmbeddedDenoRuntime();
  const denoPath = await runtime.ensureDeno();

  // In dev mode, should return the running deno's path
  assertEquals(denoPath, Deno.execPath());
});

Deno.test("EmbeddedDenoRuntime caches the deno path", async () => {
  const runtime = new EmbeddedDenoRuntime();

  const first = await runtime.ensureDeno();
  const second = await runtime.ensureDeno();

  // Should return the same path both times (cached)
  assertEquals(first, second);
});
