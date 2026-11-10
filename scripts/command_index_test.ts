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

import { assertEquals, assertThrows } from "@std/assert";
import { buildCommandIndex, loadCommandIndex } from "./command_index.ts";
import { ROOT_ROUTES } from "../src/cli/root_routes.ts";

const GRAPH = [
  "src/cli/commands/vault.ts",
  "src/cli/commands/repo_init.ts",
  "src/cli/commands/help.ts",
];

Deno.test("buildCommandIndex: maps each root to its route module, help from its declared file", () => {
  const index = buildCommandIndex(
    [{ name: "vault", module: "src/cli/commands/vault.ts" }],
    GRAPH,
  );
  assertEquals(index, {
    vault: "src/cli/commands/vault.ts",
    help: "src/cli/commands/help.ts",
  });
});

Deno.test("buildCommandIndex: two roots defined in one file both resolve to it", () => {
  const index = buildCommandIndex(
    [
      { name: "init", module: "src/cli/commands/repo_init.ts" },
      { name: "repo", module: "src/cli/commands/repo_init.ts" },
    ],
    GRAPH,
    {},
  );
  assertEquals(index, {
    init: "src/cli/commands/repo_init.ts",
    repo: "src/cli/commands/repo_init.ts",
  });
});

Deno.test("buildCommandIndex: a root whose file is not in the module graph is an error, not an omission", () => {
  assertThrows(
    () =>
      buildCommandIndex(
        [
          { name: "vault", module: "src/cli/commands/vault.ts" },
          { name: "new", module: "src/cli/commands/new.ts" },
        ],
        GRAPH,
      ),
    Error,
    "new names src/cli/commands/new.ts, which is not in the module graph",
  );
});

Deno.test("buildCommandIndex: a root listed twice is an error", () => {
  assertThrows(
    () =>
      buildCommandIndex(
        [{ name: "help", module: "src/cli/commands/vault.ts" }],
        GRAPH,
      ),
    Error,
    "help is listed twice",
  );
});

Deno.test("loadCommandIndex: indexes every route by registered name, in table order, help last", () => {
  const files = [...new Set([
    ...ROOT_ROUTES.map((route) => route.module),
    "src/cli/commands/help.ts",
  ])];
  const index = loadCommandIndex(files);
  assertEquals(Object.keys(index), [
    ...ROOT_ROUTES.map((route) => route.name),
    "help",
  ]);
  for (const route of ROOT_ROUTES) assertEquals(index[route.name], route.module);
});

Deno.test("loadCommandIndex: refuses a path outside the command directory", () => {
  for (
    const file of [
      "scripts/compile.ts",
      "src/cli/commands/../mod.ts",
      "src/cli/commands/nested/thing.ts",
      "src/cli/commands/data.json",
    ]
  ) {
    assertThrows(
      () => loadCommandIndex([file]),
      Error,
      "not a command file",
    );
  }
});
