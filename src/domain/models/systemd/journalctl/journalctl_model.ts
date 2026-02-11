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
 * Schema for journalctl model input attributes.
 * All fields are optional filters for the journalctl command.
 */
export const JournalctlInputAttributesSchema = z.object({
  unit: z.string().optional().describe(
    "Filter by systemd unit (e.g., nginx.service)",
  ),
  since: z.string().optional().describe(
    "Show logs since time (e.g., '1 hour ago', '2024-01-01')",
  ),
  until: z.string().optional().describe("Show logs until time"),
  lines: z.number().int().positive().optional().describe(
    "Number of lines to return",
  ),
  priority: z.string().optional().describe(
    "Filter by priority (0-7 or names: emerg, alert, crit, err, warning, notice, info, debug)",
  ),
  boot: z.number().int().optional().describe(
    "Boot ID (0=current, -1=previous, etc.)",
  ),
  grep: z.string().optional().describe("Filter by pattern"),
  identifier: z.string().optional().describe("Filter by syslog identifier"),
});

/**
 * Type for journalctl model input attributes.
 */
export type JournalctlInputAttributes = z.infer<
  typeof JournalctlInputAttributesSchema
>;

/**
 * Schema for journalctl model resource attributes.
 * Empty because this model returns only logs, no resources.
 */
export const JournalctlResourceAttributesSchema = z.object({});

/**
 * Type for journalctl model resource attributes.
 */
export type JournalctlResourceAttributes = z.infer<
  typeof JournalctlResourceAttributesSchema
>;

/**
 * The journalctl model type identifier.
 */
export const JOURNALCTL_MODEL_TYPE = ModelType.create("systemd/journalctl");

/**
 * Builds the journalctl command arguments from input attributes.
 */
export function buildJournalctlArgs(
  attrs: JournalctlInputAttributes,
): string[] {
  const args: string[] = [];

  if (attrs.unit) {
    args.push(`--unit=${attrs.unit}`);
  }
  if (attrs.since) {
    args.push(`--since=${attrs.since}`);
  }
  if (attrs.until) {
    args.push(`--until=${attrs.until}`);
  }
  if (attrs.lines !== undefined) {
    args.push(`--lines=${attrs.lines}`);
  }
  if (attrs.priority) {
    args.push(`--priority=${attrs.priority}`);
  }
  if (attrs.boot !== undefined) {
    args.push(`--boot=${attrs.boot}`);
  }
  if (attrs.grep) {
    args.push(`--grep=${attrs.grep}`);
  }
  if (attrs.identifier) {
    args.push(`--identifier=${attrs.identifier}`);
  }

  // Always use plain text output (no pager)
  args.push("--no-pager");

  return args;
}

/**
 * Reads system logs via journalctl and returns them as log entries.
 */
async function readLogs(
  args: JournalctlInputAttributes,
  context: MethodContext,
): Promise<MethodResult> {
  const journalctlArgs = buildJournalctlArgs(args);

  const result = await executeProcess({
    command: "journalctl",
    args: journalctlArgs,
    logger: context.logger,
  });

  if (!result.success) {
    throw new Error(`journalctl failed: ${result.stderr}`);
  }

  const logLines = result.stdout.split("\n").filter((line) => line.length > 0);

  const writer = context.createFileWriter!("log", "log");

  const handle = await writer.writeText(logLines.join("\n"));

  return { dataHandles: [handle] };
}

/**
 * The journalctl model definition.
 *
 * A model that reads system logs via the journalctl command and returns
 * them as log artifacts. Supports various filters like unit, time range,
 * priority, and pattern matching.
 *
 * Self-registers with the global model registry when this module is imported.
 */
export const journalctlModel: ModelDefinition = defineModel({
  type: JOURNALCTL_MODEL_TYPE,
  version: "2026.02.09.1",
  globalArguments: JournalctlInputAttributesSchema,
  files: {
    "log": {
      description: "System journal logs",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 10,
      streaming: true,
    },
  },
  methods: {
    read: {
      description:
        "Read system logs via journalctl with optional filters. Returns logs only.",
      arguments: JournalctlInputAttributesSchema,
      execute: readLogs,
    },
  },
});
