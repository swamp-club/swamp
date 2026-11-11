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
import { Command } from "@cliffy/command";
import fc from "fast-check";
import {
  type CommandRoute,
  HELP_COMMAND,
  ROOT_GLOBAL_OPTIONS,
  selectRoute,
  selectSubcommandWithRest,
} from "./command_routes.ts";
import { ROOT_ROUTES } from "./root_routes.ts";
import { DATA_ROUTES } from "./commands/data_routes.ts";
import { WORKFLOW_ROUTES } from "./commands/workflow_routes.ts";
import {
  BEHAVIOR_ROUTES,
  MODEL_METHOD_ROUTES,
  MODEL_ROUTES,
} from "./commands/model_routes.ts";
import { EXTENSION_ROUTES } from "./commands/extension_routes.ts";
import { VAULT_ROUTES } from "./commands/vault_routes.ts";
import { DATASTORE_ROUTES } from "./commands/datastore_routes.ts";
import {
  ACCESS_ROUTES,
  ACCESS_TOKEN_ROUTES,
} from "./commands/access_routes.ts";
import { createRootCommand } from "./mod.ts";
import type { AnyCommand } from "./cli_schema.ts";

// complete walks visible commands from the root as Cliffy's does, so a callback
// tree missing completions or the command it names ends differently
function completionsStandIn(record: (walked: string) => void): AnyCommand {
  return new Command().action(() => record("completions"))
    .command(
      "complete",
      new Command()
        .noGlobals()
        .arguments("<action:string> [command...:string]")
        .action(function (_options: unknown, ...words: string[]) {
          let at: AnyCommand = this.getMainCommand();
          for (const name of words.slice(1)) {
            const next = at.getCommand(name, false);
            if (!next) throw new Error(`no completion command ${name}`);
            at = next;
          }
          record(`complete at ${at.getPath()}`);
        }),
    );
}

// the real root's options with stand-in children: the router decides only which
// top-level command Cliffy dispatches to, and the stand-ins record exactly that
async function outcome(
  routes: readonly CommandRoute[],
  args: string[],
): Promise<string> {
  let reached = "nothing";
  const root = createRootCommand(false).noExit().throwErrors();
  for (const route of routes) {
    let child: AnyCommand = route.name === "completions"
      ? completionsStandIn((walked) => reached = walked)
      : new Command().useRawArgs().action(() => {
        reached = route.name;
      });
    for (const alias of route.aliases) child = child.alias(alias);
    if (route.hidden) child = child.hidden();
    root.command(route.name, child);
  }
  root.command(
    HELP_COMMAND,
    new Command()
      .arguments("[...command:string]")
      .option("--include-hidden", "")
      .action((_options: unknown, ...path: string[]) => {
        reached = `help ${path.join(" ")}`;
      }),
  );
  try {
    await root.parse(args);
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
  return reached;
}

const routeWord = fc.constantFrom(
  ...ROOT_ROUTES.flatMap((r) => [r.name, ...r.aliases]),
);

const token = fc.oneof(
  routeWord,
  fc.constantFrom(
    HELP_COMMAND,
    "--json",
    "--log",
    "--log-level",
    "--log-level=debug",
    "-q",
    "--quiet",
    "-v",
    "--verbose",
    "--no-telemetry",
    "--show-properties",
    "--no-color",
    "--include-hidden",
    "--",
    "--repo-dir",
    "--bogus",
    "debug",
    "versoin",
    "get",
    "completions",
    "complete",
    "model_name",
    "",
  ),
);

Deno.test("selectRoute: Cliffy's parse ends the same way with only the selected routes registered", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(token, { maxLength: 6 }), async (args) => {
      const selection = selectRoute(ROOT_ROUTES, args);
      if (selection.kind !== "routes") return;
      assertEquals(
        await outcome(selection.routes, args),
        await outcome(ROOT_ROUTES, args),
        args.join(" "),
      );
    }),
    { numRuns: 1000 },
  );
});

const ROOT_HELP_OPTIONS = new Set([
  ...ROOT_GLOBAL_OPTIONS.flatMap((spec) => spec.flags),
  "-h",
  "--help",
]);
const ROUTE_WORDS = new Set(ROOT_ROUTES.flatMap((r) => [r.name, ...r.aliases]));

Deno.test("selectRoute: root help only when argv holds no word, no -- and no option outside the root's globals and help", () => {
  let rootHelp = 0;
  const withHelp = fc.oneof(token, fc.constantFrom("-h", "--help", "-qh"));
  fc.assert(
    fc.property(fc.array(withHelp, { maxLength: 6 }), (args) => {
      if (selectRoute(ROOT_ROUTES, args).kind !== "rootHelp") return;
      rootHelp++;
      for (const [i, arg] of args.entries()) {
        const valueOf = args[i - 1] === "--log-level";
        assert(arg !== "--" && arg !== HELP_COMMAND, args.join(" "));
        assert(!ROUTE_WORDS.has(arg) || valueOf, args.join(" "));
        assert(
          valueOf || arg.startsWith("--log-level=") ||
            ROOT_HELP_OPTIONS.has(arg),
          args.join(" "),
        );
      }
    }),
    { numRuns: 1000 },
  );
  assert(rootHelp > 20, `only ${rootHelp} of 1000 argv were root help`);
});

