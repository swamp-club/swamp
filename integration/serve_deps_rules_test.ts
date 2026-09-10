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
import { walk } from "@std/fs/walk";
import { join, relative, SEPARATOR } from "@std/path";

const ROOT = join(import.meta.dirname!, "..");
const SERVE_HANDLERS_DIR = join(ROOT, "src", "serve", "handlers");

function normalise(p: string): string {
  return SEPARATOR === "\\" ? p.replaceAll("\\", "/") : p;
}

Deno.test("serve handlers must not construct fresh definition or workflow repos", async () => {
  const violations: string[] = [];

  for await (
    const entry of walk(SERVE_HANDLERS_DIR, {
      exts: [".ts"],
      skip: [/_test\.ts$/],
    })
  ) {
    const content = await Deno.readTextFile(entry.path);
    const rel = normalise(relative(ROOT, entry.path));

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (
        line.includes("new YamlDefinitionRepository(") ||
        line.includes("new YamlWorkflowRepository(")
      ) {
        // Auto-definition repos scoped to autoDefinitionsDir are
        // write-only repos for direct-type-execution and file grants —
        // they don't do general definition lookups, so the path
        // divergence doesn't apply.
        if (line.includes("autoDefRepo")) continue;
        violations.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    }
  }

  assertEquals(
    violations,
    [],
    "Serve handlers must use ctx.repoContext repos (pre-warmed at boot) " +
      "instead of constructing fresh YamlDefinitionRepository or " +
      "YamlWorkflowRepository instances. Fresh repos miss the " +
      "datastore-resolved paths under managedConfig + namespace. " +
      "Pass the pre-warmed repo via the injectedDefinitionRepo / " +
      "injectedWorkflowRepo parameter on the libswamp create*Deps " +
      "function instead.\n\nViolations:\n" +
      violations.join("\n"),
  );
});
