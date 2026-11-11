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
  loadGroupRoutes,
  loadRoutes,
  type RouteSelection,
  selectRoute,
  selectSubcommand,
  selectSubcommandWithRest,
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
  route("audit", { hidden: true }),
  route("completions", { needsFullTree: true }),
  route("issue"),
];

function selected(args: string[]): string | undefined {
  const selection: RouteSelection = selectRoute(ROUTES, args);
  return selection.kind === "routes"
    ? selection.routes.map((r) => r.name).join(",")
    : undefined;
}

function rest(args: string[]): readonly string[] | undefined {
  const selection = selectRoute(ROUTES, args);
  return selection.kind === "routes" ? selection.rest : undefined;
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
  assertEquals(rest(["--json", "data", "get", "x"]), ["get", "x"]);
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
  assertEquals(rest(["help", "data", "get"]), ["get"]);
});

Deno.test("selectRoute: a completion callback loads completions and the route its first name picks, in table order", () => {
  assertEquals(
    selected(["completions", "complete", "model_name", "behavior", "get"]),
    "behavior,completions",
  );
  assertEquals(
    selected(["completions", "complete", "model_name", "behaviour", "get"]),
    "behavior,completions",
  );
  assertEquals(
    selected(["completions", "complete", "x", "summarize"]),
    "summarise,completions",
  );
  assertEquals(
    selected(["completions", "complete", "x", "issue"]),
    "completions,issue",
  );
  assertEquals(
    rest(["completions", "complete", "model_name", "behavior", "get", "x"]),
    ["get", "x"],
  );
});

Deno.test("selectRoute: a completion callback with no name, or naming completions, loads completions alone", () => {
  assertEquals(
    selected(["completions", "complete", "model_name"]),
    "completions",
  );
  assertEquals(rest(["completions", "complete", "model_name"]), []);
  assertEquals(
    selected(["completions", "complete", "x", "completions", "bash"]),
    "completions",
  );
});

Deno.test("selectRoute: root globals may precede completions and complete in a callback", () => {
  assertEquals(
    selected(["--json", "completions", "complete", "x", "data"]),
    "data,completions",
  );
  assertEquals(
    selected(["completions", "--log-level", "debug", "complete", "x", "data"]),
    "data,completions",
  );
});

Deno.test("selectRoute: the full tree for a callback naming an unknown, hidden or help command", () => {
  assertEquals(selectRoute(ROUTES, ["completions", "complete", "x", "bogus"]), {
    kind: "all",
  });
  assertEquals(selectRoute(ROUTES, ["completions", "complete", "x", "audit"]), {
    kind: "all",
  });
  assertEquals(selectRoute(ROUTES, ["completions", "complete", "x", "help"]), {
    kind: "all",
  });
});

Deno.test("selectRoute: the full tree for any option or -- after complete, or no action", () => {
  for (
    const args of [
      ["completions", "complete"],
      ["completions", "complete", "--json", "x", "data"],
      ["completions", "complete", "x", "--", "data"],
      ["completions", "complete", "x", "data", "--json"],
      ["completions", "complete", "-h"],
      ["completions", "--bogus", "complete", "x", "data"],
    ]
  ) {
    assertEquals(selectRoute(ROUTES, args), { kind: "all" }, args.join(" "));
  }
});

