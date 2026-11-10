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
import {
  type CommandRoute,
  ROOT_GLOBAL_OPTIONS,
  selectRoute,
} from "../src/cli/command_routes.ts";
import { ROOT_ROUTES } from "../src/cli/root_routes.ts";
import { DATA_ROUTES } from "../src/cli/commands/data_routes.ts";
import { WORKFLOW_ROUTES } from "../src/cli/commands/workflow_routes.ts";
import {
  BEHAVIOR_ROUTES,
  MODEL_METHOD_ROUTES,
  MODEL_ROUTES,
} from "../src/cli/commands/model_routes.ts";
import {
  BEHAVIOR_GROUP_WORDS,
  METHOD_LEVEL_WORDS,
  MODEL_GROUP_WORD,
  MODEL_METHOD_WORD,
} from "../src/cli/behavior_twin.ts";
import { rewriteDirectTypeArgs } from "../src/cli/arg_rewriter.ts";
import { buildCommandTree, createRootCommand } from "../src/cli/mod.ts";
import { type AnyCommand, buildCliSchema } from "../src/cli/cli_schema.ts";
import { VERSION } from "../src/infrastructure/runtime/build_info.ts";
import type {
  RouteWorkerRequest,
  RouteWorkerResponse,
} from "./command_route_worker.ts";
import { completionOwners, walkVisible } from "./command_completion_helpers.ts";

const ROUTE_TABLE = join(ROOT, "src", "cli", "root_routes.ts");

interface GroupTable {
  /** the command words from the root to the group */
  readonly path: readonly string[];
  readonly file: string;
  readonly routes: readonly CommandRoute[];
}

const GROUP_TABLES: readonly GroupTable[] = [
  {
    path: ["data"],
    file: "src/cli/commands/data_routes.ts",
    routes: DATA_ROUTES,
  },
  {
    path: ["workflow"],
    file: "src/cli/commands/workflow_routes.ts",
    routes: WORKFLOW_ROUTES,
  },
  {
    path: ["behavior"],
    file: "src/cli/commands/model_routes.ts",
    routes: BEHAVIOR_ROUTES,
  },
  {
    path: ["model"],
    file: "src/cli/commands/model_routes.ts",
    routes: MODEL_ROUTES,
  },
  {
    path: ["model", "method"],
    file: "src/cli/commands/model_routes.ts",
    routes: MODEL_METHOD_ROUTES,
  },
];

function childrenOf(node: AnyCommand) {
  const visible = new Set(node.getCommands(false));
  return node.getCommands(true).map((command) => ({
    name: command.getName(),
    aliases: command.getAliases(),
    hidden: !visible.has(command),
  }));
}

function tableRows(routes: readonly CommandRoute[]) {
  return routes.map(({ name, aliases, hidden }) => ({
    name,
    aliases: [...aliases],
    hidden,
  }));
}

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

Deno.test("command routes: each group row's module is the file its load imports", async () => {
  const files = [...new Set(GROUP_TABLES.map((table) => table.file))];
  for (const file of files) {
    const tables = GROUP_TABLES.filter((table) => table.file === file);
    const path = join(ROOT, file);
    const imported = findModuleReferences(path, await Deno.readTextFile(path))
      .filter((reference) => reference.kind === "dynamic")
      .map((reference) => resolveImport(path, reference.specifier));
    if (tables.length === 1) {
      assertEquals(
        imported,
        tables[0].routes.map((route) => route.module),
        `every row of ${file} needs exactly one literal import() of the file ` +
          "its module field names",
      );
      continue;
    }
    assertEquals(
      imported.length,
      new Set(imported).size,
      `${file} imports a module twice; define each shared row once`,
    );
    assertEquals(
      [...imported].sort(),
      [
        ...new Set(
          tables.flatMap((table) => table.routes.map((route) => route.module)),
        ),
      ].sort(),
      `every shared row of ${file} needs exactly one literal import() of ` +
        "the file its module field names",
    );
  }
});

Deno.test("command routes: each group's children in the full tree equal its table", async () => {
  const tree = await buildCommandTree();
  for (const { path, file, routes } of GROUP_TABLES) {
    assertEquals(
      childrenOf(resolvePath(tree, [...path])!),
      tableRows(routes),
      `${file} must list every swamp ${path.join(" ")} subcommand in ` +
        "registration order with its aliases and hidden flag; an alias " +
        "missing from the table makes routing load the whole group",
    );
  }
});

