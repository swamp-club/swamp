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
import { join } from "@std/path";
import { initializeTestRepo, runCliCommand } from "./test_helpers.ts";
import { stringify as stringifyYaml } from "@std/yaml";

Deno.test("stale source in .swamp-sources.yaml does not brick non-extension commands (#1181)", async () => {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp_it_stale_source_",
  });
  try {
    await initializeTestRepo(repoDir);

    const ghostDir = join(repoDir, "nonexistent-source");
    await Deno.writeTextFile(
      join(repoDir, ".swamp-sources.yaml"),
      stringifyYaml({
        sources: [{ path: ghostDir }],
      } as Record<string, unknown>),
    );

    const result = await runCliCommand(
      ["model", "search", "--json"],
      repoDir,
    );

    assertEquals(
      result.code,
      0,
      `Expected exit 0 but got ${result.code}. stderr: ${result.stderr}`,
    );
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
});
