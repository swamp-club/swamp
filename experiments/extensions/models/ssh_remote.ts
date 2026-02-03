import { z } from "zod";
import { ModelType } from "../../../src/domain/models/model_type.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
  type ModelDefinition,
} from "../../../src/domain/models/model.ts";
import type { Definition } from "../../../src/domain/definitions/definition.ts";

/**
 * Schema for SSH remote model input attributes.
 */
export const SshRemoteInputAttributesSchema = z.object({
  host: z.string().min(1).describe("IP address or hostname of the remote host"),
  user: z.string().default("root").describe("SSH user (default: root)"),
  privateKeyPath: z.string().min(1).describe("Path to SSH private key"),
  command: z.string().min(1).describe("Command to execute on the remote host"),
  port: z.number().int().positive().default(22).describe(
    "SSH port (default: 22)",
  ),
  timeout: z.number().int().positive().optional().describe(
    "Timeout in milliseconds",
  ),
});

/**
 * Type for SSH remote model input attributes.
 */
export type SshRemoteInputAttributes = z.infer<
  typeof SshRemoteInputAttributesSchema
>;

/**
 * The SSH remote model type identifier.
 */
export const SSH_REMOTE_MODEL_TYPE = ModelType.create("keeb/ssh-remote");

/**
 * Expands ~ to home directory in paths.
 */
function expandHomePath(path: string): string {
  if (path.startsWith("~/")) {
    const home = Deno.env.get("HOME");
    if (home) {
      return path.replace("~", home);
    }
  }
  return path;
}

/**
 * Executes a command on a remote host via SSH.
 */
async function executeCommand(
  definition: Definition,
  _context: MethodContext,
): Promise<MethodResult> {
  const attrs = SshRemoteInputAttributesSchema.parse(definition.attributes);

  const startTime = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    const privateKeyPath = expandHomePath(attrs.privateKeyPath);

    const sshArgs = [
      "-i",
      privateKeyPath,
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "BatchMode=yes",
      "-p",
      attrs.port.toString(),
      `${attrs.user}@${attrs.host}`,
      attrs.command,
    ];

    const commandOptions: Deno.CommandOptions = {
      args: sshArgs,
      stdout: "piped",
      stderr: "piped",
    };

    const command = new Deno.Command("ssh", commandOptions);

    let output: Deno.CommandOutput;

    if (attrs.timeout) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), attrs.timeout);

      try {
        const child = command.spawn();

        const timeoutPromise = new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => {
            child.kill("SIGTERM");
            reject(new Error(`SSH command timed out after ${attrs.timeout}ms`));
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
    stderr = error instanceof Error ? error.message : String(error);
    exitCode = -1;
  }

  const endTime = Date.now();
  const durationMs = endTime - startTime;

  const definitionHash = await definition.computeHash();

  // Create the data artifact with structured metadata
  const dataAttributes = {
    exitCode,
    stdout,
    stderr,
    executedAt: new Date().toISOString(),
    durationMs,
  };

  // Create log output content
  const logParts: string[] = [];
  logParts.push(`[ssh ${attrs.user}@${attrs.host}:${attrs.port}]`);
  logParts.push(`[command] ${attrs.command}`);
  if (stdout) {
    logParts.push(`[stdout]\n${stdout}`);
  }
  if (stderr) {
    logParts.push(`[stderr]\n${stderr}`);
  }
  const logContent = logParts.join("\n");

  return {
    dataOutputs: [
      {
        name: `${definition.name}-result`,
        content: new TextEncoder().encode(JSON.stringify(dataAttributes)),
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
        content: new TextEncoder().encode(logContent),
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
 * The SSH remote model definition.
 *
 * A model that executes commands on remote hosts via SSH and captures
 * the output (stdout, stderr, exit code).
 *
 * Self-registers with the global model registry when this module is imported.
 */
export const sshRemoteModel: ModelDefinition<
  typeof SshRemoteInputAttributesSchema
> = defineModel({
  type: SSH_REMOTE_MODEL_TYPE,
  version: 1,
  inputAttributesSchema: SshRemoteInputAttributesSchema,
  methods: {
    execute: {
      description:
        "Execute a command on a remote host via SSH and capture stdout, stderr, and exit code",
      inputAttributesSchema: SshRemoteInputAttributesSchema,
      execute: executeCommand,
    },
  },
});