const callbackArgs = fc.tuple(
  fc.constantFrom<string[]>([], [], ["--json"], ["--log-level", "debug"], [
    "--bogus",
  ]),
  fc.constantFrom<string[]>([], [], [], ["--json"], ["--"]),
  fc.constantFrom("model_name", "workflow_name", "x", "--json"),
  fc.array(
    fc.oneof(
      { weight: 4, arbitrary: routeWord },
      {
        weight: 1,
        arbitrary: fc.constantFrom(HELP_COMMAND, "get", "bogus", "--", ""),
      },
    ),
    { maxLength: 3 },
  ),
).map(([before, between, action, names]) => [
  ...before,
  "completions",
  ...between,
  "complete",
  action,
  ...names,
]);

Deno.test("selectRoute: a completion callback's parse ends the same way with only the selected routes registered", async () => {
  let routed = 0;
  await fc.assert(
    fc.asyncProperty(callbackArgs, async (args) => {
      const selection = selectRoute(ROOT_ROUTES, args);
      if (selection.kind !== "routes") return;
      routed++;
      assertEquals(
        await outcome(selection.routes, args),
        await outcome(ROOT_ROUTES, args),
        args.join(" "),
      );
    }),
    { numRuns: 1000 },
  );
  assert(routed > 300, `only ${routed} of 1000 callbacks were routed`);
});

Deno.test("outcome: the stand-in completions walks visible commands and refuses an unknown one", async () => {
  assertEquals(
    await outcome(ROOT_ROUTES, ["completions", "complete", "x", "behaviour"]),
    "complete at swamp behavior",
  );
  assertEquals(
    await outcome(ROOT_ROUTES, ["completions", "complete", "x"]),
    "complete at swamp",
  );
  assertEquals(
    await outcome(ROOT_ROUTES, ["completions", "complete", "x", "audit"]),
    "error: no completion command audit",
  );
});

Deno.test("outcome: the stand-in tree reaches a route through globals and help, and reports a refused parse", async () => {
  assertEquals(
    await outcome(ROOT_ROUTES, ["--log-level", "debug", "behaviour"]),
    "behavior",
  );
  assertEquals(
    await outcome(ROOT_ROUTES, ["help", "--json", "data", "get"]),
    "help data get",
  );
  assertEquals(
    (await outcome(ROOT_ROUTES, ["--bogus", "data"])).startsWith("error: "),
    true,
  );
});

/** keyed by the command words from the root to the group */
const GROUP_TABLES: ReadonlyMap<string, readonly CommandRoute[]> = new Map([
  ["data", DATA_ROUTES],
  ["workflow", WORKFLOW_ROUTES],
  ["behavior", BEHAVIOR_ROUTES],
  ["model", MODEL_ROUTES],
  ["model method", MODEL_METHOD_ROUTES],
  ["extension", EXTENSION_ROUTES],
  ["vault", VAULT_ROUTES],
  ["datastore", DATASTORE_ROUTES],
  ["access", ACCESS_ROUTES],
  ["access token", ACCESS_TOKEN_ROUTES],
]);

type Narrow = (path: readonly string[]) => readonly CommandRoute[];

const fullGroups: Narrow = (path) => GROUP_TABLES.get(path.join(" "))!;

