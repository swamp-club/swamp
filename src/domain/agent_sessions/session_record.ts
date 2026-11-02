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
 * a read model built per session, never transcript content: every object is
 * strict, so a record with a field this schema does not name is refused. Kept
 * free of Deno and Node APIs so the dashboard can bundle it
 */

import { z } from "zod";

export const AGENT_SESSION_SCHEMA_VERSION = 2;

export const SUPPORTED_AGENT_SESSION_SCHEMA_VERSIONS: readonly number[] = [2];

export const AGENT_SESSION_TYPE_TAG = "agent-session";

export const AGENT_SESSION_USER_ID_TAG = "swampUserId";

export const AGENT_SESSION_STARTED_AT_TAG = "startedAt";

export const AGENT_SESSION_PARENT_TAG = "parentSessionId";

export const AGENT_SESSION_HEADLESS_TAG = "headless";

export const AGENT_SESSION_SUMMARY_TAG = "summary";

export const AGENT_SESSION_REPO_TAG = "repo";

export const AGENT_SESSION_QUERY_PREDICATE =
  `tags.type == "${AGENT_SESSION_TYPE_TAG}"`;

/**
 * reads only name, behavior name and tags, so with a tag predicate the query
 * never loads a record body; without a select it loads every match's body
 */
export const AGENT_SESSION_LIST_SELECT =
  `{"name": name, "modelName": modelName, "tags": tags}`;

export const AGENT_SESSION_TOP_LEVEL_PREDICATE =
  `${AGENT_SESSION_QUERY_PREDICATE} && !has(tags.${AGENT_SESSION_PARENT_TAG})`;

export const AGENT_SESSION_LIMITS = {
  // harness and session id form a data name stored as a directory name: at most
  // 175 characters, under every OS limit
  harnessLength: 32,
  sessionIdLength: 128,
  idLength: 200,
  nameLength: 200,
  textLength: 1000,
  labelTextLength: 200,
  findingTitleLength: 200,
  findingDetailLength: 2000,
  turns: 5000,
  callsPerTurn: 2000,
  callsPerSession: 20000,
  spanRootsPerCall: 20,
  spansPerRoot: 500,
  findings: 500,
  callIdsPerFinding: 2000,
  // a summary's strings are bounded, so its JSON stays under this even when
  // every character needs escaping
  summaryTagLength: 4096,
} as const;

const L = AGENT_SESSION_LIMITS;

// a harness slug has no _, so the _ in a data name always ends it; both are
// lowercase so names never meet on a case-insensitive filesystem
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const SESSION_ID = /^[a-z0-9][a-z0-9_-]*$/;

const HarnessSchema = z.string().max(L.harnessLength).regex(SLUG);
const SessionIdSchema = z.string().max(L.sessionIdLength).regex(SESSION_ID);
const AgentIdSchema = z.string().min(1).max(L.idLength);
const MillisSchema = z.number().nonnegative();
const TokenCountSchema = z.number().int().nonnegative();

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

/** unlabeled is a call the importer wrote before any classifier labelled it */
export const CallLabelSchema = z.enum([
  "swamp",
  "bypass",
  "neutral",
  "unlabeled",
]);

export const FindingSeveritySchema = z.enum(["high", "medium", "low", "info"]);

/**
 * a child session copies its parent's value; unknown is for a harness that
 * cannot tell
 */
export const InvocationSchema = z.enum(["interactive", "headless", "unknown"]);

export const TokenUsageSchema = z.strictObject({
  input: TokenCountSchema,
  output: TokenCountSchema,
  cacheRead: TokenCountSchema,
  cacheWrite: TokenCountSchema,
});

export const SwampSpanSchema = z.strictObject({
  name: z.string().min(1).max(L.nameLength),
  start: MillisSchema,
  duration: MillisSchema,
  depth: z.number().int().nonnegative(),
  error: z.boolean(),
});

export const SwampSpanRootSchema = z.strictObject({
  offset: MillisSchema,
  spans: z.array(SwampSpanSchema).min(1).max(L.spansPerRoot),
});

