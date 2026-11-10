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
import { Command } from "@cliffy/command";
import fc from "fast-check";
import {
  type CommandRoute,
  HELP_COMMAND,
  selectRoute,
  selectSubcommand,
} from "./command_routes.ts";
import { ROOT_ROUTES } from "./root_routes.ts";
import { DATA_ROUTES } from "./commands/data_routes.ts";
import { WORKFLOW_ROUTES } from "./commands/workflow_routes.ts";
import { createRootCommand } from "./mod.ts";

// the real root's options with stand-in children: the router decides only which
// top-level command Cliffy dispatches to, and the stand-ins record exactly that
async function outcome(
  routes: readonly CommandRoute[],
  args: string[],
): Promise<string> {
  let reached = "nothing";
  const root = createRootCommand(false).noExit().throwErrors();
  for (const route of routes) {
    let child = new Command().useRawArgs().action(() => {
      reached = route.name;
    });
    for (const alias of route.aliases) child = child.alias(alias);
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
    "",
  ),
);

Deno.test("selectRoute: Cliffy's parse ends the same way with only the selected route registered", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(token, { maxLength: 6 }), async (args) => {
      const selection = selectRoute(ROOT_ROUTES, args);
      if (selection.kind === "all") return;
      assertEquals(
        await outcome([selection.route], args),
        await outcome(ROOT_ROUTES, args),
        args.join(" "),
      );
    }),
    { numRuns: 1000 },
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

const GROUP_TABLES: ReadonlyMap<string, readonly CommandRoute[]> = new Map([
  ["data", DATA_ROUTES],
  ["workflow", WORKFLOW_ROUTES],
]);

// as outcome, but the routed groups are stand-in headers with stand-in
// subcommands; a header records when its own action runs, the path where
// groupCommandAction would list a narrowed group's children
async function groupOutcome(
  routes: readonly CommandRoute[],
  subcommands: (group: string) => readonly CommandRoute[],
  args: string[],
): Promise<string> {
  let reached = "nothing";
  const root = createRootCommand(false).noExit().throwErrors();
  for (const route of routes) {
    const table = GROUP_TABLES.get(route.name);
    let child = table
      ? new Command().action(() => {
        reached = `${route.name} (group action)`;
      })
      : new Command().useRawArgs().action(() => {
        reached = route.name;
      });
    for (const alias of route.aliases) child = child.alias(alias);
    if (table) {
      for (const sub of subcommands(route.name)) {
        let leaf = new Command().useRawArgs().action(() => {
          reached = `${route.name} ${sub.name}`;
        });
        for (const alias of sub.aliases) leaf = leaf.alias(alias);
        child.command(sub.name, leaf);
      }
    }
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
    "search",
    "",
  ),
);

const groupArgs = fc.tuple(
  fc.constantFrom<string[]>([], ["help"], ["--json"], ["help", "--json"], [
    "--log-level",
    "debug",
  ]),
  fc.constantFrom(...GROUP_TABLES.keys()),
  fc.array(groupToken, { maxLength: 5 }),
).map(([prefix, group, rest]) => [...prefix, group, ...rest]);

Deno.test("selectSubcommand: Cliffy's parse ends the same way with only the selected route and subcommand registered", async () => {
  await fc.assert(
    fc.asyncProperty(groupArgs, async (args) => {
      const selection = selectRoute(ROOT_ROUTES, args);
      if (selection.kind === "all") return;
      const table = GROUP_TABLES.get(selection.route.name);
      const sub = table && selectSubcommand(table, selection.rest);
      const narrowed = await groupOutcome(
        [selection.route],
        (group) => sub ? [sub] : GROUP_TABLES.get(group)!,
        args,
      );
      assertEquals(
        narrowed,
        await groupOutcome(
          ROOT_ROUTES,
          (group) => GROUP_TABLES.get(group)!,
          args,
        ),
        args.join(" "),
      );
      if (sub) {
        assertEquals(
          narrowed.endsWith("(group action)"),
          false,
          `${args.join(" ")}: a selected subcommand reached the group action`,
        );
      }
    }),
    { numRuns: 1000 },
  );
});

Deno.test("groupOutcome: the stand-in tree reaches a subcommand by alias and the group action with no word", async () => {
  const all = (group: string) => GROUP_TABLES.get(group)!;
  assertEquals(
    await groupOutcome(ROOT_ROUTES, all, ["workflow", "--json", "list"]),
    "workflow search",
  );
  assertEquals(
    await groupOutcome(ROOT_ROUTES, all, ["data"]),
    "data (group action)",
  );
});
