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

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { findModuleReferences } from "../scripts/unbarrel.ts";
import {
  assertPinnedSet,
  resolveImport,
  ROOT,
  staticImportClosure,
} from "./arch_fitness_helpers.ts";
import { ROOT_GLOBAL_OPTIONS } from "../src/cli/command_routes.ts";
import { ROOT_ROUTES } from "../src/cli/root_routes.ts";
import { buildCommandTree, createRootCommand } from "../src/cli/mod.ts";
import { type AnyCommand, buildCliSchema } from "../src/cli/cli_schema.ts";
import { VERSION } from "../src/infrastructure/runtime/build_info.ts";
import type {
  RouteWorkerRequest,
  RouteWorkerResponse,
} from "./command_route_worker.ts";

const ROUTE_TABLE = join(ROOT, "src", "cli", "root_routes.ts");

function resolvePath(root: AnyCommand, path: string[]): AnyCommand | undefined {
  let current: AnyCommand | undefined = root;
  for (const word of path) current = current?.getCommand(word, true);
  return current;
}

function schemaOf(node: AnyCommand, path: string[]): string {
  return JSON.stringify(
    buildCliSchema(node, VERSION, {
      stripGlobalOptions: path.length > 0,
      includeHidden: true,
    }),
  );
}

function commandPaths(root: AnyCommand): string[][] {
  const paths: string[][] = [];
  const visit = (command: AnyCommand, path: string[]) => {
    for (const child of command.getCommands(true)) {
      const childPath = [...path, child.getName()];
      paths.push(childPath);
      visit(child, childPath);
    }
  };
  visit(root, []);
  return paths;
}

Deno.test("command routes: each route's module is the file its load imports", async () => {
  const source = await Deno.readTextFile(ROUTE_TABLE);
  const imported = findModuleReferences(ROUTE_TABLE, source)
    .filter((reference) => reference.kind === "dynamic")
    .map((reference) => resolveImport(ROUTE_TABLE, reference.specifier));
  assertEquals(
    imported,
    ROOT_ROUTES.map((route) => route.module),
    "every row of src/cli/root_routes.ts needs exactly one literal import() " +
      "of the file its module field names",
  );
});

Deno.test("command routes: the full tree's top-level commands equal the table", async () => {
  const tree = await buildCommandTree();
  const visible = new Set(tree.getCommands(false));
  const registered = tree.getCommands(true)
    .filter((command) => command.getName() !== "help")
    .map((command) => ({
      name: command.getName(),
      aliases: command.getAliases(),
      hidden: !visible.has(command),
    }));
  assertEquals(
    registered,
    ROOT_ROUTES.map(({ name, aliases, hidden }) => ({
      name,
      aliases: [...aliases],
      hidden,
    })),
  );
});

Deno.test("command routes: no command module is in the static import closure of main.ts", async () => {
  const startup = await staticImportClosure("main.ts");
  assertPinnedSet(
    [...startup].filter((path) => path.startsWith("src/cli/commands/")),
    ["src/cli/commands/help.ts"],
    "command modules in the static import closure of main.ts",
    "A command module imported statically from startup code loads its whole\n" +
      "graph on every invocation. Load it through its row in\n" +
      "src/cli/root_routes.ts, or move what startup needs out of\n" +
      "src/cli/commands/.",
  );
});

Deno.test("command routes: the router's global options are the root's declared options", () => {
  const declared = createRootCommand(false).getOptions(true)
    .filter((option) => option.name !== "help" && option.name !== "version")
    .map((option) => ({
      flags: [...option.flags],
      takesValue: (option.args ?? []).length > 0,
    }));
  assertEquals(
    declared,
    ROOT_GLOBAL_OPTIONS.map(({ flags, takesValue }) => ({
      flags: [...flags],
      takesValue,
    })),
    "ROOT_GLOBAL_OPTIONS in src/cli/command_routes.ts must list the options " +
      "createRootCommand declares, with the same flags and arity",
  );
});

Deno.test("command routes: the tree built for a path has the full tree's schema at that path", async () => {
  // snapshot first: every later build re-parents the shared command instances
  const full = await buildCommandTree();
  const paths = commandPaths(full);
  assert(paths.length > 100, `only ${paths.length} command paths found`);
  const expected = new Map(
    paths.map((
      path,
    ) => [path.join(" "), schemaOf(resolvePath(full, path)!, path)]),
  );

  for (const path of paths) {
    for (const args of [path, ["help", ...path]]) {
      const node = resolvePath(await buildCommandTree(args), path);
      assert(
        node !== undefined,
        `${args.join(" ")}: ${path.join(" ")} missing`,
      );
      assertEquals(
        schemaOf(node, path),
        expected.get(path.join(" ")),
        `swamp ${args.join(" ")}`,
      );
    }
  }
});

function inWorker(request: RouteWorkerRequest): Promise<RouteWorkerResponse> {
  const worker = new Worker(
    new URL("./command_route_worker.ts", import.meta.url).href,
    { type: "module" },
  );
  return new Promise<RouteWorkerResponse>((resolve) => {
    worker.onmessage = (event: MessageEvent<RouteWorkerResponse>) =>
      resolve(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      resolve({ ok: false, error: event.message });
    };
    worker.postMessage(request);
  }).finally(() => worker.terminate());
}

async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    results.push(...await Promise.all(items.slice(i, i + size).map(run)));
  }
  return results;
}

Deno.test("command routes: each route loads alone in a fresh module graph with the full tree's schema", async () => {
  const full = await buildCommandTree();
  const requests: Array<RouteWorkerRequest & { expected: string }> = [
    ...ROOT_ROUTES.map((route) => ({
      args: [route.name],
      path: [route.name],
      expected: schemaOf(resolvePath(full, [route.name])!, [route.name]),
    })),
    { args: undefined, path: [], expected: schemaOf(full, []) },
  ];

  const results = await inBatches(requests, 4, async (request) => ({
    label: request.args?.join(" ") ?? "the full tree",
    expected: request.expected,
    response: await inWorker({ args: request.args, path: request.path }),
  }));

  for (const { label, expected, response } of results) {
    assert(response.ok, `${label}: ${response.ok ? "" : response.error}`);
    assertEquals(response.schema, expected, label);
  }
});
