import type { CommandInvocationData } from "../domain/telemetry/mod.ts";

/** Global options that are tracked separately */
const GLOBAL_OPTIONS = new Set([
  "--debug-logs",
  "--json",
  "--stream",
  "-q",
  "--quiet",
  "-v",
  "--verbose",
  "--no-telemetry",
]);

/**
 * Extracts command information from CLI arguments for telemetry.
 * Option values are redacted - only keys are recorded.
 *
 * @param args - The raw CLI arguments
 * @returns Parsed command invocation data
 */
export function extractCommandInfo(args: string[]): CommandInvocationData {
  const result: CommandInvocationData = {
    command: "",
    args: [],
    optionKeys: [],
    globalOptions: [],
  };

  let i = 0;

  // Skip leading global options to find the command
  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith("-")) {
      // This is an option
      if (GLOBAL_OPTIONS.has(arg)) {
        result.globalOptions.push(arg);
      }
      // Skip value if this option takes one (next arg doesn't start with -)
      if (
        i + 1 < args.length &&
        !args[i + 1].startsWith("-") &&
        !isKnownFlag(arg)
      ) {
        i++; // Skip the value
      }
      i++;
      continue;
    }

    // Found the command
    result.command = arg;
    i++;
    break;
  }

  // Look for subcommand
  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith("-")) {
      // Option before subcommand - record it
      if (GLOBAL_OPTIONS.has(arg)) {
        result.globalOptions.push(arg);
      } else {
        result.optionKeys.push(arg.split("=")[0]); // Handle --option=value
      }
      // Skip value if this option takes one
      if (
        i + 1 < args.length &&
        !args[i + 1].startsWith("-") &&
        !isKnownFlag(arg)
      ) {
        i++; // Skip the value
      }
      i++;
      continue;
    }

    // Found the subcommand
    result.subcommand = arg;
    i++;
    break;
  }

  // Process remaining args
  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith("-")) {
      // This is an option
      const optionKey = arg.split("=")[0]; // Handle --option=value

      if (GLOBAL_OPTIONS.has(optionKey)) {
        if (!result.globalOptions.includes(optionKey)) {
          result.globalOptions.push(optionKey);
        }
      } else {
        if (!result.optionKeys.includes(optionKey)) {
          result.optionKeys.push(optionKey);
        }
      }

      // Skip value if this option takes one (next arg doesn't start with -)
      if (
        i + 1 < args.length &&
        !args[i + 1].startsWith("-") &&
        !isKnownFlag(arg)
      ) {
        i++; // Skip the value
      }
    } else {
      // Positional argument - record as redacted
      result.args.push("<REDACTED>");
    }

    i++;
  }

  return result;
}

/**
 * Known boolean flags that don't take values.
 */
function isKnownFlag(option: string): boolean {
  const flags = new Set([
    "--debug-logs",
    "--json",
    "--stream",
    "-q",
    "--quiet",
    "-v",
    "--verbose",
    "--no-telemetry",
    "--force",
    "-f",
    "--help",
    "-h",
    "--version",
    "-V",
    "--dry-run",
    "--all",
    "-a",
    "--yes",
    "-y",
  ]);
  return flags.has(option);
}

/**
 * Checks if telemetry is disabled via command line args.
 * This is a pre-parse check before Cliffy parses the full args.
 */
export function isTelemetryDisabled(args: string[]): boolean {
  return args.includes("--no-telemetry");
}
