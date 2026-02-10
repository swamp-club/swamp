import { z } from "zod";
import { ModelType } from "../../model_type.ts";
import {
  DataSpecType,
  defineModel,
  type MethodContext,
  type MethodResult,
  type ModelDefinition,
} from "../../model.ts";
import type { Definition } from "../../../definitions/definition.ts";
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
export const SHELL_MODEL_TYPE = ModelType.create("keeb/shell");

/**
 * Executes a shell command and captures the output.
 */
async function executeCommand(
  definition: Definition,
  context: MethodContext,
): Promise<MethodResult> {
  // Validate definition attributes
  const attrs = ShellInputAttributesSchema.parse(definition.attributes);

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let durationMs = 0;

  try {
    const result = await executeProcess({
      command: "sh",
      args: ["-c", attrs.run],
      cwd: attrs.workingDir,
      env: attrs.env,
      timeoutMs: attrs.timeout,
      logger: context.logger,
    });

    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = result.exitCode;
    durationMs = result.durationMs;
  } catch (error) {
    // Handle execution errors (command not found, timeout, etc.)
    stderr = error instanceof Error ? error.message : String(error);
    exitCode = -1;
  }

  // Create data attributes for the result
  const resultAttributes = {
    exitCode,
    executedAt: new Date().toISOString(),
    command: attrs.run,
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

  const resultWriter = context.createDataWriter!({
    name: `${definition.name}-result`,
    specType: "result",
  });

  const logWriter = context.createDataWriter!({
    name: `${definition.name}-output`,
    specType: "log",
  });

  const resultHandle = await resultWriter.writeText(
    JSON.stringify(resultAttributes),
  );
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
export const shellModel: ModelDefinition<
  typeof ShellInputAttributesSchema
> = defineModel({
  type: SHELL_MODEL_TYPE,
  version: "2026.02.09.1",
  inputAttributesSchema: ShellInputAttributesSchema,
  dataOutputSpecs: {
    "result": {
      specType: DataSpecType.create("result"),
      description:
        "Shell command execution result (exit code, timing, command)",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
    "log": {
      specType: DataSpecType.create("log"),
      description: "Shell command output (stdout and stderr)",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 10,
      streaming: true,
      tags: { type: "log" },
    },
  },
  methods: {
    execute: {
      description:
        "Execute the shell command and capture stdout, stderr, and exit code",
      inputAttributesSchema: ShellInputAttributesSchema,
      execute: executeCommand,
    },
  },
});
