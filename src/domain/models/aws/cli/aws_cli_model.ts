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

/**
 * Schema for AWS CLI model input attributes.
 */
export const AwsCliInputAttributesSchema = z.object({
  /** AWS CLI command to execute (without the 'aws' prefix), e.g., "ec2 describe-instances" */
  command: z.string().min(1),
  /** Override AWS_REGION environment variable */
  region: z.string().optional(),
  /** Override AWS_PROFILE environment variable */
  profile: z.string().optional(),
  /** Command timeout in milliseconds (default: 60000ms) */
  timeout: z.number().int().positive().default(60000),
  /** Parse stdout as JSON and store in 'json' attribute */
  parseJson: z.boolean().default(false),
});

/**
 * Type for AWS CLI model input attributes.
 */
export type AwsCliInputAttributes = z.infer<typeof AwsCliInputAttributesSchema>;

/**
 * Schema for AWS CLI model data attributes.
 */
export const AwsCliDataAttributesSchema = z.object({
  /** Raw stdout from the command */
  output: z.string(),
  /** Parsed JSON output (if parseJson was true and output was valid JSON) */
  json: z.unknown().optional(),
  /** Command exit code */
  exitCode: z.number(),
  /** ISO timestamp when command was executed */
  executedAt: z.string().datetime(),
  /** Duration of command execution in milliseconds */
  durationMs: z.number(),
});

/**
 * Type for AWS CLI model data attributes.
 */
export type AwsCliDataAttributes = z.infer<typeof AwsCliDataAttributesSchema>;

/**
 * The AWS CLI model type identifier.
 */
export const AWS_CLI_MODEL_TYPE = ModelType.create("aws/cli");

/**
 * Parse a command string into an array of arguments.
 * Handles quoted strings and escaped characters.
 */
function parseCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escapeNext = false;

  for (const char of command) {
    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }

    if (char === "\\") {
      escapeNext = true;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === " " && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

/**
 * Executes the "run" method for the AWS CLI model.
 *
 * Runs an AWS CLI command and captures the output as data attributes.
 */
async function executeRun(
  definition: Definition,
  context: MethodContext,
): Promise<MethodResult> {
  const attrs = AwsCliInputAttributesSchema.parse(definition.attributes);

  // Build environment with optional overrides
  const env: Record<string, string> = { ...Deno.env.toObject() };
  if (attrs.region) {
    env.AWS_REGION = attrs.region;
  }
  if (attrs.profile) {
    env.AWS_PROFILE = attrs.profile;
  }

  // Parse command into args, handling quoted strings
  const args = parseCommand(attrs.command);

  const startTime = Date.now();

  // Create abort controller for timeout
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), attrs.timeout);

  try {
    const command = new Deno.Command("aws", {
      args,
      stdout: "piped",
      stderr: "piped",
      env,
      signal: abortController.signal,
    });

    const result = await command.output();
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    const durationMs = Date.now() - startTime;

    if (!result.success) {
      throw new Error(
        `AWS CLI failed (exit ${result.code}): ${
          stderr.trim() || stdout.trim()
        }`,
      );
    }

    // Optionally parse JSON output
    let json: unknown = undefined;
    if (attrs.parseJson) {
      const trimmedOutput = stdout.trim();
      if (trimmedOutput.length > 0) {
        try {
          json = JSON.parse(trimmedOutput);
        } catch {
          // Leave as undefined if not valid JSON
        }
      }
    }

    const dataAttributes = {
      output: stdout.trim(),
      json,
      exitCode: result.code,
      executedAt: new Date().toISOString(),
      durationMs,
    };

    const writer = context.createDataWriter!({
      name: `${definition.name}-data`,
      specType: DataSpecType.create("data"),
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    });

    const handle = await writer.writeText(JSON.stringify(dataAttributes));

    return { dataHandles: [handle] };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * The AWS CLI model definition.
 *
 * A generic model that executes any AWS CLI command and captures
 * the output as data attributes that can be referenced via CEL expressions.
 *
 * This enables data chaining where one model's output can be used
 * as input to another model (e.g., looking up an AMI ID and using it
 * to create an EC2 instance).
 *
 * Self-registers with the global model registry when this module is imported.
 */
export const awsCliModel: ModelDefinition<
  typeof AwsCliInputAttributesSchema
> = defineModel({
  type: AWS_CLI_MODEL_TYPE,
  version: "2026.02.09.1",
  inputAttributesSchema: AwsCliInputAttributesSchema,
  dataOutputSpecs: {
    "data": {
      specType: DataSpecType.create("data"),
      description: "AWS CLI command output with execution metadata",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "data" },
    },
  },
  methods: {
    run: {
      description:
        "Run an AWS CLI command and capture output as data attributes",
      inputAttributesSchema: AwsCliInputAttributesSchema,
      execute: executeRun,
    },
  },
});

// Export parseCommand for testing
export { parseCommand };
