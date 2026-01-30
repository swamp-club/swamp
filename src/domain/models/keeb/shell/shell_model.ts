import { z } from "zod";
import { ModelType } from "../../model_type.ts";
import { ModelData } from "../../model_data.ts";
import { ModelLog } from "../../model_log.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
  type ModelDefinition,
} from "../../model.ts";
import type { ModelInput } from "../../model_input.ts";

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
  input: ModelInput,
  _context: MethodContext,
): Promise<MethodResult> {
  // Validate input attributes
  const attrs = ShellInputAttributesSchema.parse(input.attributes);

  const startTime = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    const commandOptions: Deno.CommandOptions = {
      args: ["-c", attrs.run],
      stdout: "piped",
      stderr: "piped",
    };

    if (attrs.workingDir) {
      commandOptions.cwd = attrs.workingDir;
    }

    if (attrs.env) {
      commandOptions.env = attrs.env;
    }

    const command = new Deno.Command("sh", commandOptions);

    let output: Deno.CommandOutput;

    if (attrs.timeout) {
      // Handle timeout with AbortSignal
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), attrs.timeout);

      try {
        const child = command.spawn();

        // Create a race between command completion and timeout
        const timeoutPromise = new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => {
            child.kill("SIGTERM");
            reject(new Error(`Command timed out after ${attrs.timeout}ms`));
          });
        });

        output = await Promise.race([child.output(), timeoutPromise]);
        clearTimeout(timeoutId);
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    } else {
      output = await command.output();
    }

    stdout = new TextDecoder().decode(output.stdout);
    stderr = new TextDecoder().decode(output.stderr);
    exitCode = output.code;
  } catch (error) {
    // Handle execution errors (command not found, timeout, etc.)
    stderr = error instanceof Error ? error.message : String(error);
    exitCode = -1;
  }

  const endTime = Date.now();
  const durationMs = endTime - startTime;

  // Create log artifact for command output
  const outputLog = ModelLog.create({ id: input.id });
  if (stdout) {
    outputLog.log(`[stdout]\n${stdout}`);
  }
  if (stderr) {
    outputLog.log(`[stderr]\n${stderr}`);
  }

  // Create the data artifact with structured metadata
  const data = ModelData.create({
    id: input.id,
    attributes: {
      exitCode,
      executedAt: new Date().toISOString(),
      command: attrs.run,
      durationMs,
    },
  });

  return { data, logs: [outputLog] };
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
  typeof ShellInputAttributesSchema,
  never,
  typeof ShellDataAttributesSchema
> = defineModel({
  type: SHELL_MODEL_TYPE,
  version: 1,
  inputAttributesSchema: ShellInputAttributesSchema,
  dataAttributesSchema: ShellDataAttributesSchema,
  methods: {
    execute: {
      description:
        "Execute the shell command and capture stdout, stderr, and exit code",
      inputAttributesSchema: ShellInputAttributesSchema,
      execute: executeCommand,
    },
  },
});