Deno.test("selectRoute: the full tree for completions generating a script", () => {
  for (const shell of ["bash", "zsh", "fish", "powershell"]) {
    assertEquals(selectRoute(ROUTES, ["completions", shell]), { kind: "all" });
  }
  assertEquals(selectRoute(ROUTES, ["completions"]), { kind: "all" });
  assertEquals(selectRoute(ROUTES, ["completions", "--", "complete"]), {
    kind: "all",
  });
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

const SUBCOMMANDS = [
  route("get"),
  route("search", { aliases: ["list"] }),
  route("history"),
];

function subcommand(rest: string[]): string | undefined {
  return selectSubcommand(SUBCOMMANDS, rest)?.name;
}

Deno.test("selectSubcommand: picks the first word by name or alias, past root globals", () => {
  assertEquals(subcommand(["get", "m", "x"]), "get");
  assertEquals(subcommand(["list"]), "search");
  assertEquals(subcommand(["--json", "--log-level", "debug", "get"]), "get");
  assertEquals(subcommand(["history", "search"]), "history");
});

Deno.test("selectSubcommand: nothing for no word, --, an unknown word or the help word", () => {
  assertEquals(subcommand([]), undefined);
  assertEquals(subcommand(["--json"]), undefined);
  assertEquals(subcommand(["--", "get"]), undefined);
  assertEquals(subcommand(["gte"]), undefined);
  assertEquals(subcommand(["help", "get"]), undefined);
});

Deno.test("selectSubcommand: nothing when an option the root does not declare precedes the word", () => {
  assertEquals(subcommand(["--help", "get"]), undefined);
  assertEquals(subcommand(["-h", "get"]), undefined);
  assertEquals(subcommand(["--include-hidden", "get"]), undefined);
  assertEquals(subcommand(["--log-level", "get"]), undefined);
});

Deno.test("loadGroupRoutes: loads the selected subcommand alone, or the whole group", async () => {
  assertEquals(
    (await loadGroupRoutes("workflow", SUBCOMMANDS, ["list"])).map((l) =>
      l.name
    ),
    ["search"],
  );
  assertEquals(
    (await loadGroupRoutes("workflow", SUBCOMMANDS, ["help"])).map((l) =>
      l.name
    ),
    ["get", "search", "history"],
  );
});

Deno.test("selectSubcommandWithRest: passes on the argv after the selected word", () => {
  const rest = (args: string[]) =>
    selectSubcommandWithRest(SUBCOMMANDS, args)?.rest;
  assertEquals(rest(["history", "search", "--limit", "5"]), [
    "search",
    "--limit",
    "5",
  ]);
  assertEquals(rest(["--json", "-q", "list", "q"]), ["q"]);
  assertEquals(rest(["get"]), []);
});

Deno.test("selectSubcommandWithRest: selects exactly what selectSubcommand selects", () => {
  const cases: string[][] = [
    [],
    ["get", "m"],
    ["list"],
    ["--log-level=debug", "history"],
    ["--log-level", "debug", "history"],
    ["--", "get"],
    ["gte"],
    ["help", "get"],
    ["--help", "get"],
    ["--include-hidden", "get"],
    ["--log-level", "get"],
  ];
  for (const args of cases) {
    assertStrictEquals(
      selectSubcommandWithRest(SUBCOMMANDS, args)?.route,
      selectSubcommand(SUBCOMMANDS, args),
      args.join(" "),
    );
  }
});

Deno.test("loadGroupRoutes: the selected subcommand loads with the argv after its word, the whole group with none", async () => {
  const seen = new Map<string, readonly string[]>();
  const recording = SUBCOMMANDS.map((r) =>
    route(r.name, { aliases: r.aliases }, (rest) => {
      seen.set(r.name, rest);
      return Promise.resolve(new Command());
    })
  );
  await loadGroupRoutes("model", recording, ["--json", "history", "run", "x"]);
  assertEquals([...seen], [["history", ["run", "x"]]]);
  seen.clear();
  await loadGroupRoutes("model", recording, ["gte", "run"]);
  assertEquals([...seen], [["get", []], ["search", []], ["history", []]]);
});

Deno.test("loadGroupRoutes: a failed import names the group, the subcommand and its module", async () => {
  const failing = route(
    "get",
    { module: "src/cli/commands/data_get.ts" },
    () => Promise.reject(new TypeError("Module not found")),
  );
  await assertRejects(
    () => loadGroupRoutes("data", [failing], ["get"]),
    Error,
    "Failed to load the data get command from src/cli/commands/data_get.ts: Module not found",
  );
});
