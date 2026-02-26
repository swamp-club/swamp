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
    const result = await executeProcess({
      command: "sh",
      args: ["-c", args.run],
      cwd: args.workingDir,
      env: args.env,
      timeoutMs: args.timeout,
      logger: context.logger,
      redactor: context.redactor,
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

  // Create data attributes for the result
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
