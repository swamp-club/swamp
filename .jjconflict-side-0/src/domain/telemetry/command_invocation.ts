// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
}

/**
 * Creates a CommandInvocation value object.
 */
export function createCommandInvocation(
  props: CommandInvocationData,
): CommandInvocation {
  return {
    command: props.command,
    subcommand: props.subcommand,
    args: props.args,
    optionKeys: props.optionKeys,
    globalOptions: props.globalOptions,
  };
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
  return data;
}
