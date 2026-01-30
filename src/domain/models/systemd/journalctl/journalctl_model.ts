import { z } from "zod";
import { ModelType } from "../../model_type.ts";
import { ModelLog } from "../../model_log.ts";
import {
  defineModel,
  type MethodContext,
  type MethodResult,
  type ModelDefinition,
} from "../../model.ts";
import type { ModelInput } from "../../model_input.ts";

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
 * Uses streaming to handle arbitrarily large outputs without buffer overflow.
 */
async function readLogs(
  input: ModelInput,
  _context: MethodContext,
): Promise<MethodResult> {
  // Validate input attributes
  const attrs = JournalctlInputAttributesSchema.parse(input.attributes);

  const args = buildJournalctlArgs(attrs);

  const log = ModelLog.create({});

  const command = new Deno.Command("journalctl", {
    args,
    stdout: "piped",
    stderr: "piped",
  });

  const child = command.spawn();
  const decoder = new TextDecoder();
  let buffer = "";

  // Stream stdout using ReadableStream API
  const reader = child.stdout.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          log.log(line);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Handle remaining buffer (final line without trailing newline)
  if (buffer.length > 0) {
    log.log(buffer);
  }

  const status = await child.status;
  if (!status.success) {
    // Read stderr for error message
    const stderrReader = child.stderr.getReader();
    const stderrChunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        stderrChunks.push(value);
      }
    } finally {
      stderrReader.releaseLock();
    }
    const stderrDecoder = new TextDecoder();
    const stderr = stderrChunks.map((c) => stderrDecoder.decode(c)).join("");
    throw new Error(`journalctl failed: ${stderr}`);
  }

  return { logs: [log] };
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
export const journalctlModel: ModelDefinition<
  typeof JournalctlInputAttributesSchema,
  typeof JournalctlResourceAttributesSchema
> = defineModel({
  type: JOURNALCTL_MODEL_TYPE,
  version: 1,
  inputAttributesSchema: JournalctlInputAttributesSchema,
  resourceAttributesSchema: JournalctlResourceAttributesSchema,
  methods: {
    read: {
      description:
        "Read system logs via journalctl with optional filters. Returns logs only, no resources.",
      inputAttributesSchema: JournalctlInputAttributesSchema,
      execute: readLogs,
    },
  },
});
