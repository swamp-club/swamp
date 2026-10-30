// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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

/**
 * The agent session record: what one coding-agent session did in a swamp
 * repo, as the agent-sessions extension writes it and the dashboard reads it
 * (swamp-club#4154). It is a read model built per session, not the
 * observation event stream. Prompts, replies and other transcript content
 * are never part of it: every object is strict, so a record carrying any
 * field this schema does not name is refused.
 *
 * Kept free of Deno and Node APIs so the dashboard can bundle it or mirror
 * it. See design/surfaces/agent-sessions.md.
 */

import { z } from "zod";

/** The record version this swamp writes and reads. */
export const AGENT_SESSION_SCHEMA_VERSION = 1;

/** Every version this swamp reads; older versions are skipped as `older`. */
export const SUPPORTED_AGENT_SESSION_SCHEMA_VERSIONS: readonly number[] = [1];

/** Value of the `type` tag that marks a data item as an agent session. */
export const AGENT_SESSION_TYPE_TAG = "agent-session";

/** Tag key that carries the session's swamp-club user id. */
export const AGENT_SESSION_USER_ID_TAG = "swampUserId";

/** The predicate that lists agent sessions through `data.query`. */
export const AGENT_SESSION_QUERY_PREDICATE =
  `tags.type == "${AGENT_SESSION_TYPE_TAG}"`;

/** Size bounds; a longest real session (169 calls, 17 turns) fits well inside. */
export const AGENT_SESSION_LIMITS = {
  idLength: 200,
  nameLength: 200,
  textLength: 1000,
  labelTextLength: 200,
  findingTitleLength: 200,
  findingDetailLength: 2000,
  turns: 5000,
  callsPerTurn: 2000,
  spanRootsPerCall: 20,
  spansPerRoot: 500,
  findings: 500,
  callIdsPerFinding: 2000,
} as const;

const L = AGENT_SESSION_LIMITS;

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const SessionIdSchema = z.string().max(L.idLength).regex(SESSION_ID);
const MillisSchema = z.number().nonnegative();
const TokenCountSchema = z.number().int().nonnegative();

/** Canonical tool kinds; a harness tool name with no mapping is `unknown`. */
export const ToolKindSchema = z.enum([
  "shell",
  "file-read",
  "file-edit",
  "file-write",
  "search",
  "web",
  "mcp",
  "subagent",
  "skill",
  "other",
  "unknown",
]);

/** Whether a tool call used swamp, went around it, or neither. */
export const CallLabelSchema = z.enum(["swamp", "bypass", "neutral"]);

export const FindingSeveritySchema = z.enum(["high", "medium", "low"]);

export const TokenUsageSchema = z.strictObject({
  input: TokenCountSchema,
  output: TokenCountSchema,
  cacheRead: TokenCountSchema,
  cacheWrite: TokenCountSchema,
});

/** One span of a swamp command, timed from its root's start. */
export const SwampSpanSchema = z.strictObject({
  name: z.string().min(1).max(L.nameLength),
  start: MillisSchema,
  duration: MillisSchema,
  depth: z.number().int().nonnegative(),
  error: z.boolean(),
});

/** One swamp command run by a tool call, `offset` ms after the call started. */
export const SwampSpanRootSchema = z.strictObject({
  offset: MillisSchema,
  spans: z.array(SwampSpanSchema).min(1).max(L.spansPerRoot),
});

/**
 * One tool call. `text` holds only the redacted target of the call (a
 * command line, a path, a skill name or a URL), never text the model wrote.
 * Times are ms from the session's start.
 */
export const ToolCallSchema = z.strictObject({
  id: z.string().min(1).max(L.idLength),
  tool: z.string().min(1).max(L.nameLength),
  toolKind: ToolKindSchema,
  start: MillisSchema,
  end: MillisSchema,
  ok: z.boolean(),
  exitCode: z.number().int().optional(),
  text: z.string().max(L.textLength),
  label: CallLabelSchema,
  category: z.string().min(1).max(L.labelTextLength),
  rule: z.string().min(1).max(L.labelTextLength),
  swampSpans: z.array(SwampSpanRootSchema).max(L.spanRootsPerCall).optional(),
});

/** One model response and the tool calls it made; times are ms from the session's start. */
export const TurnSchema = z.strictObject({
  n: z.number().int().positive(),
  start: MillisSchema,
  end: MillisSchema,
  tokens: TokenUsageSchema,
  calls: z.array(ToolCallSchema).max(L.callsPerTurn),
});

/** A pattern worth tuning, pointing at the calls it was found in. */
export const FindingSchema = z.strictObject({
  severity: FindingSeveritySchema,
  title: z.string().min(1).max(L.findingTitleLength),
  detail: z.string().max(L.findingDetailLength),
  tune: z.string().max(L.findingDetailLength),
  callIds: z.array(z.string().min(1).max(L.idLength)).max(L.callIdsPerFinding),
});

