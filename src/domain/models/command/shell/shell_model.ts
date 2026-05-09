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

import { z } from "zod";
import { ModelType } from "../../model_type.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
  type ModelDefinition,
} from "../../model.ts";
import { executeProcess } from "../../../../infrastructure/process/process_executor.ts";
import { selectShellStrategy } from "./shell_strategy.ts";

const shellStrategy = selectShellStrategy();

/**
 * Schema for shell model input attributes.
 */
export const ShellInputAttributesSchema = z.object({
  run: z.string().min(1).describe("The shell command to execute"),
  workingDir: z.string().optional().describe(
    "Working directory for command execution",
  ),
  timeout: z.number().int().positive().optional().describe(
    "Timeout in milliseconds",
  ),
  env: z.record(z.string(), z.string()).optional().describe(
    "Environment variables",
  ),
  ignoreExitCode: z.boolean().optional().describe(
    "If true, non-zero exit codes will not cause the method to throw",
  ),
});

/**
 * Type for shell model input attributes.
 */
export type ShellInputAttributes = z.infer<typeof ShellInputAttributesSchema>;

/**
 * Schema for shell model data attributes.
 * Note: stdout/stderr are now stored in log artifacts, but kept here for
 * backward compatibility with existing outputs and for structured access.
 */
export const ShellDataAttributesSchema = z.object({
  exitCode: z.number().int().describe("Exit code of the command"),
  executedAt: z.string().datetime().describe(
    "Timestamp when execution completed",
  ),
  command: z.string().describe("The command that was executed"),
  durationMs: z.number().int().nonnegative().optional().describe(
    "Execution duration in milliseconds",
  ),
  stdout: z.string().optional().describe("Standard output from the command"),
  stderr: z.string().optional().describe("Standard error from the command"),
});

/**
 * Type for shell model data attributes.
 */
export type ShellDataAttributes = z.infer<typeof ShellDataAttributesSchema>;

/**
 * The shell model type identifier.
 */
export const SHELL_MODEL_TYPE = ModelType.create("command/shell");

/**
 * Executes a shell command and captures the output.
 */
async function executeCommand(
  args: ShellInputAttributes,
  context: MethodContext,
): Promise<MethodResult> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let durationMs = 0;

  const redact = (text: string) =>
    context.redactor?.hasSecrets ? context.redactor.redact(text) : text;

  try {
    // Resolve vault secrets via environment variables to prevent shell injection.
    // The unresolved run field contains sentinel tokens for vault secrets.
    // The strategy replaces sentinels with shell-appropriate env var references
    // (`${VAR}` on POSIX, `$env:VAR` on PowerShell) and returns the raw secret
    // values to inject via the process environment, so the shell never parses
    // secret content as syntax.
    let shellCommand = args.run;
    let shellEnv = args.env ?? {};
    const secretBag = context.vaultSecrets;
    if (secretBag && !secretBag.isEmpty && context.unresolvedMethodArgs) {
      const unresolvedRun = context.unresolvedMethodArgs.run;
      if (typeof unresolvedRun === "string") {
        const resolved = shellStrategy.resolveSecrets(unresolvedRun, secretBag);
        shellCommand = resolved.command;
        shellEnv = { ...shellEnv, ...resolved.env };
      }
    }

    // When explicit env vars are present, Deno.Command replaces the entire
    // inherited environment. Propagate the lock-holder PID so nested swamp
    // commands can skip the parent's per-model locks (prevents deadlock).
    // Only inject when shellEnv already has entries — when it's empty, env
    // is passed as undefined and the child inherits the full parent env
    // (including SWAMP_LOCK_HOLDER_PID) naturally.
    const lockHolderPid = Deno.env.get("SWAMP_LOCK_HOLDER_PID");
    if (lockHolderPid && Object.keys(shellEnv).length > 0) {
      shellEnv = { ...shellEnv, SWAMP_LOCK_HOLDER_PID: lockHolderPid };
    }

    const invocation = shellStrategy.buildInvocation(shellCommand);
    const result = await executeProcess({
      command: invocation.command,
      args: invocation.args,
      cwd: args.workingDir,
      env: Object.keys(shellEnv).length > 0 ? shellEnv : undefined,
      timeoutMs: args.timeout,
      logger: context.logger,
      redactor: context.redactor,
      onOutput: context.onEvent
        ? (line: string, stream: "stdout" | "stderr") =>
          context.onEvent!({ type: "output", line, stream })
        : undefined,
    });

    stdout = redact(result.stdout);
    stderr = redact(result.stderr);
    exitCode = result.exitCode;
    durationMs = result.durationMs;
  } catch (error) {
    // Handle execution errors (command not found, timeout, etc.)
    const rawError = error instanceof Error ? error.message : String(error);
    stderr = redact(rawError);
    exitCode = -1;
  }

  if (exitCode !== 0 && !args.ignoreExitCode) {
    throw new Error(`Command exited with code ${exitCode}`);
  }

  // Only persist data for successful executions
  const resultAttributes = {
    exitCode,
    executedAt: new Date().toISOString(),
    command: redact(args.run),
    durationMs,
    stdout,
    stderr,
  };

  // Create output log content
  const outputLogParts: string[] = [];
  if (stdout) {
    outputLogParts.push(`[stdout]\n${stdout}`);
  }
  if (stderr) {
    outputLogParts.push(`[stderr]\n${stderr}`);
  }
  const outputLogContent = outputLogParts.join("\n");

  const resultHandle = await context.writeResource!(
    "result",
    "result",
    resultAttributes,
  );

  const logWriter = context.createFileWriter!("log", "log");
  const logHandle = await logWriter.writeText(outputLogContent);

  return { dataHandles: [resultHandle, logHandle] };
}

/**
 * The shell model definition.
 *
 * A model that executes shell commands on the host system and captures
 * the output (stdout, stderr, exit code).
 *
 * Self-registers with the global model registry when this module is imported.
 */
export const shellModel: ModelDefinition = defineModel({
  type: SHELL_MODEL_TYPE,
  version: "2026.02.09.1",
  resources: {
    "result": {
      description:
        "Shell command execution result (exit code, timing, command)",
      schema: ShellDataAttributesSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  files: {
    "log": {
      description: "Shell command output (stdout and stderr)",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 10,
      streaming: true,
    },
  },
  methods: {
    execute: {
      description:
        "Execute the shell command and capture stdout, stderr, and exit code",
      arguments: ShellInputAttributesSchema,
      execute: executeCommand,
    },
  },
});