async function groupOutcome(
  routes: readonly CommandRoute[],
  narrow: Narrow,
  args: string[],
): Promise<string> {
  let reached = "nothing";
  const standIn = (
    path: readonly string[],
    aliases: readonly string[],
  ): AnyCommand => {
    const key = path.join(" ");
    let command: AnyCommand = GROUP_TABLES.has(key)
      ? new Command().action(() => {
        reached = `${key} (group action)`;
      })
      : new Command().useRawArgs().action(() => {
        reached = key;
      });
    for (const alias of aliases) command = command.alias(alias);
    if (GROUP_TABLES.has(key)) {
      for (const sub of narrow(path)) {
        command.command(sub.name, standIn([...path, sub.name], sub.aliases));
      }
    }
    return command;
  };
  const root = createRootCommand(false).noExit().throwErrors();
  for (const route of routes) {
    root.command(route.name, standIn([route.name], route.aliases));
  }
  root.command(
    HELP_COMMAND,
    new Command()
      .arguments("[...command:string]")
      .option("--include-hidden", "")
      .action((_options: unknown, ...path: string[]) => {
        reached = `help ${path.join(" ")}`;
      }),
  );
  try {
    await root.parse(args);
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
  return reached;
}

interface Narrowed {
  readonly routes: readonly CommandRoute[];
  readonly narrow: Narrow;
  readonly selectedUnder: readonly string[];
}

/** selection as the CLI applies it: the root route, then each group in turn */
function narrowedPath(args: string[]): Narrowed | undefined {
  const selection = selectRoute(ROOT_ROUTES, args);
  if (selection.kind !== "routes") return undefined;
  const chosen = new Map<string, CommandRoute>();
  const root = selection.routes.find((r) => GROUP_TABLES.has(r.name)) ??
    selection.routes[0];
  let path = [root.name];
  let rest = selection.rest;
  for (;;) {
    const table = GROUP_TABLES.get(path.join(" "));
    const sub = table && selectSubcommandWithRest(table, rest);
    if (!sub) break;
    chosen.set(path.join(" "), sub.route);
    path = [...path, sub.route.name];
    rest = sub.rest;
  }
  return {
    routes: selection.routes,
    narrow: (at) => {
      const picked = chosen.get(at.join(" "));
      return picked ? [picked] : fullGroups(at);
    },
    selectedUnder: [...chosen.keys()],
  };
}

const subcommandWord = fc.constantFrom(
  ...[...GROUP_TABLES.values()].flat().flatMap((r) => [r.name, ...r.aliases]),
);

const groupToken = fc.oneof(
  subcommandWord,
  fc.constantFrom(
    HELP_COMMAND,
    "--json",
    "--log-level",
    "--log-level=debug",
    "-q",
    "--include-hidden",
    "--",
    "--bogus",
    "debug",
    "gte",
    "methd",
    "search",
    "",
  ),
);

const ROOT_GROUP_WORDS = ROOT_ROUTES
  .filter((route) => GROUP_TABLES.has(route.name))
  .flatMap((route) => [route.name, ...route.aliases]);

function wordsOf(routes: readonly CommandRoute[]): string[] {
  return routes.flatMap((r) => [r.name, ...r.aliases]);
}

// walks the real tables so deep paths come up often; past a leaf it repeats a
// sibling's word, where a wrong rest would select the wrong subcommand
const groupArgs = fc.record({
  prefix: fc.constantFrom<string[]>([], ["help"], ["--json"], [
    "help",
    "--json",
  ], ["--log-level", "debug"]),
  root: fc.constantFrom(...ROOT_GROUP_WORDS),
  steps: fc.array(
    fc.tuple(fc.nat(), fc.array(groupToken, { maxLength: 2 })),
    { maxLength: 4 },
  ),
  tail: fc.array(groupToken, { maxLength: 2 }),
}).map(({ prefix, root, steps, tail }) => {
  const args = [...prefix, root];
  let group = ROOT_ROUTES.find((r) => wordsOf([r]).includes(root))!.name;
  let siblings = wordsOf(GROUP_TABLES.get(group)!);
  for (const [pick, noise] of steps) {
    args.push(...noise);
    const table = GROUP_TABLES.get(group);
    const words = table ? wordsOf(table) : siblings;
    const word = words[pick % words.length];
    args.push(word);
    if (table) {
      siblings = words;
      const route = table.find((r) => wordsOf([r]).includes(word))!;
      group = `${group} ${route.name}`;
    }
  }
  return [...args, ...tail];
});

Deno.test("selectSubcommandWithRest: Cliffy's parse ends the same way with only the selected path registered, at every group level", async () => {
  await fc.assert(
    fc.asyncProperty(groupArgs, async (args) => {
      const narrowed = narrowedPath(args);
      if (!narrowed) return;
      const outcome = await groupOutcome(
        narrowed.routes,
        narrowed.narrow,
        args,
      );
      assertEquals(
        outcome,
        await groupOutcome(ROOT_ROUTES, fullGroups, args),
        args.join(" "),
      );
      for (const group of narrowed.selectedUnder) {
        assert(
          outcome !== `${group} (group action)`,
          `${args.join(" ")}: a subcommand selected under ${group} ` +
            "reached its group action",
        );
      }
    }),
    { numRuns: 3000 },
  );
});

Deno.test("groupOutcome: the stand-in tree reaches a subcommand by alias and through a subgroup, and each group action with no word", async () => {
  const reach = (args: string[]) => groupOutcome(ROOT_ROUTES, fullGroups, args);
  assertEquals(await reach(["workflow", "--json", "list"]), "workflow search");
  assertEquals(await reach(["data"]), "data (group action)");
  assertEquals(await reach(["behaviour", "list"]), "behavior search");
  assertEquals(
    await reach(["--json", "model", "method", "run", "m", "x"]),
    "model method run",
  );
  assertEquals(
    await reach(["help", "model", "method", "run"]),
    "help model method run",
  );
  assertEquals(await reach(["model", "method"]), "model method (group action)");
});
