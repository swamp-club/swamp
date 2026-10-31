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
 * How the agent sessions page asks for sessions, and how it reads the
 * answers (swamp-club#4155). Pure: no React, so tests and the integration
 * test drive the same payloads the page sends.
 *
 * Every list query is bounded and reads tags only (`AGENT_SESSION_LIST_SELECT`),
 * so no record body is loaded until a session is opened. `data.query` drops
 * what the viewer may not read before it applies the limit.
 *
 * The list asks `data.query` for the newest `SESSION_LIST_LIMIT` sessions,
 * sorted by the `startedAt` tag in SQL (swamp-club#4177), and for each older
 * window with the `nextCursor` the previous one returned. The page sorts,
 * filters, totals and pages the sessions it has loaded.
 */

import {
  AGENT_SESSION_LIST_SELECT,
  AGENT_SESSION_TOP_LEVEL_PREDICATE,
  agentSessionChildrenPredicate,
  type AgentSessionReading,
  type AgentSessionSummary,
  readAgentSessionRecord,
  readAgentSessionSummary,
} from "../lib/agent_sessions/record.ts";
import { swampShare } from "../lib/agent_session_view.ts";

/** The most top-level sessions one list query (one window) asks for. */
export const SESSION_LIST_LIMIT = 1000;
/** Rows the sessions table shows at a time. */
export const SESSION_PAGE_SIZE = 50;
/** The most children one session's query asks for. */
export const CHILDREN_LIMIT = 500;

/** One session as the list knows it: its tags, never its body. */
export interface SessionRow {
  /** The data name, `agent-session-<harness>_<id>`. */
  readonly name: string;
  /** The behavior that owns the data; `data.get` needs it. */
  readonly modelName: string;
  readonly startedAt: string;
  readonly parentSessionId?: string;
  readonly headless: boolean;
  /** Absent when the summary tag does not read; the row still opens. */
  readonly summary?: AgentSessionSummary;
}

export interface SessionList {
  readonly rows: readonly SessionRow[];
  /** The query stopped at its limit, so more sessions exist. */
  readonly limited: boolean;
  /** Asks for the sessions after these, for a sorted list that was limited. */
  readonly nextCursor?: string;
}

/** Newest first, by the tag every session carries. */
export const SESSION_LIST_SORT = {
  field: "tags.startedAt",
  direction: "desc",
} as const;

export type HeadlessFilter = "all" | "interactive" | "headless";

/** The visibility check: is there one top-level session this viewer can read? */
export function probePayload(): Record<string, unknown> {
  return {
    predicate: AGENT_SESSION_TOP_LEVEL_PREDICATE,
    select: AGENT_SESSION_LIST_SELECT,
    limit: 1,
  };
}

/** A window of sessions, newest first: the first, or the one after `cursor`. */
export function listPayload(cursor?: string): Record<string, unknown> {
  return {
    predicate: AGENT_SESSION_TOP_LEVEL_PREDICATE,
    select: AGENT_SESSION_LIST_SELECT,
    limit: SESSION_LIST_LIMIT,
    sort: SESSION_LIST_SORT,
    ...(cursor === undefined ? {} : { cursor }),
  };
}

/**
 * The query for one session's subagents, or null for an id the record schema
 * would refuse (the helper throws on one, so nothing else reaches the
 * predicate).
 */
export function childrenPayload(
  parentSessionId: string,
): Record<string, unknown> | null {
  try {
    return {
      predicate: agentSessionChildrenPredicate(parentSessionId),
      select: AGENT_SESSION_LIST_SELECT,
      limit: CHILDREN_LIMIT,
    };
  } catch {
    return null;
  }
}

export function detailPayload(row: SessionRow): Record<string, unknown> {
  return {
    modelIdOrName: row.modelName,
    dataName: row.name,
    includeContent: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRow(value: unknown): SessionRow | null {
  if (!isRecord(value)) return null;
  const { name, modelName, tags } = value;
  if (typeof name !== "string" || typeof modelName !== "string") return null;
  if (!isRecord(tags)) return null;
  const tag = (key: string): string | undefined =>
    typeof tags[key] === "string" ? tags[key] as string : undefined;
  const parentSessionId = tag("parentSessionId");
  const summary = readAgentSessionSummary(tag("summary"));
  return {
    name,
    modelName,
    startedAt: tag("startedAt") ?? "",
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    headless: tag("headless") === "true",
    ...(summary === undefined ? {} : { summary }),
  };
}

function newestFirst(a: SessionRow, b: SessionRow): number {
  return a.startedAt < b.startedAt
    ? 1
    : a.startedAt > b.startedAt
    ? -1
    : a.name.localeCompare(b.name);
}

/**
 * Reads a `data.query` reply for the list select: rows newest first by the
 * `startedAt` tag, then by name, so the order is total whatever order the
 * reply came in. A row that is not a name, behavior and tags is dropped.
 */
export function parseListReply(data: unknown): SessionList {
  if (!isRecord(data)) return { rows: [], limited: false };
  const projected = isRecord(data.projected) ? data.projected : undefined;
  const raw = Array.isArray(projected?.rows) ? projected.rows : [];
  const rows = raw.map(readRow).filter((r): r is SessionRow => r !== null);
  rows.sort(newestFirst);
  return {
    rows,
    limited: data.limited === true,
    ...(typeof data.nextCursor === "string" && data.nextCursor !== ""
      ? { nextCursor: data.nextCursor }
      : {}),
  };
}

/**
 * Adds an older window to the list: a session in both keeps the newer
 * window's row, and whether more exist is the older window's to say.
 */
export function appendWindow(
  list: SessionList,
  older: SessionList,
): SessionList {
  const byName = new Map(older.rows.map((r) => [r.name, r]));
  for (const row of list.rows) byName.set(row.name, row);
  return {
    rows: [...byName.values()].sort(newestFirst),
    limited: older.limited,
    ...(older.nextCursor === undefined ? {} : { nextCursor: older.nextCursor }),
  };
}

export function filterRows(
  rows: readonly SessionRow[],
  headless: HeadlessFilter,
): SessionRow[] {
  if (headless === "all") return [...rows];
  return rows.filter((r) => r.headless === (headless === "headless"));
}

/** The list's sortable columns. */
export const SESSION_SORT_KEYS = [
  "type",
  "repo",
  "harness",
  "started",
  "length",
  "turns",
  "calls",
  "share",
  "failed",
  "tokens",
  "findings",
] as const;

export type SessionSortKey = typeof SESSION_SORT_KEYS[number];

export interface SessionSort {
  readonly key: SessionSortKey;
  readonly dir: "asc" | "desc";
}

/** Newest first: the order the list loads in. */
export const DEFAULT_SESSION_SORT: SessionSort = {
  key: "started",
  dir: "desc",
};

/** Text sorts A to Z first; dates and figures, largest first. */
export function firstSortDir(key: SessionSortKey): SessionSort["dir"] {
  return key === "type" || key === "repo" || key === "harness" ? "asc" : "desc";
}

/** Reads `key.dir` from the address; anything else is the default. */
export function parseSessionSort(raw: string | null): SessionSort {
  const [key, dir] = (raw ?? "").split(".");
  if (
    !(SESSION_SORT_KEYS as readonly string[]).includes(key) ||
    (dir !== "asc" && dir !== "desc")
  ) {
    return DEFAULT_SESSION_SORT;
  }
  return { key: key as SessionSortKey, dir };
}

export function formatSessionSort(sort: SessionSort): string | null {
  return sort.key === DEFAULT_SESSION_SORT.key &&
      sort.dir === DEFAULT_SESSION_SORT.dir
    ? null
    : `${sort.key}.${sort.dir}`;
}

function sortValue(
  row: SessionRow,
  key: SessionSortKey,
): string | number | undefined {
  const s = row.summary;
  switch (key) {
    case "type":
      return s?.invocation ?? (row.headless ? "headless" : "unknown");
    case "repo":
      return s?.repo;
    case "harness":
      return s?.harness;
    case "started":
      return row.startedAt || undefined;
    case "length":
      return s?.wallMs;
    case "turns":
      return s?.turns;
    case "calls":
      return s?.calls;
    case "share":
      return s ? swampShare(s) ?? undefined : undefined;
    case "failed":
      return s?.failedCalls;
    case "tokens":
      return s?.tokens.output;
    case "findings":
      // Most severe first: any high outranks any number of mediums.
      return s
        ? s.findings.high * 1e9 + s.findings.medium * 1e6 + s.findings.low
        : undefined;
  }
}

/**
 * Sorts the listed rows by a column. Rows without the value (no readable
 * summary) go last either way, and ties keep the newest-first order the
 * list loaded in.
 */
export function sortRows(
  rows: readonly SessionRow[],
  sort: SessionSort,
): SessionRow[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = sortValue(a, sort.key);
    const y = sortValue(b, sort.key);
    if (x === undefined || y === undefined) {
      return x === y ? 0 : x === undefined ? 1 : -1;
    }
    const order = typeof x === "number" && typeof y === "number"
      ? x - y
      : String(x).localeCompare(String(y));
    return sign * order;
  });
}

/** The rows of one page, counted from 0, and how many pages there are. */
export function pageOf(
  rows: readonly SessionRow[],
  page: number,
): { rows: SessionRow[]; pages: number; page: number } {
  const pages = Math.max(1, Math.ceil(rows.length / SESSION_PAGE_SIZE));
  const at = Math.min(Math.max(0, Math.floor(page)), pages - 1);
  return {
    rows: rows.slice(at * SESSION_PAGE_SIZE, (at + 1) * SESSION_PAGE_SIZE),
    pages,
    page: at,
  };
}

/**
 * Reads a `data.get` reply for one session. Never throws: content that is
 * absent, not UTF-8 or not JSON reads as an invalid record, with a note that
 * repeats nothing from the content.
 */
export function parseDetailReply(data: unknown): AgentSessionReading {
  const content = isRecord(data) ? data.content : undefined;
  const encoding = isRecord(data) ? data.contentEncoding : undefined;
  if (typeof content !== "string" || (encoding ?? "utf-8") !== "utf-8") {
    return {
      kind: "skipped",
      reason: "invalid",
      note: "the stored session is not JSON text",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      kind: "skipped",
      reason: "invalid",
      note: "the stored session is not valid JSON",
    };
  }
  return readAgentSessionRecord(parsed);
}

/** The `data` a serve reply wraps, or the value itself when it has none. */
export function replyData(payload: unknown): unknown {
  return isRecord(payload) && "data" in payload ? payload.data : payload;
}
