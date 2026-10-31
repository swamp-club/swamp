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

// The dashboard is a separate package, bundled by vite for the browser. It
// reaches core in exactly one place: the agent sessions page reads the
// agent session record core owns (swamp-club#4155), through
// packages/dashboard/src/lib/agent_sessions/record.ts. Everything else the
// dashboard needs from core it copies and pins with a test
// (views/report_name.ts), so no other core module is pulled into the bundle.

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
const SESSION_RECORD = join(
  ROOT,
  "src",
  "domain",
  "agent_sessions",
  "session_record.ts",
);

// Every edge from bundled dashboard source into the repo's src/. Tests are
// not bundled; a pin test imports the core function its copy mirrors.
const PINNED_DASHBOARD_CORE_IMPORTS = [
  "packages/dashboard/src/lib/agent_sessions/record.ts -> src/domain/agent_sessions/session_record.ts",
];

Deno.test("dashboard: imports core only through the agent session record adapter", async () => {
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
    "Import the name from lib/agent_sessions/record.ts, or copy the function into the dashboard and pin the copy with a test.",
  );
});

Deno.test("dashboard: the agent session record imports nothing but zod", async () => {
  const source = await Deno.readTextFile(SESSION_RECORD);
  // The dashboard bundles this module for the browser, so a Deno, Node or
  // core import here would break the bundle or pull more of core into it.
  assertPinnedSet(
    [...new Set(extractImports(source))].sort(),
    ["zod"],
    "imports of src/domain/agent_sessions/session_record.ts",
    "The dashboard bundles this module: keep it free of other imports, or move what it needs into it.",
  );
});
