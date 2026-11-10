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
} from "./command_routes.ts";
import { ROOT_ROUTES } from "./root_routes.ts";
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
