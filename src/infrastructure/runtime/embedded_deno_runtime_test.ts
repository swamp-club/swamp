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
import {
  type CommandLookupRunner,
  defaultCommandResolver,
} from "../process/resolve_command.ts";

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

// Stream-0 deferred regression: when the standalone-mode failure path falls
// back to a system `deno`, the resolver may receive multi-line output (e.g.
// `which -a deno` or `where deno` listing several entries). The first line
// must win — we want a single concrete path, not a newline-glued mash.
Deno.test("EmbeddedDenoRuntime.findSystemDeno: returns first line of multi-line which output", async () => {
  const fakeRunner: CommandLookupRunner = (_tool, _name) =>
    Promise.resolve({
      success: true,
      stdout: new TextEncoder().encode(
        "/usr/local/bin/deno\n/opt/homebrew/bin/deno\n/usr/bin/deno\n",
      ),
    });

  const runtime = new EmbeddedDenoRuntime(defaultCommandResolver(fakeRunner));
  const path = await runtime.findSystemDeno();
  assertEquals(path, "/usr/local/bin/deno");
});

Deno.test("EmbeddedDenoRuntime.findSystemDeno: returns null when resolver finds nothing", async () => {
  const fakeRunner: CommandLookupRunner = (_tool, _name) =>
    Promise.resolve({
      success: false,
      stdout: new Uint8Array(),
    });

  const runtime = new EmbeddedDenoRuntime(defaultCommandResolver(fakeRunner));
  const path = await runtime.findSystemDeno();
  assertEquals(path, null);
});