function loadedChildren(tree: AnyCommand, path: readonly string[]) {
  return resolvePath(tree, [...path])?.getCommands(true).map((
    c: AnyCommand,
  ) => c.getName());
}

function assertOnlyPathLoaded(
  tree: AnyCommand,
  path: readonly string[],
  message: string,
): void {
  for (let depth = 1; depth < path.length; depth++) {
    assertEquals(
      loadedChildren(tree, path.slice(0, depth)),
      [path[depth]],
      message,
    );
  }
}

Deno.test("command routes: a subcommand path loads only that subcommand under its group", async () => {
  for (const { path, routes } of GROUP_TABLES) {
    for (const route of routes) {
      for (const word of [route.name, ...route.aliases]) {
        for (const args of [[...path, word], ["help", ...path, word]]) {
          assertOnlyPathLoaded(
            await buildCommandTree(args),
            [...path, route.name],
            `swamp ${args.join(" ")} should load only ${route.module}`,
          );
        }
      }
    }
  }
});

Deno.test("command routes: a direct-type model method run, once rewritten, loads only run", async () => {
  const args = rewriteDirectTypeArgs([
    "model",
    "@swamp/echo",
    "method",
    "run",
    "echo",
    "my-def",
  ]);
  assertOnlyPathLoaded(
    await buildCommandTree(args),
    ["model", "method", "run"],
    `swamp ${args.join(" ")} should load only model method run`,
  );
});

Deno.test("command routes: the behavior twin's word lists agree with the route tables", () => {
  const names = (routes: readonly CommandRoute[]) => routes.map((r) => r.name);
  assertEquals(
    names(MODEL_METHOD_ROUTES),
    [...METHOD_LEVEL_WORDS],
    "METHOD_LEVEL_WORDS in src/cli/behavior_twin.ts must name the model " +
      "method subcommands, in order",
  );
  const modelLevel = names(MODEL_ROUTES).filter((name) =>
    name !== MODEL_METHOD_WORD
  );
  assertEquals(
    modelLevel.filter((name) => METHOD_LEVEL_WORDS.includes(name)),
    [],
    "a method-level word must not also be a model subcommand",
  );
  assertEquals(
    [...names(BEHAVIOR_ROUTES)].sort(),
    [...modelLevel, ...METHOD_LEVEL_WORDS].sort(),
    "behavior must route the model subcommands and the method-level " +
      "subcommands, with no method level of its own",
  );
  assert(
    names(MODEL_ROUTES).includes(MODEL_METHOD_WORD),
    `${MODEL_METHOD_WORD} must be a model subcommand`,
  );
  const behaviorRoot = ROOT_ROUTES.find((r) => r.name === "behavior");
  assertEquals(
    behaviorRoot && [behaviorRoot.name, ...behaviorRoot.aliases],
    [...BEHAVIOR_GROUP_WORDS],
    "BEHAVIOR_GROUP_WORDS must be the behavior route's name and aliases",
  );
  assert(
    ROOT_ROUTES.some((r) => r.name === MODEL_GROUP_WORD),
    `${MODEL_GROUP_WORD} must be a root route`,
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

Deno.test("command routes: a completion callback's tree resolves each completion from the same command as the full tree", async () => {
  // snapshot first: every later build re-parents the shared command instances
  const full = await buildCommandTree();
  const primary: string[][] = [[]];
  const visit = (command: AnyCommand, path: string[]) => {
    for (const child of command.getBaseCommands(false)) {
      const childPath = [...path, child.getName()];
      primary.push(childPath);
      visit(child, childPath);
    }
  };
  visit(full, []);
  const aliased = ROOT_ROUTES.flatMap((route) =>
    route.aliases.flatMap((alias) =>
      primary
        .filter((path) => path[0] === route.name)
        .map((path) => [alias, ...path.slice(1)])
    )
  );
  const paths = [...primary, ...aliased];
  assert(primary.length > 100, `only ${primary.length} command paths found`);
  assert(aliased.length > 0, "no route alias reached");
  const expected = new Map(
    paths.map((
      path,
    ) => [path.join(" "), completionOwners(walkVisible(full, path)!)]),
  );

  for (const path of paths) {
    const args = ["completions", "complete", "action", ...path];
    const selection = selectRoute(ROOT_ROUTES, args);
    assert(
      selection.kind === "routes" && selection.routes.length <= 2,
      `swamp ${args.join(" ")} loads the full tree`,
    );
    const node = walkVisible(await buildCommandTree(args), path);
    assert(node !== undefined, `swamp ${args.join(" ")}: path missing`);
    assertEquals(
      completionOwners(node),
      expected.get(path.join(" ")),
      `swamp ${args.join(" ")}`,
    );
  }

  for (const route of ROOT_ROUTES.filter((r) => r.hidden)) {
    assertEquals(
      selectRoute(ROOT_ROUTES, [
        "completions",
        "complete",
        "action",
        route.name,
      ]),
      { kind: "all" },
      `a callback naming hidden ${route.name} keeps the full tree`,
    );
  }
});

// a worker that exits or stalls without answering would otherwise hold the
// test, and with it the whole run, until an outer cap with no route named
const WORKER_DEADLINE_MS = 120_000;

function inWorker(request: RouteWorkerRequest): Promise<RouteWorkerResponse> {
  const worker = new Worker(
    new URL("./command_route_worker.ts", import.meta.url).href,
    { type: "module" },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<RouteWorkerResponse>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ok: false,
          error: `no answer within ${WORKER_DEADLINE_MS}ms`,
        }),
      WORKER_DEADLINE_MS,
    );
    worker.onmessage = (event: MessageEvent<RouteWorkerResponse>) =>
      resolve(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      resolve({ ok: false, error: event.message });
    };
    worker.postMessage(request);
  }).finally(() => {
    clearTimeout(timer);
    worker.terminate();
  });
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