/**
 * Version 1 of the agent session record. `swampUserId` is the stable
 * swamp-club user id (serve's OAuth `sub`) and the only identity meant for
 * access decisions; `swampUsername` is a display label that a rename can
 * make stale. Both are self-reported by the writer.
 */
export const AgentSessionRecordV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  id: SessionIdSchema,
  repo: z.string().min(1).max(L.nameLength),
  harness: z.string().max(64).regex(SLUG),
  harnessVersion: z.string().min(1).max(L.nameLength).optional(),
  model: z.string().min(1).max(L.nameLength),
  startedAt: z.iso.datetime(),
  swampUserId: z.string().min(1).max(L.idLength).optional(),
  swampUsername: z.string().min(1).max(L.nameLength).optional(),
  parentSessionId: SessionIdSchema.optional(),
  importerVersion: z.string().min(1).max(L.nameLength),
  turns: z.array(TurnSchema).max(L.turns),
  findings: z.array(FindingSchema).max(L.findings),
}).superRefine((record, ctx) => {
  const ids = new Set<string>();
  record.turns.forEach((turn, t) =>
    turn.calls.forEach((call, c) => {
      if (ids.has(call.id)) {
        ctx.addIssue({
          code: "custom",
          message: "duplicate call id",
          path: ["turns", t, "calls", c, "id"],
        });
      }
      ids.add(call.id);
    })
  );
  record.findings.forEach((finding, f) =>
    finding.callIds.forEach((id, i) => {
      if (!ids.has(id)) {
        ctx.addIssue({
          code: "custom",
          message: "finding points at a call the session does not have",
          path: ["findings", f, "callIds", i],
        });
      }
    })
  );
});

export type AgentSessionRecord = z.infer<typeof AgentSessionRecordV1Schema>;
export type AgentSessionTurn = z.infer<typeof TurnSchema>;
export type AgentSessionToolCall = z.infer<typeof ToolCallSchema>;
export type AgentSessionFinding = z.infer<typeof FindingSchema>;

/** Why a stored session was not read. */
export type AgentSessionSkipReason = "newer" | "older" | "invalid";

/** The outcome of reading one stored session. */
export type AgentSessionReading =
  | { readonly kind: "record"; readonly record: AgentSessionRecord }
  | {
    readonly kind: "skipped";
    readonly reason: AgentSessionSkipReason;
    readonly schemaVersion?: number;
    readonly note: string;
  };

/**
 * Reads one stored session's content. Never throws: a session this swamp
 * cannot read comes back as `skipped` with a note for the viewer, so one bad
 * record never fails a page. A note never repeats a value from the content,
 * only field paths.
 */
export function readAgentSessionRecord(content: unknown): AgentSessionReading {
  const version = typeof content === "object" && content !== null &&
      !Array.isArray(content)
    ? (content as Record<string, unknown>).schemaVersion
    : undefined;
  if (
    typeof version !== "number" || !Number.isInteger(version) || version < 1
  ) {
    return skipped("invalid", undefined, "no schemaVersion");
  }
  const newest = AGENT_SESSION_SCHEMA_VERSION;
  if (version > newest) {
    return skipped(
      "newer",
      version,
      `written as version ${version}; this swamp reads up to version ${newest}. Upgrade swamp to read it.`,
    );
  }
  if (!SUPPORTED_AGENT_SESSION_SCHEMA_VERSIONS.includes(version)) {
    return skipped(
      "older",
      version,
      `written as version ${version}, which this swamp no longer reads. Re-import the session.`,
    );
  }
  const parsed = AgentSessionRecordV1Schema.safeParse(content);
  if (parsed.success) return { kind: "record", record: parsed.data };
  const first = parsed.error.issues[0];
  const where = first && first.path.length > 0
    ? first.path.map(String).join(".")
    : "the record";
  return skipped(
    "invalid",
    version,
    `does not match version ${version}: ${
      first?.code ?? "invalid"
    } at ${where}`,
  );
}

function skipped(
  reason: AgentSessionSkipReason,
  schemaVersion: number | undefined,
  note: string,
): AgentSessionReading {
  return schemaVersion === undefined
    ? { kind: "skipped", reason, note }
    : { kind: "skipped", reason, schemaVersion, note };
}

/** The data name a session is stored under: one item per harness session. */
export function agentSessionDataName(
  harness: string,
  sessionId: string,
): string {
  return `agent-session-${harness}-${sessionId}`;
}

/** The JSON Schema of the current version, for extension authors. */
export function agentSessionRecordJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(AgentSessionRecordV1Schema, {
    unrepresentable: "any",
  }) as Record<string, unknown>;
}
