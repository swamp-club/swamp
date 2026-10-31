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
export const AGENT_SESSION_SCHEMA_VERSION = 2;

/** Every version this swamp reads; older versions are skipped as `older`. */
export const SUPPORTED_AGENT_SESSION_SCHEMA_VERSIONS: readonly number[] = [2];

/** Value of the `type` tag that marks a data item as an agent session. */
export const AGENT_SESSION_TYPE_TAG = "agent-session";

/** Tag key that carries the session's swamp-club user id. */
export const AGENT_SESSION_USER_ID_TAG = "swampUserId";

/** Tag key that carries the session's start, as `toISOString()` writes it. */
export const AGENT_SESSION_STARTED_AT_TAG = "startedAt";

/** Tag key that carries a child session's parent id; absent on top-level sessions. */
export const AGENT_SESSION_PARENT_TAG = "parentSessionId";

/** Tag key that is `"true"` for a headless session and `"false"` otherwise. */
export const AGENT_SESSION_HEADLESS_TAG = "headless";

/** Tag key that carries the session's list summary as compact JSON. */
export const AGENT_SESSION_SUMMARY_TAG = "summary";

/**
 * Tag key that carries the session's repo, the record's `repo` as is, so a
 * list can filter by repo in the query (swamp-club#4211).
 */
export const AGENT_SESSION_REPO_TAG = "repo";

/** The predicate that lists every agent session through `data.query`. */
export const AGENT_SESSION_QUERY_PREDICATE =
  `tags.type == "${AGENT_SESSION_TYPE_TAG}"`;

/**
 * The `data.query` select for a list of sessions. It reads only the data
 * name, the owning behavior's name and tags, so with a predicate over tags
 * the query never loads a record body; without a select, the query loads the
 * body of every match. `data.get` needs the behavior name to open a session.
 */
export const AGENT_SESSION_LIST_SELECT =
  `{"name": name, "modelName": modelName, "tags": tags}`;

/** The predicate that lists top-level sessions only, leaving out subagents. */
export const AGENT_SESSION_TOP_LEVEL_PREDICATE =
  `${AGENT_SESSION_QUERY_PREDICATE} && !has(tags.${AGENT_SESSION_PARENT_TAG})`;

/** Size bounds; a longest real session (169 calls, 17 turns) fits well inside. */
export const AGENT_SESSION_LIMITS = {
  // Harness and session id together form a data name, stored as a directory
  // name: 14 + 32 + 1 + 128 = 175 characters at most, under every OS limit.
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
  // A summary's strings are bounded, so its JSON stays well under this even
  // when every character needs escaping.
  summaryTagLength: 4096,
} as const;

const L = AGENT_SESSION_LIMITS;

// A harness slug has no `_`, so the `_` in a data name always ends it. Both
// are lowercase so two names never meet on a case-insensitive filesystem.
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const SESSION_ID = /^[a-z0-9][a-z0-9_-]*$/;

const HarnessSchema = z.string().max(L.harnessLength).regex(SLUG);
const SessionIdSchema = z.string().max(L.sessionIdLength).regex(SESSION_ID);
const AgentIdSchema = z.string().min(1).max(L.idLength);
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

/**
 * Whether a tool call used swamp, went around it, or neither. `unlabeled` is
 * a call the importer wrote before any classifier labelled it.
 */
export const CallLabelSchema = z.enum([
  "swamp",
  "bypass",
  "neutral",
  "unlabeled",
]);

/** `info` is a finding that is not a problem to tune, such as swamp's own overhead. */
export const FindingSeveritySchema = z.enum(["high", "medium", "low", "info"]);

/**
 * Whether a person steered the session. A child session copies its parent's
 * value; `unknown` is for a harness that cannot tell.
 */
export const InvocationSchema = z.enum(["interactive", "headless", "unknown"]);

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
 * command line, a path, a skill name or a URL), never text the model wrote;
 * `truncated` marks one that was cut to fit. `category` and `rule` say why a
 * call got its label, so an `unlabeled` call has neither.
 * `subagentSessionId` names the child session a subagent call started.
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
  truncated: z.literal(true).optional(),
  label: CallLabelSchema,
  category: z.string().min(1).max(L.labelTextLength).optional(),
  rule: z.string().min(1).max(L.labelTextLength).optional(),
  subagentSessionId: SessionIdSchema.optional(),
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
 * Version 2 of the agent session record. `swampUserId` is the stable
 * swamp-club user id (serve's OAuth `sub`) and the only identity meant for
 * access decisions; `swampUsername` is a display label that a rename can
 * make stale. Both are self-reported by the writer. `model` is absent when
 * the session ended before any model reply; `agentId` is a child session's
 * subagent id as the harness wrote it, and `agentType` its subagent type.
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
 * record never fails a page. A note names field paths and never repeats a
 * value from the content, except the integer `schemaVersion`.
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
 * Counts turns and calls on the raw content, so a record over the session
 * limits is refused before the parser validates every call in it. Reads only
 * array lengths, and stops as soon as a limit is passed.
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
 * The data name a session is stored under: one item per harness session.
 * Throws when `harness` or `sessionId` is not one the record schema accepts,
 * so no two sessions share a name.
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
 * A child session's id, for a harness subagent id that is unique only within
 * its parent: the parent's id, cut to fit, then `_` and a hash of the two ids.
 * The hash covers both ids in full and in any case, so two children never
 * share an id however their ids are spelled. Throws when `parentSessionId` is
 * not a session id the record schema accepts, or `agentId` is empty or
 * longer than an id may be.
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
 * The predicate that lists one session's children. Throws when the id is not
 * one the record schema accepts, so nothing but an id reaches the predicate.
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
 * The condition that matches sessions whose `repo` tag is `repo`. The value
 * is any string a record's `repo` may hold, quoted as a CEL string literal
 * (JSON's escapes are a subset of CEL's), so no value can change the
 * predicate's meaning. Throws on a value the record schema would refuse.
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

/**
 * Version 1 of a session's list summary, stored as compact JSON in its
 * `summary` tag so the list never loads record bodies. Counts cover the
 * session's own calls; `subagents` counts its subagent calls.
 */
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
 * Derives a session's list summary from its record. `wallMs` is the latest
 * turn or call end; `activeMs` adds up turn durations, counting a negative
 * one as zero. Totals stop at `Number.MAX_SAFE_INTEGER`, so an absurd record
 * still gives a summary the reader accepts.
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

/**
 * The list tags a session is written with, next to the output spec's `type`
 * tag. Derived from the record so they cannot drift from it.
 */
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
 * Reads a `summary` tag. Never throws: a value that is too long, is not
 * JSON, or does not match the summary schema comes back `undefined`, and the
 * page opens the record instead. Tags are self-reported, so the page shows a
 * summary but always validates the full record when a session is opened.
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

/** The JSON Schema of the current version, for extension authors. */
export function agentSessionRecordJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(AgentSessionRecordV2Schema, {
    unrepresentable: "any",
  }) as Record<string, unknown>;
}

/** The JSON Schema of the list summary, for extension authors. */
export function agentSessionSummaryJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(AgentSessionSummaryV1Schema, {
    unrepresentable: "any",
  }) as Record<string, unknown>;
}
