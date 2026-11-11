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

// the dashboard reaches core only through the agent_sessions doors, record.ts
// and swampify.ts; everything else is copied and pinned with a test, so no
// other core module is pulled into the bundle

import { join } from "@std/path";
import {
  assertPinnedSet,
  extractImports,
  productionSourceFiles,
  repoRelative,
  resolveImport,
  ROOT,
} from "./arch_fitness_helpers.ts";

const DASHBOARD_SRC = join(ROOT, "packages", "dashboard", "src");
const CORE_CONTRACTS = ["session_record.ts", "swampify.ts"].map((file) =>
  join(ROOT, "src", "domain", "agent_sessions", file)
);

// Every edge from bundled dashboard source into the repo's src/. Tests are
// not bundled; a pin test imports the core function its copy mirrors.
const PINNED_DASHBOARD_CORE_IMPORTS = [
  "packages/dashboard/src/lib/agent_sessions/record.ts -> src/domain/agent_sessions/session_record.ts",
  "packages/dashboard/src/lib/agent_sessions/swampify.ts -> src/domain/agent_sessions/swampify.ts",
];

Deno.test("dashboard: imports core only through the agent_sessions doors", async () => {
  const edges = new Set<string>();
  for await (const path of productionSourceFiles(DASHBOARD_SRC)) {
    const source = await Deno.readTextFile(path);
    for (const specifier of extractImports(source)) {
      const target = resolveImport(path, specifier);
      if (target === undefined || !target.startsWith("src/")) continue;
      edges.add(`${repoRelative(path)} -> ${target}`);
    }
  }
  assertPinnedSet(
    [...edges].sort(),
    PINNED_DASHBOARD_CORE_IMPORTS,
    "dashboard imports of core",
    "Import the name from lib/agent_sessions/record.ts or swampify.ts, or copy the function into the dashboard and pin the copy with a test.",
  );
});

for (const contract of CORE_CONTRACTS) {
  const file = repoRelative(contract);
  Deno.test(`dashboard: ${file} imports nothing but zod`, async () => {
    const source = await Deno.readTextFile(contract);
    // The dashboard bundles this module for the browser, so a Deno, Node or
    // core import here would break the bundle or pull more of core into it.
    assertPinnedSet(
      [...new Set(extractImports(source))].sort(),
      ["zod"],
      `imports of ${file}`,
      "The dashboard bundles this module: keep it free of other imports, or move what it needs into it.",
    );
  });
}
