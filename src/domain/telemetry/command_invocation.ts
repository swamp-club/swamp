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

import { type CommandSpelling, isCommandSpelling } from "./command_spelling.ts";

/**
 * Represents a CLI command execution.
 * Values are redacted for privacy - only option keys are logged, not values.
 */
export interface CommandInvocation {
  /** The main command (e.g., "model", "workflow") */
  readonly command: string;
  /** The subcommand (e.g., "create", "run") */
  readonly subcommand?: string;
  /** Positional arguments - categorical values recorded, user-identifiable values redacted */
  readonly args: string[];
  /** Command-specific option keys (e.g., ["--repo-dir", "--json"]) */
  readonly optionKeys: string[];
  /** Global option keys (e.g., ["--verbose", "--json"]) */
  readonly globalOptions: string[];
  /**
   * The full canonical command path as resolved from the command tree
   * (e.g., ["model", "type", "describe"]). Aliases are resolved to the
   * command's name. Absent on entries recorded before it existed.
   */
  readonly commandPath?: string[];
  /**
   * The root word typed for a `swamp model` invocation or one of its
   * `swamp behavior` / `swamp behaviour` spellings. The other fields record
   * all three in the `swamp model` form. Absent for every other group and on
   * entries recorded before it existed.
   */
  readonly commandSpelling?: CommandSpelling;
}

/**
 * Data transfer object for CommandInvocation.
 */
export interface CommandInvocationData {
  command: string;
  subcommand?: string;
  args: string[];
  optionKeys: string[];
  globalOptions: string[];
  commandPath?: string[];
  commandSpelling?: CommandSpelling;
}

/**
 * Creates a CommandInvocation value object. A `commandSpelling` that is not
 * one of the known spellings is dropped: persisted entries are on disk and
 * may be hand-edited or written by a newer version.
 */
export function createCommandInvocation(
  props: CommandInvocationData,
): CommandInvocation {
  const invocation: CommandInvocation = {
    command: props.command,
    subcommand: props.subcommand,
    args: props.args,
    optionKeys: props.optionKeys,
    globalOptions: props.globalOptions,
    commandPath: props.commandPath,
  };
  return isCommandSpelling(props.commandSpelling)
    ? { ...invocation, commandSpelling: props.commandSpelling }
    : invocation;
}

/**
 * Converts a CommandInvocation to its data representation.
 */
export function commandInvocationToData(
  invocation: CommandInvocation,
): CommandInvocationData {
  const data: CommandInvocationData = {
    command: invocation.command,
    args: [...invocation.args],
    optionKeys: [...invocation.optionKeys],
    globalOptions: [...invocation.globalOptions],
  };
  if (invocation.subcommand) {
    data.subcommand = invocation.subcommand;
  }
  if (invocation.commandPath) {
    data.commandPath = [...invocation.commandPath];
  }
  if (invocation.commandSpelling) {
    data.commandSpelling = invocation.commandSpelling;
  }
  return data;
}
