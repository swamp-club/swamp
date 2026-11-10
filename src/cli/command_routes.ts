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

import type { AnyCommand } from "./cli_schema.ts";

export interface CommandRoute {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly hidden: boolean;
  /** repo-relative path of the file `load` imports */
  readonly module: string;
  readonly needsFullTree: boolean;
  /** `rest` is the argv after the command word, for routes that load part of a group */
  load(rest: readonly string[]): Promise<AnyCommand>;
}

export interface OptionSpec {
  readonly flags: readonly string[];
  readonly takesValue: boolean;
}

/** must equal the options `createRootCommand` declares; a fitness rule holds them together */
export const ROOT_GLOBAL_OPTIONS: readonly OptionSpec[] = [
  { flags: ["--json"], takesValue: false },
  { flags: ["--log"], takesValue: false },
  { flags: ["--log-level"], takesValue: true },
  { flags: ["-q", "--quiet"], takesValue: false },
  { flags: ["-v", "--verbose"], takesValue: false },
  { flags: ["--no-telemetry"], takesValue: false },
  { flags: ["--show-properties"], takesValue: false },
  { flags: ["--no-color"], takesValue: false },
];

export const HELP_COMMAND = "help";

const HELP_OPTIONS: readonly OptionSpec[] = [
  { flags: ["--include-hidden"], takesValue: false },
];

export type RouteSelection =
  | { readonly kind: "all" }
  | {
    readonly kind: "route";
    readonly route: CommandRoute;
    readonly rest: readonly string[];
  };

export interface LoadedCommand {
  readonly name: string;
  readonly command: AnyCommand;
}

type Scan =
  | { readonly kind: "word"; readonly index: number }
  | { readonly kind: "end" }
  | { readonly kind: "unknown" };

function findSpec(
  arg: string,
  specs: readonly OptionSpec[],
): { spec: OptionSpec; inlineValue: boolean } | undefined {
  for (const spec of specs) {
    if (spec.flags.includes(arg)) return { spec, inlineValue: false };
    if (
      spec.takesValue &&
      spec.flags.some((flag) =>
        flag.startsWith("--") && arg.startsWith(`${flag}=`)
      )
    ) {
      return { spec, inlineValue: true };
    }
  }
  return undefined;
}

// an option the router cannot place, or a value it cannot see, is "unknown":
// only Cliffy's parse of the full tree may decide what such argv means
function scanForWord(
  args: readonly string[],
  start: number,
  specs: readonly OptionSpec[],
): Scan {
  let i = start;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--") return { kind: "end" };
    if (!arg.startsWith("-")) return { kind: "word", index: i };
    const found = findSpec(arg, specs);
    if (!found) return { kind: "unknown" };
    if (found.spec.takesValue && !found.inlineValue) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { kind: "unknown" };
      }
      i++;
    }
    i++;
  }
  return { kind: "end" };
}

interface Located {
  readonly words: readonly string[];
  readonly next: number;
}

function locate(args: readonly string[]): Located | undefined {
  const first = scanForWord(args, 0, ROOT_GLOBAL_OPTIONS);
  if (first.kind === "unknown") return undefined;
  if (first.kind === "end") return { words: [], next: args.length };
  const word = args[first.index];
  if (word !== HELP_COMMAND) return { words: [word], next: first.index + 1 };

  const target = scanForWord(args, first.index + 1, [
    ...ROOT_GLOBAL_OPTIONS,
    ...HELP_OPTIONS,
  ]);
  if (target.kind === "unknown") return undefined;
  if (target.kind === "end") return { words: [word], next: args.length };
  return { words: [word, args[target.index]], next: target.index + 1 };
}

/** undefined when an option the router does not know comes before the word */
export function commandWords(
  args: readonly string[],
): readonly string[] | undefined {
  return locate(args)?.words;
}

export function selectRoute(
  routes: readonly CommandRoute[],
  args: readonly string[],
): RouteSelection {
  const located = locate(args);
  if (!located || located.words.length === 0) return { kind: "all" };
  const { words, next } = located;
  if (words[0] === HELP_COMMAND && words.length < 2) return { kind: "all" };
  const target = words[words.length - 1];
  const route = routes.find((r) =>
    r.name === target || r.aliases.includes(target)
  );
  if (!route || route.needsFullTree) return { kind: "all" };
  return { kind: "route", route, rest: args.slice(next) };
}

export interface SubcommandSelection {
  readonly route: CommandRoute;
  /** the argv after the subcommand word, so a subgroup can narrow again */
  readonly rest: readonly string[];
}

/**
 * undefined loads the whole group: help is not a subcommand, and an option the
 * root does not declare cannot be placed
 */
export function selectSubcommandWithRest(
  routes: readonly CommandRoute[],
  rest: readonly string[],
): SubcommandSelection | undefined {
  const scan = scanForWord(rest, 0, ROOT_GLOBAL_OPTIONS);
  if (scan.kind !== "word") return undefined;
  const word = rest[scan.index];
  const route = routes.find((r) => r.name === word || r.aliases.includes(word));
  if (!route || route.needsFullTree) return undefined;
  return { route, rest: rest.slice(scan.index + 1) };
}

export function selectSubcommand(
  routes: readonly CommandRoute[],
  rest: readonly string[],
): CommandRoute | undefined {
  return selectSubcommandWithRest(routes, rest)?.route;
}

export function loadGroupRoutes(
  group: string,
  routes: readonly CommandRoute[],
  rest: readonly string[],
): Promise<LoadedCommand[]> {
  const selection = selectSubcommandWithRest(routes, rest);
  return selection
    ? loadRoutes([selection.route], selection.rest, group)
    : loadRoutes(routes, [], group);
}

/** sequential, so command modules evaluate in table order on every run */
export async function loadRoutes(
  routes: readonly CommandRoute[],
  rest: readonly string[] = [],
  parent?: string,
): Promise<LoadedCommand[]> {
  const loaded: LoadedCommand[] = [];
  for (const route of routes) {
    let command: AnyCommand;
    try {
      command = await route.load(rest);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to load the ${
          parent ? `${parent} ` : ""
        }${route.name} command from ${route.module}: ${reason}`,
        { cause: error },
      );
    }
    loaded.push({ name: route.name, command });
  }
  return loaded;
}
