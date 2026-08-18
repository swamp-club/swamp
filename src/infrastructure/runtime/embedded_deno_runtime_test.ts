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

import { assertEquals, assertStringIncludes } from "@std/assert";
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

Deno.test({
  name:
    "subprocess spawn fails with inaccessible cwd, succeeds with explicit cwd",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const testDir = await Deno.makeTempDir({ prefix: "cwd-test-" });
    const restrictedDir = `${testDir}/restricted`;
    await Deno.mkdir(restrictedDir);
    await Deno.chmod(restrictedDir, 0o000);

    try {
      // Spawn with inaccessible cwd fails
      let threw = false;
      try {
        await new Deno.Command(Deno.execPath(), {
          args: ["--version"],
          cwd: restrictedDir,
          stdout: "null",
          stderr: "piped",
        }).output();
      } catch (e) {
        threw = true;
        assertStringIncludes(String(e), "Permission denied");
      }
      assertEquals(threw, true, "should throw when cwd is inaccessible");

      // Spawn with explicit accessible cwd succeeds
      const result = await new Deno.Command(Deno.execPath(), {
        args: ["--version"],
        cwd: testDir,
        stdout: "null",
        stderr: "null",
      }).output();
      assertEquals(result.success, true);
    } finally {
      await Deno.chmod(restrictedDir, 0o755);
      await Deno.remove(testDir, { recursive: true });
    }
  },
});
