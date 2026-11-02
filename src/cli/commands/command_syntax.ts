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

export interface CommandSyntax {
  readonly invocation: string;
  readonly surface: CommandSurface;
  /**
   * set only on legacy syntaxes; the factory adds it as the last --help
   * example.
   */
  readonly preferred?: string;
}

/**
 * keeps the parent's surface; the preferred spelling is per command and not
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

export function definitionArgument(surface: CommandSurface): string {
  return `${surface}_id_or_name`;
}

export function runTargetArgument(surface: CommandSurface): string {
  return `${surface}_or_type`;
}

export function outputArgument(surface: CommandSurface): string {
  return `output_id_or_${surface}_name`;
}

export function definitionNameType(surface: CommandSurface): string {
  return `${surface}_name`;
}

export function typeNameType(surface: CommandSurface): string {
  return `${surface}_type`;
}

export const PREFERRED_SPELLING_EXAMPLE = "Preferred spelling";

export function withPreferredExample<
  T extends { example(name: string, description: string): unknown },
>(command: T, syntax: Pick<CommandSyntax, "preferred">): T {
  if (syntax.preferred !== undefined) {
    command.example(PREFERRED_SPELLING_EXAMPLE, syntax.preferred);
  }
  return command;
}

/**
 * a factory-built command mounted only inside a tree is not exported, so
 * architecture tests trace it back to its source through this.
 */
export const DEFINING_MODULE: unique symbol = Symbol.for(
  "swamp.cli.commandDefiningModule",
);

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

export function definingModuleOf(command: object): string | undefined {
  const value = (command as { [DEFINING_MODULE]?: unknown })[DEFINING_MODULE];
  return typeof value === "string" ? value : undefined;
}
