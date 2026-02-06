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
