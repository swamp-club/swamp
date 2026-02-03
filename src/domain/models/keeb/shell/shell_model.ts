import { z } from "zod";
import { ModelType } from "../../model_type.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
  type ModelDefinition,
} from "../../model.ts";
import type { Definition } from "../../../definitions/definition.ts";

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
 * Streams output from a readable stream, calling onLine for each line.
 * Returns the complete output as a string.
 */
async function streamOutput(
  stream: ReadableStream<Uint8Array>,
  onLine?: (line: string) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const bufferLines = buffer.split("\n");

      // Process all complete lines
      for (let i = 0; i < bufferLines.length - 1; i++) {
        lines.push(bufferLines[i]);
        if (onLine) {
          onLine(bufferLines[i]);
        }
      }

      // Keep the incomplete line in the buffer
      buffer = bufferLines[bufferLines.length - 1];
    }

    // Process any remaining content
    if (buffer) {
      lines.push(buffer);
      if (onLine) {
        onLine(buffer);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return lines.join("\n");
}

/**
 * Executes a shell command and captures the output.
 */
async function executeCommand(
  definition: Definition,
  context: MethodContext,
): Promise<MethodResult> {
  // Validate definition attributes
  const attrs = ShellInputAttributesSchema.parse(definition.attributes);

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

    // Use streaming if callbacks are provided
    if (context.streaming?.onStdout || context.streaming?.onStderr) {
      const process = command.spawn();

      // Stream stdout and stderr concurrently
      const [stdoutResult, stderrResult, status] = await Promise.all([
        streamOutput(process.stdout, context.streaming?.onStdout),
        streamOutput(process.stderr, context.streaming?.onStderr),
        process.status,
      ]);

      stdout = stdoutResult;
      stderr = stderrResult;
      exitCode = status.code;
    } else if (attrs.timeout) {
      // Handle timeout with AbortSignal (non-streaming)
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

        const output = await Promise.race([child.output(), timeoutPromise]);
        clearTimeout(timeoutId);

        stdout = new TextDecoder().decode(output.stdout);
        stderr = new TextDecoder().decode(output.stderr);
        exitCode = output.code;
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    } else {
      // Buffered execution (original behavior)
      const output = await command.output();
      stdout = new TextDecoder().decode(output.stdout);
      stderr = new TextDecoder().decode(output.stderr);
      exitCode = output.code;
    }
  } catch (error) {
    // Handle execution errors (command not found, timeout, etc.)
    stderr = error instanceof Error ? error.message : String(error);
    exitCode = -1;
  }

  const endTime = Date.now();
  const durationMs = endTime - startTime;

  const definitionHash = await definition.computeHash();

  // Create data attributes for the result
  const resultAttributes = {
    exitCode,
    executedAt: new Date().toISOString(),
    command: attrs.run,
    durationMs,
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

  return {
    dataOutputs: [
      {
        name: `${definition.name}-result`,
        content: new TextEncoder().encode(JSON.stringify(resultAttributes)),
        metadata: {
          contentType: "application/json",
          lifetime: "infinite",
          garbageCollection: 10,
          streaming: false,
          tags: { type: "data" },
          ownerDefinition: {
            definitionHash,
            ownerType: "model-method",
            ownerRef: "execute",
          },
        },
      },
      {
        name: `${definition.name}-output`,
        content: new TextEncoder().encode(outputLogContent),
        metadata: {
          contentType: "text/plain",
          lifetime: "infinite",
          garbageCollection: 10,
          streaming: true,
          tags: { type: "log" },
          ownerDefinition: {
            definitionHash,
            ownerType: "model-method",
            ownerRef: "execute",
          },
        },
      },
    ],
  };
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
  version: 1,
  inputAttributesSchema: ShellInputAttributesSchema,
  methods: {
    execute: {
      description:
        "Execute the shell command and capture stdout, stderr, and exit code",
      inputAttributesSchema: ShellInputAttributesSchema,
      execute: executeCommand,
    },
  },
});
