import type { CommandInvocationData } from "../domain/telemetry/mod.ts";

/**
 * Per-position sensitivity for positional arguments by command.
 * "categorical" = system-defined value, safe to record (e.g., model type, method name).
 * "redact" = user-identifiable value, must be redacted (e.g., name, path, query).
 * Commands not listed here default to all-redact. Positions beyond the schema length
 * also default to "redact".
 */
const ARG_SCHEMAS: Record<string, readonly ("categorical" | "redact")[]> = {
  "model create": ["categorical", "redact"], // type, name
  "model method": ["categorical", "redact", "categorical"], // "run", name, method
  "model output": ["categorical", "redact"], // sub-subcmd, id/query
  "vault create": ["categorical", "redact"], // type, name
  "type describe": ["categorical"], // type
  "workflow history": ["categorical", "redact"], // sub-subcmd, name
};

/** Global options that are tracked separately */
const GLOBAL_OPTIONS = new Set([
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
  const schemaKey = result.subcommand
    ? `${result.command} ${result.subcommand}`
    : result.command;
  const argSchema = ARG_SCHEMAS[schemaKey];
  let positionalIndex = 0;

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
      // Positional argument - record categorical values, redact user-identifiable ones
      const sensitivity = argSchema?.[positionalIndex] ?? "redact";
      result.args.push(sensitivity === "categorical" ? arg : "<REDACTED>");
      positionalIndex++;
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