Deno.test("command routes: each route loads alone in a fresh module graph with the full tree's schema and error handlers", async () => {
  const full = await buildCommandTree();
  const requests: Array<RouteWorkerRequest & { expected: string }> = [
    ...ROOT_ROUTES.map((route) => ({
      args: [route.name],
      path: [route.name],
      expected: schemaOf(resolvePath(full, [route.name])!, [route.name]),
    })),
    ...GROUP_TABLES.flatMap(({ path: group, routes }) =>
      routes.map((route) => {
        const path = [...group, route.name];
        return {
          args: path,
          path,
          expected: schemaOf(resolvePath(full, path)!, path),
        };
      })
    ),
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

  // in a fresh graph, as in the binary: a command shared between two parents
  // keeps the parent its own module gave it unless the full tree re-parents it
  const fullTree = results[results.length - 1].response;
  assert(fullTree.ok);
  for (const { label, response } of results.slice(0, -1)) {
    assert(response.ok);
    for (const [path, handler] of Object.entries(response.errorHandlers)) {
      assertEquals(
        handler,
        fullTree.errorHandlers[path],
        `swamp ${path} (loading ${label}) reports refused input through a ` +
          "different error handler than with the full tree",
      );
    }
  }
});

Deno.test("command routes: a completion callback's routes in a fresh module graph resolve each completion from the same command as the full tree", async () => {
  const requests: RouteWorkerRequest[] = [
    ...ROOT_ROUTES.filter((route) => !route.hidden).map((route) => ({
      args: ["completions", "complete", "action", route.name],
      path: [route.name],
    })),
    { args: ["completions", "complete", "action"], path: [] },
  ];
  const [fullTree, ...results] = await inBatches(
    [{ args: undefined, path: [] }, ...requests],
    4,
    async (request) => ({
      label: request.args?.join(" ") ?? "the full tree",
      response: await inWorker(request),
    }),
  );
  assert(
    fullTree.response.ok,
    fullTree.response.ok ? "" : fullTree.response.error,
  );

  for (const { label, response } of results) {
    assert(response.ok, `${label}: ${response.ok ? "" : response.error}`);
    assert(
      Object.keys(response.completionOwners).length > 0,
      `${label}: nothing walked`,
    );
    for (const [path, owners] of Object.entries(response.completionOwners)) {
      assertEquals(
        owners,
        fullTree.response.completionOwners[path],
        `swamp ${path} (loading ${label}) resolves its completions from ` +
          "different commands than with the full tree",
      );
    }
  }
});
