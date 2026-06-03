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

import type { Command } from "@cliffy/command";

export interface CliOptionSchema {
  flags: string;
  description: string;
  required: boolean;
  default?: unknown;
  collect: boolean;
}

export interface CliArgumentSchema {
  name: string;
  required: boolean;
  variadic: boolean;
}

export interface CliCommandSchema {
  name: string;
  description: string;
  arguments: CliArgumentSchema[];
  options: CliOptionSchema[];
  subcommands: CliCommandSchema[];
}

export interface CliSchema {
  version: string;
  root: CliCommandSchema;
}

/** Option names that Cliffy adds automatically and should be filtered out. */
const BUILTIN_OPTION_NAMES = new Set(["help", "version"]);

/**
 * Relaxed Command type — Cliffy's Command has 8 generic parameters that change
 * with every chained call, making it impossible to type precisely.
 */
// deno-lint-ignore no-explicit-any
export type AnyCommand = Command<any>;

export interface BuildCliSchemaOptions {
  /** When true, strip global options from all commands including the root. */
  stripGlobalOptions?: boolean;
}

/**
 * Builds a structured CLI schema by recursively walking a Cliffy command tree.
 */
export function buildCliSchema(
  rootCommand: AnyCommand,
  version: string,
  options?: BuildCliSchemaOptions,
): CliSchema {
  const stripGlobals = options?.stripGlobalOptions ?? false;
  return {
    version,
    root: walkCommand(rootCommand, !stripGlobals, stripGlobals),
  };
}

function walkCommand(
  cmd: AnyCommand,
  isRoot: boolean,
  stripGlobals: boolean,
): CliCommandSchema {
  const args: CliArgumentSchema[] = cmd.getArguments().map(
    // deno-lint-ignore no-explicit-any
    (arg: any) => ({
      name: arg.name as string,
      required: !arg.optional,
      variadic: arg.variadic === true,
    }),
  );

  const options: CliOptionSchema[] = cmd.getOptions()
    .filter((opt: { name: string }) => !BUILTIN_OPTION_NAMES.has(opt.name))
    .filter((opt: { global?: boolean }) => isRoot || !opt.global)
    // deno-lint-ignore no-explicit-any
    .map((opt: any) => {
      const schema: CliOptionSchema = {
        flags: (opt.flags as string[]).join(", "),
        description: opt.description as string,
        required: opt.required === true,
        collect: opt.collect === true,
      };
      if (opt.default !== undefined) {
        schema.default = opt.default;
      }
      return schema;
    });

  const subcommands: CliCommandSchema[] = cmd.getCommands(false)
    .map((sub: AnyCommand) => walkCommand(sub, false, stripGlobals));

  return {
    name: cmd.getName(),
    description: cmd.getDescription(),
    arguments: args,
    options,
    subcommands,
  };
}
