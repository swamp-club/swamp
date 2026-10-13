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

import type { CommandSurface } from "../../presentation/command_surface.ts";

/**
 * The per-surface text of a CLI command: how a user types it. A command
 * built from a factory renders its `--help` examples, its description and
 * any hints that name the command from this value, so the same command is
 * mounted under more than one spelling (`swamp model …` and `swamp behavior
 * …`; swamp-club#3330, swamp-club#3331) without the text of one surface
 * naming the other.
 */
export interface CommandSyntax {
  /** The words a user types to reach the command, e.g. `swamp model get`. */
  readonly invocation: string;
  /** Which tree the command is mounted in; picks the log-mode wording. */
  readonly surface: CommandSurface;
  /**
   * The preferred spelling of this command, as a full example invocation
   * (`swamp behavior get my-server`). Set only on legacy syntaxes; the
   * factory then adds it as the last `--help` example.
   */
  readonly preferred?: string;
}

/**
 * The syntax of the subcommand `word` mounted under `parent`. It keeps the
 * parent's surface; a preferred spelling is per command, so it is not
 * inherited.
 */
export function subcommandSyntax(
  parent: CommandSyntax,
  word: string,
): CommandSyntax {
  return {
    invocation: `${parent.invocation} ${word}`,
    surface: parent.surface,
  };
}

/**
 * The name of the positional argument that names a definition on `surface`:
 * `model_id_or_name` or `behavior_id_or_name`. Argument names show in
 * `--help` and `swamp help`, so they follow the spelling (swamp-club#3409);
 * the legacy name is unchanged.
 */
export function definitionArgument(surface: CommandSurface): string {
  return `${surface}_id_or_name`;
}

/**
 * The name of the run target argument on `surface`: `model_or_type` or
 * `behavior_or_type`.
 */
export function runTargetArgument(surface: CommandSurface): string {
  return `${surface}_or_type`;
}

/**
 * The name of the argument that takes an output id or a definition name on
 * `surface`: `output_id_or_model_name` or `output_id_or_behavior_name`.
 */
export function outputArgument(surface: CommandSurface): string {
  return `output_id_or_${surface}_name`;
}

/** The `--help` example title for a legacy command's preferred spelling. */
export const PREFERRED_SPELLING_EXAMPLE = "Preferred spelling";

/**
 * Adds the preferred-spelling example to `command` when `syntax` has one.
 * Call after the command's own examples, so it is listed last.
 */
export function withPreferredExample<
  T extends { example(name: string, description: string): unknown },
>(command: T, syntax: Pick<CommandSyntax, "preferred">): T {
  if (syntax.preferred !== undefined) {
    command.example(PREFERRED_SPELLING_EXAMPLE, syntax.preferred);
  }
  return command;
}

/**
 * The module a factory-built command was defined in, keyed on the command
 * instance. A command built by a factory and mounted only inside a tree is
 * not exported by its defining module, so architecture tests that trace a
 * command back to its source read this instead
 * (integration/json_mode_conformance_test.ts).
 */
export const DEFINING_MODULE: unique symbol = Symbol.for(
  "swamp.cli.commandDefiningModule",
);

/** Records `moduleUrl` (the factory's `import.meta.url`) on `command`. */
export function recordDefiningModule<T extends object>(
  command: T,
  moduleUrl: string,
): T {
  Object.defineProperty(command, DEFINING_MODULE, {
    value: moduleUrl,
    enumerable: false,
  });
  return command;
}

/** The module URL recorded on `command`, if a factory built it. */
export function definingModuleOf(command: object): string | undefined {
  const value = (command as { [DEFINING_MODULE]?: unknown })[DEFINING_MODULE];
  return typeof value === "string" ? value : undefined;
}
