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
  /** Whether the option consumes a value, as opposed to being a bare flag. */
  takesValue: boolean;
  /**
   * The value as declared, e.g. `<level:string>` or `[tag:string]` — angle
   * brackets for a required value, square brackets for an optional one. Only
   * present when `takesValue` is true.
   */
  value?: string;
  hidden: boolean;
}

export interface CliArgumentSchema {
  name: string;
  required: boolean;
  variadic: boolean;
}

export interface CliCommandSchema {
  name: string;
  aliases: string[];
  description: string;
  hidden: boolean;
  arguments: CliArgumentSchema[];
  options: CliOptionSchema[];
  globalOptions?: CliOptionSchema[];
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
  /** When true, list hidden commands and hidden options too. */
  includeHidden?: boolean;
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
  const includeHidden = options?.includeHidden ?? false;
  const parent: AnyCommand | undefined = rootCommand.getParent();
  const root = walkCommand(
    rootCommand,
    !stripGlobals,
    includeHidden,
    parent !== undefined && isHiddenIn(parent, rootCommand),
  );
  if (stripGlobals) {
    root.globalOptions = rootCommand.getOptions(includeHidden)
      .filter((opt: { name: string }) => !BUILTIN_OPTION_NAMES.has(opt.name))
      .filter((opt: { global?: boolean }) => opt.global === true)
      .map(toOptionSchema);
  }
  return { version, root };
}

/**
 * Cliffy has no public getter for a command's hidden state, so ask the parent
 * whether it lists the child among its visible commands.
 */
function isHiddenIn(parent: AnyCommand, child: AnyCommand): boolean {
  return !parent.getCommands(false).includes(child);
}

// deno-lint-ignore no-explicit-any
function toOptionSchema(opt: any): CliOptionSchema {
  const takesValue = (opt.args as unknown[]).length > 0;
  const schema: CliOptionSchema = {
    flags: (opt.flags as string[]).join(", "),
    description: opt.description as string,
    required: opt.required === true,
    collect: opt.collect === true,
    takesValue,
    hidden: opt.hidden === true,
  };
  if (takesValue) {
    schema.value = opt.typeDefinition as string;
  }
  if (opt.default !== undefined) {
    schema.default = opt.default;
  }
  return schema;
}

function walkCommand(
  cmd: AnyCommand,
  isRoot: boolean,
  includeHidden: boolean,
  hidden: boolean,
): CliCommandSchema {
  const args: CliArgumentSchema[] = cmd.getArguments().map(
    // deno-lint-ignore no-explicit-any
    (arg: any) => ({
      name: arg.name as string,
      required: !arg.optional,
      variadic: arg.variadic === true,
    }),
  );

  const options: CliOptionSchema[] = cmd.getOptions(includeHidden)
    .filter((opt: { name: string }) => !BUILTIN_OPTION_NAMES.has(opt.name))
    .filter((opt: { global?: boolean }) => isRoot || !opt.global)
    .map(toOptionSchema);

  const subcommands: CliCommandSchema[] = cmd.getCommands(includeHidden)
    .map((sub: AnyCommand) =>
      walkCommand(sub, false, includeHidden, isHiddenIn(cmd, sub))
    );

  return {
    name: cmd.getName(),
    aliases: cmd.getAliases(),
    description: cmd.getDescription(),
    hidden,
    arguments: args,
    options,
    subcommands,
  };
}