/**
 * text holds only the redacted target of the call (command line, path, skill
 * name or URL), never text the model wrote; times are ms from the session's
 * start
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
  truncated: z.literal(true).optional(),
  label: CallLabelSchema,
  category: z.string().min(1).max(L.labelTextLength).optional(),
  rule: z.string().min(1).max(L.labelTextLength).optional(),
  subagentSessionId: SessionIdSchema.optional(),
  swampSpans: z.array(SwampSpanRootSchema).max(L.spanRootsPerCall).optional(),
});

export const TurnSchema = z.strictObject({
  n: z.number().int().positive(),
  start: MillisSchema,
  end: MillisSchema,
  tokens: TokenUsageSchema,
  calls: z.array(ToolCallSchema).max(L.callsPerTurn),
});

export const FindingSchema = z.strictObject({
  severity: FindingSeveritySchema,
  title: z.string().min(1).max(L.findingTitleLength),
  detail: z.string().max(L.findingDetailLength),
  tune: z.string().max(L.findingDetailLength),
  callIds: z.array(z.string().min(1).max(L.idLength)).max(L.callIdsPerFinding),
});

/**
 * swampUserId is the stable user id and the only identity meant for access
 * decisions; swampUsername is a display label a rename can make stale; both are
 * self-reported by the writer
 */
