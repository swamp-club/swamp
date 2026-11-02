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

/** values are redacted for privacy: only option keys are logged, not values */
export interface CommandInvocation {
  readonly command: string;
  readonly subcommand?: string;
  /** Positional arguments - categorical values recorded, user-identifiable values redacted */
  readonly args: string[];
  readonly optionKeys: string[];
  readonly globalOptions: string[];
  /**
   * the full canonical command path from the command tree, with aliases
   * resolved to the command's name
   */
  readonly commandPath?: string[];
  /**
   * the root word typed for model or its behavior/behaviour spellings; the
   * other fields record all three in the swamp model form; absent for every
   * other group
   */
  readonly commandSpelling?: CommandSpelling;
}

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
 * an unknown commandSpelling is dropped: persisted entries may be hand-edited
 * or written by a newer version
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
