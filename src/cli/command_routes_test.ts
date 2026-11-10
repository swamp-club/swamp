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

import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { Command } from "@cliffy/command";
import {
  type CommandRoute,
  commandWords,
  loadRoutes,
  type RouteSelection,
  selectRoute,
} from "./command_routes.ts";

function route(
  name: string,
  options: Partial<Omit<CommandRoute, "name" | "load">> = {},
  load: CommandRoute["load"] = () => Promise.resolve(new Command()),
): CommandRoute {
  return {
    name,
    aliases: options.aliases ?? [],
    hidden: options.hidden ?? false,
    module: options.module ?? `src/cli/commands/${name}.ts`,
    needsFullTree: options.needsFullTree ?? false,
    load,
  };
}

const ROUTES = [
  route("version"),
  route("behavior", { aliases: ["behaviour"] }),
  route("summarise", { aliases: ["summarize"] }),
  route("data"),
  route("completions", { needsFullTree: true }),
];

function selected(args: string[]): string | undefined {
  const selection: RouteSelection = selectRoute(ROUTES, args);
  return selection.kind === "route" ? selection.route.name : undefined;
}

Deno.test("commandWords: skips root globals before and after the command word", () => {
  assertEquals(commandWords(["--json", "-q", "version", "--verbose"]), [
    "version",
  ]);
  assertEquals(commandWords(["version", "--json"]), ["version"]);
});

Deno.test("commandWords: --log-level takes its value spaced or after =", () => {
  assertEquals(commandWords(["--log-level", "debug", "data", "get"]), [
    "data",
  ]);
  assertEquals(commandWords(["--log-level=debug", "data"]), ["data"]);
});

Deno.test("commandWords: --log-level with no value, or a dash next, is unknown", () => {
  assertEquals(commandWords(["--log-level"]), undefined);
  assertEquals(commandWords(["--log-level", "-q", "data"]), undefined);
});

Deno.test("commandWords: an option the root does not declare comes before the word", () => {
  assertEquals(commandWords(["--repo-dir", "x", "data"]), undefined);
  assertEquals(commandWords(["-h"]), undefined);
  assertEquals(commandWords(["--version"]), undefined);
  assertEquals(commandWords(["-qv", "data"]), undefined);
  assertEquals(commandWords(["--json=true", "data"]), undefined);
});

Deno.test("commandWords: no word, or -- before one, yields no words", () => {
  assertEquals(commandWords([]), []);
  assertEquals(commandWords(["--json"]), []);
  assertEquals(commandWords(["--", "data"]), []);
});

Deno.test("commandWords: help names the first word of its path", () => {
  assertEquals(commandWords(["help"]), ["help"]);
  assertEquals(commandWords(["help", "data", "get"]), ["help", "data"]);
  assertEquals(
    commandWords(["help", "--include-hidden", "--log-level", "x", "data"]),
    ["help", "data"],
  );
  assertEquals(commandWords(["help", "--", "data"]), ["help"]);
  assertEquals(commandWords(["help", "--bogus", "data"]), undefined);
});

Deno.test("selectRoute: picks the invoked route by name or alias, passing on the rest", () => {
  assertEquals(selected(["version"]), "version");
  assertEquals(selected(["behaviour", "run"]), "behavior");
  assertEquals(selected(["summarize"]), "summarise");
  const selection = selectRoute(ROUTES, ["--json", "data", "get", "x"]);
  assertEquals(
    selection.kind === "route" ? selection.rest : undefined,
    ["get", "x"],
  );
});

Deno.test("selectRoute: the full tree for no word, an unknown word or an unknown option", () => {
  assertEquals(selectRoute(ROUTES, []), { kind: "all" });
  assertEquals(selectRoute(ROUTES, ["versoin"]), { kind: "all" });
  assertEquals(selectRoute(ROUTES, ["--help"]), { kind: "all" });
  assertEquals(selectRoute(ROUTES, ["--", "version"]), { kind: "all" });
});

Deno.test("selectRoute: the full tree for bare help and for a route that needs it", () => {
  assertEquals(selectRoute(ROUTES, ["help"]), { kind: "all" });
  assertEquals(selectRoute(ROUTES, ["help", "--include-hidden"]), {
    kind: "all",
  });
  assertEquals(selectRoute(ROUTES, ["completions", "bash"]), { kind: "all" });
  assertEquals(selectRoute(ROUTES, ["help", "completions"]), { kind: "all" });
});

Deno.test("selectRoute: help with a path loads the route its first word names", () => {
  assertEquals(selected(["help", "data", "get"]), "data");
  assertEquals(selected(["help", "behaviour"]), "behavior");
  assertEquals(selectRoute(ROUTES, ["help", "bogus"]), { kind: "all" });
  const selection = selectRoute(ROUTES, ["help", "data", "get"]);
  assertEquals(
    selection.kind === "route" ? selection.rest : undefined,
    ["get"],
  );
});

Deno.test("loadRoutes: loads in table order and passes the rest to each load", async () => {
  const order: string[] = [];
  const commands = new Map<string, Command>();
  const tracked = (name: string) =>
    route(name, {}, (rest) => {
      order.push(`${name}:${rest.join(" ")}`);
      const command = new Command();
      commands.set(name, command);
      return Promise.resolve(command);
    });
  const loaded = await loadRoutes([tracked("b"), tracked("a")], ["x"]);
  assertEquals(order, ["b:x", "a:x"]);
  assertEquals(loaded.map((l) => l.name), ["b", "a"]);
  assertStrictEquals(loaded[0].command, commands.get("b"));
});

Deno.test("loadRoutes: a failed import names the command and its module", async () => {
  const cause = new TypeError("Module not found");
  const failing = route(
    "data",
    { module: "src/cli/commands/data.ts" },
    () => Promise.reject(cause),
  );
  const error = await assertRejects(
    () => loadRoutes([route("version"), failing]),
    Error,
    "Failed to load the data command from src/cli/commands/data.ts: Module not found",
  );
  assertStrictEquals(error.cause, cause);
});