export const AgentSessionRecordV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  id: SessionIdSchema,
  repo: z.string().min(1).max(L.nameLength),
  harness: HarnessSchema,
  harnessVersion: z.string().min(1).max(L.nameLength).optional(),
  model: z.string().min(1).max(L.nameLength).optional(),
  startedAt: z.iso.datetime(),
  invocation: InvocationSchema,
  swampUserId: z.string().min(1).max(L.idLength).optional(),
  swampUsername: z.string().min(1).max(L.nameLength).optional(),
  parentSessionId: SessionIdSchema.optional(),
  agentId: AgentIdSchema.optional(),
  agentType: z.string().min(1).max(L.nameLength).optional(),
  importerVersion: z.string().min(1).max(L.nameLength),
  turns: z.array(TurnSchema).max(L.turns),
  findings: z.array(FindingSchema).max(L.findings),
}).superRefine((record, ctx) => {
  let calls = 0;
  for (const turn of record.turns) calls += turn.calls.length;
  if (calls > L.callsPerSession) {
    // Refused before the id scan, so it never builds a set of every call id.
    // readAgentSessionRecord counts calls before parsing at all.
    ctx.addIssue({
      code: "too_big",
      origin: "array",
      maximum: L.callsPerSession,
      inclusive: true,
      message: "too many calls in one session",
      path: ["turns"],
    });
    return;
  }
  for (const key of ["agentId", "agentType"] as const) {
    if (record[key] !== undefined && record.parentSessionId === undefined) {
      ctx.addIssue({
        code: "custom",
        message: `${key} is only for a child session`,
        path: [key],
      });
    }
  }
  const ids = new Set<string>();
  record.turns.forEach((turn, t) =>
    turn.calls.forEach((call, c) => {
      const path = ["turns", t, "calls", c];
      if (ids.has(call.id)) {
        ctx.addIssue({
          code: "custom",
          message: "duplicate call id",
          path: [...path, "id"],
        });
      }
      ids.add(call.id);
      if (
        call.subagentSessionId !== undefined && call.toolKind !== "subagent"
      ) {
        ctx.addIssue({
          code: "custom",
          message: "subagentSessionId is only for a subagent call",
          path: [...path, "subagentSessionId"],
        });
      }
      const unlabeled = call.label === "unlabeled";
      for (const key of ["category", "rule"] as const) {
        if ((call[key] === undefined) !== unlabeled) {
          ctx.addIssue({
            code: "custom",
            message: unlabeled
              ? `an unlabeled call has no ${key}`
              : `a labelled call needs a ${key}`,
            path: [...path, key],
          });
        }
      }
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

export type AgentSessionRecord = z.infer<typeof AgentSessionRecordV2Schema>;
export type AgentSessionTurn = z.infer<typeof TurnSchema>;
export type AgentSessionToolCall = z.infer<typeof ToolCallSchema>;
export type AgentSessionFinding = z.infer<typeof FindingSchema>;

export type AgentSessionSkipReason = "newer" | "older" | "invalid";

export type AgentSessionReading =
  | { readonly kind: "record"; readonly record: AgentSessionRecord }
  | {
    readonly kind: "skipped";
    readonly reason: AgentSessionSkipReason;
    readonly schemaVersion?: number;
    readonly note: string;
  };

/**
 * never throws: an unreadable session comes back skipped so one bad record
 * never fails a page; a note names field paths and never repeats a content
 * value except schemaVersion
 */
export function readAgentSessionRecord(content: unknown): AgentSessionReading {
  const version = typeof content === "object" && content !== null &&
      !Array.isArray(content)
    ? (content as Record<string, unknown>).schemaVersion
    : undefined;
  if (
    typeof version !== "number" || !Number.isInteger(version) || version < 1
  ) {
    return skipped(
      "invalid",
      undefined,
      "no integer schemaVersion of 1 or more",
    );
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
  if (exceedsSessionSize(content as Record<string, unknown>)) {
    return skipped(
      "invalid",
      version,
      `does not match version ${version}: too_big at turns`,
    );
  }
  const parsed = AgentSessionRecordV2Schema.safeParse(content);
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

/**
 * counts on the raw content so an oversized record is refused before the parser
 * validates every call; reads only array lengths and stops once a limit is
 * passed
 */
function exceedsSessionSize(content: Record<string, unknown>): boolean {
  const turns = content.turns;
  if (!Array.isArray(turns)) return false;
  if (turns.length > L.turns) return true;
  let calls = 0;
  for (const turn of turns) {
    const turnCalls = typeof turn === "object" && turn !== null
      ? (turn as Record<string, unknown>).calls
      : undefined;
    if (Array.isArray(turnCalls)) calls += turnCalls.length;
    if (calls > L.callsPerSession) return true;
  }
  return false;
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

/**
 * throws when harness or sessionId is not one the record schema accepts, so no
 * two sessions share a name
 */
export function agentSessionDataName(
  harness: string,
  sessionId: string,
): string {
  if (!HarnessSchema.safeParse(harness).success) {
    throw new Error("agent session harness must be a lowercase slug");
  }
  if (!SessionIdSchema.safeParse(sessionId).success) {
    throw new Error(
      "agent session id must be letters, digits, '-' and '_', starting with a letter or digit",
    );
  }
  return `agent-session-${harness}_${sessionId}`;
}

// Hex digits of the child id's hash: 128 bits of SHA-256.
const CHILD_ID_HASH_LENGTH = 32;

/**
 * the hash covers both ids in full and in any case, so two children never share
 * an id however their ids are spelled
 */
export async function agentSessionChildId(
  parentSessionId: string,
  agentId: string,
): Promise<string> {
  if (!SessionIdSchema.safeParse(parentSessionId).success) {
    throw new Error(
      "agent session id must be letters, digits, '-' and '_', starting with a letter or digit",
    );
  }
  if (!AgentIdSchema.safeParse(agentId).success) {
    throw new Error(
      `agent id must be 1 to ${L.idLength} characters`,
    );
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([parentSessionId, agentId])),
  );
  const hash = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("").slice(0, CHILD_ID_HASH_LENGTH);
  const prefix = parentSessionId.slice(
    0,
    L.sessionIdLength - CHILD_ID_HASH_LENGTH - 1,
  );
  return `${prefix}_${hash}`;
}

/**
 * throws when the id is not one the record schema accepts, so nothing but an id
 * reaches the predicate
 */
export function agentSessionChildrenPredicate(parentSessionId: string): string {
  if (!SessionIdSchema.safeParse(parentSessionId).success) {
    throw new Error(
      "agent session id must be letters, digits, '-' and '_', starting with a letter or digit",
    );
  }
  return `${AGENT_SESSION_QUERY_PREDICATE} && tags.${AGENT_SESSION_PARENT_TAG} == "${parentSessionId}"`;
}

/**
 * the value is quoted as a CEL string literal (JSON escapes are a subset of
 * CEL's), so no value can change the predicate's meaning
 */
export function agentSessionRepoCondition(repo: string): string {
  if (repo.length === 0 || repo.length > L.nameLength) {
    throw new Error(
      `agent session repo must be 1 to ${L.nameLength} characters`,
    );
  }
  return `tags.${AGENT_SESSION_REPO_TAG} == ${JSON.stringify(repo)}`;
}

const CountSchema = z.number().int().nonnegative();

export const AgentSessionSummaryV1Schema = z.strictObject({
  repo: z.string().min(1).max(L.nameLength),
  harness: HarnessSchema,
  harnessVersion: z.string().min(1).max(L.nameLength).optional(),
  invocation: InvocationSchema,
  wallMs: MillisSchema,
  activeMs: MillisSchema,
  turns: CountSchema,
  calls: CountSchema,
  swamp: CountSchema,
  bypass: CountSchema,
  neutral: CountSchema,
  unlabeled: CountSchema,
  failedCalls: CountSchema,
  subagents: CountSchema,
  tokens: TokenUsageSchema,
  findings: z.strictObject({
    high: CountSchema,
    medium: CountSchema,
    low: CountSchema,
    info: CountSchema,
  }),
});

export type AgentSessionSummary = z.infer<typeof AgentSessionSummaryV1Schema>;

function addCapped(total: number, value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, total + value);
}

/**
 * totals stop at Number.MAX_SAFE_INTEGER, so an absurd record still gives a
 * summary the reader accepts; a negative turn duration counts as zero
 */
export function agentSessionSummary(
  record: AgentSessionRecord,
): AgentSessionSummary {
  const labels = { swamp: 0, bypass: 0, neutral: 0, unlabeled: 0 };
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let calls = 0;
  let failedCalls = 0;
  let subagents = 0;
  let wallMs = 0;
  let activeMs = 0;
  for (const turn of record.turns) {
    activeMs = addCapped(activeMs, Math.max(0, turn.end - turn.start));
    wallMs = Math.max(wallMs, turn.end);
    tokens.input = addCapped(tokens.input, turn.tokens.input);
    tokens.output = addCapped(tokens.output, turn.tokens.output);
    tokens.cacheRead = addCapped(tokens.cacheRead, turn.tokens.cacheRead);
    tokens.cacheWrite = addCapped(tokens.cacheWrite, turn.tokens.cacheWrite);
    for (const call of turn.calls) {
      calls++;
      labels[call.label]++;
      if (!call.ok) failedCalls++;
      if (call.toolKind === "subagent") subagents++;
      wallMs = Math.max(wallMs, call.end);
    }
  }
  const findings = { high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of record.findings) findings[finding.severity]++;
  return {
    repo: record.repo,
    harness: record.harness,
    ...(record.harnessVersion === undefined
      ? {}
      : { harnessVersion: record.harnessVersion }),
    invocation: record.invocation,
    wallMs,
    activeMs,
    turns: record.turns.length,
    calls,
    ...labels,
    failedCalls,
    subagents,
    tokens,
    findings,
  };
}

/** derived from the record so the tags cannot drift from it */
export function agentSessionTags(
  record: AgentSessionRecord,
): Record<string, string> {
  return {
    [AGENT_SESSION_STARTED_AT_TAG]: new Date(record.startedAt).toISOString(),
    ...(record.parentSessionId === undefined
      ? {}
      : { [AGENT_SESSION_PARENT_TAG]: record.parentSessionId }),
    [AGENT_SESSION_HEADLESS_TAG]: String(record.invocation === "headless"),
    [AGENT_SESSION_REPO_TAG]: record.repo,
    [AGENT_SESSION_SUMMARY_TAG]: JSON.stringify(agentSessionSummary(record)),
  };
}

/**
 * never throws; tags are self-reported, so the page shows a summary but always
 * validates the full record when a session is opened
 */
export function readAgentSessionSummary(
  value: unknown,
): AgentSessionSummary | undefined {
  if (typeof value !== "string" || value.length > L.summaryTagLength) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  const summary = AgentSessionSummaryV1Schema.safeParse(parsed);
  return summary.success ? summary.data : undefined;
}

export function agentSessionRecordJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(AgentSessionRecordV2Schema, {
    unrepresentable: "any",
  }) as Record<string, unknown>;
}

export function agentSessionSummaryJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(AgentSessionSummaryV1Schema, {
    unrepresentable: "any",
  }) as Record<string, unknown>;
}
