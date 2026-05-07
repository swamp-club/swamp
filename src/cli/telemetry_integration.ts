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

import type {
  CommandInvocationData,
  InvocationContextData,
} from "../domain/telemetry/mod.ts";
import {
  detectAgentHarness,
  RELEVANT_ENV_VARS,
} from "../domain/telemetry/mod.ts";
import type { AiTool } from "../infrastructure/persistence/repo_marker_repository.ts";

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
  "-q",
  "--quiet",
  "-v",
  "--verbose",
  "--no-telemetry",
  "--no-color",
  "--show-properties",
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
    "-q",
    "--quiet",
    "-v",
    "--verbose",
    "--no-telemetry",
    "--no-color",
    "--show-properties",
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
    "--check",
    "--verify",
    "--prune",
    "--streaming",
    "--last-evaluated",
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

/**
 * Project the live process env down to the whitelist the harness detector
 * needs. The full env contains secrets (AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN,
 * vault tokens) — projecting through the whitelist keeps every other key out
 * of the telemetry pipeline regardless of what future code does with the
 * snapshot.
 */
export function projectEnvSnapshot(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const key of RELEVANT_ENV_VARS) {
    const value = Deno.env.get(key);
    if (value !== undefined) {
      snapshot[key] = value;
    }
  }
  return snapshot;
}

/**
 * Build the InvocationContext for one CLI invocation. Composes the harness
 * detector over the env snapshot, captures stdin tty state, and pulls the
 * configured tool list from the repo marker.
 *
 * `configuredAiTools` is undefined when no marker is available (telemetry
 * recorded outside a swamp repo — forward-compat reserve) and `[]` when the
 * marker has explicitly opted out via legacy `tool: none`. The two states
 * carry different meaning downstream and must round-trip distinctly.
 */
export function buildInvocationContext(
  envSnapshot: Record<string, string>,
  configuredAiTools: AiTool[] | undefined,
): InvocationContextData {
  const detection = detectAgentHarness(envSnapshot);
  const data: InvocationContextData = {
    agentSessionDetected: detection.agentSessionDetected,
    isInteractive: Deno.stdin.isTerminal(),
  };
  if (configuredAiTools !== undefined) {
    data.configuredAiTools = configuredAiTools;
  }
  if (detection.detectedAiTool !== undefined) {
    data.detectedAiTool = detection.detectedAiTool;
  }
  return data;
}
