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
 * What the agent sessions page draws, computed from records it has read
 * (swamp-club#4155). Pure, no React. Findings are read from the records and
 * never computed here (swamp-club#4157).
 *
 * A call is addressed by its session id and call id together (`CallKey`):
 * call ids are unique only within a session, and a session's subagents are
 * separate records.
 */

import type {
  AgentSessionFinding,
  AgentSessionRecord,
  AgentSessionSummary,
  AgentSessionToolCall,
  AgentSessionTurn,
} from "./agent_sessions/record.ts";

export type CallLabel = AgentSessionToolCall["label"];
export type Severity = AgentSessionFinding["severity"];
export type CallKey = string;

export function callKey(sessionId: string, callId: string): CallKey {
  return `${sessionId}/${callId}`;
}

/** A duration that is never negative: harness clocks are not always tidy. */
export function clampedDuration(start: number, end: number): number {
  return Math.max(0, end - start);
}

/** The share of swamp calls among calls that used swamp or went around it. */
export function swampShare(
  counts: { swamp: number; bypass: number },
): number | null {
  const counted = counts.swamp + counts.bypass;
  return counted === 0 ? null : counts.swamp / counted;
}

/** Each label's share of all calls, for the mix bar. */
export function labelMix(
  summary: Pick<
    AgentSessionSummary,
    "swamp" | "bypass" | "neutral" | "unlabeled" | "calls"
  >,
): Record<CallLabel, number> {
  const total = summary.calls;
  const share = (n: number) => (total === 0 ? 0 : n / total);
  return {
    swamp: share(summary.swamp),
    bypass: share(summary.bypass),
    neutral: share(summary.neutral),
    unlabeled: share(summary.unlabeled),
  };
}

export function allCalls(
  record: AgentSessionRecord,
): Array<AgentSessionToolCall & { turn: number }> {
  return record.turns.flatMap((t) => t.calls.map((c) => ({ ...c, turn: t.n })));
}

export interface SessionTiles {
  readonly share: number | null;
  readonly counts: Record<CallLabel, number>;
  /** Bypasses by category, most first. */
  readonly bypassCategories: ReadonlyArray<readonly [string, number]>;
  readonly calls: number;
  readonly failed: number;
  readonly firstFailedTurn: number | null;
  readonly activeMs: number;
  readonly wallMs: number;
  readonly turns: number;
  readonly outputTokens: number;
  /** Input plus cache reads and writes: what the model read as context. */
  readonly contextTokens: number;
  readonly cacheShare: number | null;
}

/** The tiles for one session's own calls. */
export function sessionTiles(record: AgentSessionRecord): SessionTiles {
  const calls = allCalls(record);
  const counts: Record<CallLabel, number> = {
    swamp: 0,
    bypass: 0,
    neutral: 0,
    unlabeled: 0,
  };
  const categories = new Map<string, number>();
  let failed = 0;
  let firstFailedTurn: number | null = null;
  let wallMs = 0;
  for (const call of calls) {
    counts[call.label]++;
    if (call.label === "bypass") {
      const category = call.category ?? "not classified";
      categories.set(category, (categories.get(category) ?? 0) + 1);
    }
    if (!call.ok) {
      failed++;
      firstFailedTurn ??= call.turn;
    }
    wallMs = Math.max(wallMs, call.end);
  }
  let activeMs = 0;
  let output = 0;
  let context = 0;
  let cacheRead = 0;
  for (const turn of record.turns) {
    activeMs += clampedDuration(turn.start, turn.end);
    wallMs = Math.max(wallMs, turn.end);
    output += turn.tokens.output;
    context += turn.tokens.input + turn.tokens.cacheRead +
      turn.tokens.cacheWrite;
    cacheRead += turn.tokens.cacheRead;
  }
  return {
    share: swampShare(counts),
    counts,
    bypassCategories: [...categories].sort((a, b) =>
      b[1] - a[1] || a[0].localeCompare(b[0])
    ),
    calls: calls.length,
    failed,
    firstFailedTurn,
    activeMs,
    wallMs,
    turns: record.turns.length,
    outputTokens: output,
    contextTokens: context,
    cacheShare: context === 0 ? null : cacheRead / context,
  };
}

/** Totals across the listed sessions, read from their summary tags only. */
export interface ListTotals {
  readonly sessions: number;
  readonly headless: number;
  /** Sessions without a readable summary, left out of every other total. */
  readonly unsummarized: number;
  readonly share: number | null;
  readonly counts: Record<CallLabel, number>;
  readonly calls: number;
  readonly failed: number;
  readonly sessionsWithFailures: number;
  readonly sessionsWithBypasses: number;
  readonly turns: number;
  readonly activeMs: number;
  readonly outputTokens: number;
  readonly contextTokens: number;
  readonly cacheShare: number | null;
  readonly findings: Record<Severity, number>;
  /** Sessions with a high or medium finding. */
  readonly sessionsToReview: number;
  /** Sessions with any high, medium or low finding. */
  readonly sessionsWithFindings: number;
}

/**
 * Adds up the listed sessions' summaries. Each summary counts its session's
 * own calls, so a subagent's calls are not in its parent's totals.
 */
export function listTotals(
  summaries: ReadonlyArray<AgentSessionSummary | undefined>,
): ListTotals {
  const counts: Record<CallLabel, number> = {
    swamp: 0,
    bypass: 0,
    neutral: 0,
    unlabeled: 0,
  };
  const findings: Record<Severity, number> = {
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  let headless = 0;
  let unsummarized = 0;
  let calls = 0;
  let failed = 0;
  let sessionsWithFailures = 0;
  let sessionsWithBypasses = 0;
  let sessionsToReview = 0;
  let sessionsWithFindings = 0;
  let turns = 0;
  let activeMs = 0;
  let output = 0;
  let context = 0;
  let cacheRead = 0;
  for (const s of summaries) {
    if (!s) {
      unsummarized++;
      continue;
    }
    if (s.invocation === "headless") headless++;
    for (const label of Object.keys(counts) as CallLabel[]) {
      counts[label] += s[label];
    }
    for (const severity of Object.keys(findings) as Severity[]) {
      findings[severity] += s.findings[severity];
    }
    calls += s.calls;
    failed += s.failedCalls;
    if (s.failedCalls > 0) sessionsWithFailures++;
    if (s.bypass > 0) sessionsWithBypasses++;
    if (s.findings.high + s.findings.medium > 0) sessionsToReview++;
    if (s.findings.high + s.findings.medium + s.findings.low > 0) {
      sessionsWithFindings++;
    }
    turns += s.turns;
    activeMs += s.activeMs;
    output += s.tokens.output;
    context += s.tokens.input + s.tokens.cacheRead + s.tokens.cacheWrite;
    cacheRead += s.tokens.cacheRead;
  }
  return {
    sessions: summaries.length,
    headless,
    unsummarized,
    share: swampShare(counts),
    counts,
    calls,
    failed,
    sessionsWithFailures,
    sessionsWithBypasses,
    turns,
    activeMs,
    outputTokens: output,
    contextTokens: context,
    cacheShare: context === 0 ? null : cacheRead / context,
    findings,
    sessionsToReview,
    sessionsWithFindings,
  };
}

/** The gap the session strip draws between turns, in place of idle time. */
export const STRIP_GAP_MS = 1500;

export interface StripSegment {
  readonly n: number;
  /** Where the turn starts and ends on the strip, idle time removed. */
  readonly from: number;
  readonly to: number;
  /** The idle time removed before this turn. */
  readonly idleBefore: number;
}

/**
 * Lays turns end to end with idle time removed: each keeps its own length,
 * and the time between two turns becomes `STRIP_GAP_MS` (or less, when the
 * turns were closer than that). Turns are taken in start order.
 */
export function compressIdle(
  turns: readonly AgentSessionTurn[],
): { segments: StripSegment[]; total: number } {
  const ordered = [...turns].sort((a, b) => a.start - b.start || a.n - b.n);
  const segments: StripSegment[] = [];
  let cursor = 0;
  let previousEnd: number | null = null;
  for (const turn of ordered) {
    const length = clampedDuration(turn.start, turnEnd(turn));
    const idle = previousEnd === null
      ? 0
      : Math.max(0, turn.start - previousEnd);
    const gap = previousEnd === null ? 0 : Math.min(idle, STRIP_GAP_MS);
    const from = cursor + gap;
    segments.push({
      n: turn.n,
      from,
      to: from + length,
      idleBefore: Math.max(0, idle - gap),
    });
    cursor = from + length;
    previousEnd = Math.max(previousEnd ?? 0, turnEnd(turn));
  }
  return { segments, total: cursor };
}

/** A turn's end, stretched to cover a call that ran past it. */
export function turnEnd(turn: AgentSessionTurn): number {
  return turn.calls.reduce((end, c) => Math.max(end, c.end), turn.end);
}

/**
 * A turn's own time scale: where it starts and how long it is, never zero,
 * so every turn's waterfall spans its full width.
 */
export function turnScale(
  turn: AgentSessionTurn,
): { start: number; length: number } {
  return {
    start: turn.start,
    length: Math.max(1, clampedDuration(turn.start, turnEnd(turn))),
  };
}

/** Where a call sits on its turn's scale, as fractions of the width. */
export function callBar(
  call: Pick<AgentSessionToolCall, "start" | "end">,
  scale: { start: number; length: number },
): { left: number; width: number } {
  const left = Math.min(
    1,
    Math.max(0, (call.start - scale.start) / scale.length),
  );
  const width = Math.min(
    1 - left,
    clampedDuration(call.start, call.end) / scale.length,
  );
  return { left, width };
}

export interface SpanNode {
  readonly name: string;
  readonly start: number;
  readonly duration: number;
  readonly error: boolean;
  readonly children: SpanNode[];
}

/**
 * Builds a swamp command's span tree from its spans in order, by depth: a
 * span is the child of the nearest earlier span one level up. A span whose
 * depth skips a level hangs under the deepest open span.
 */
export function spanTree(
  spans: ReadonlyArray<
    {
      name: string;
      start: number;
      duration: number;
      depth: number;
      error: boolean;
    }
  >,
): SpanNode[] {
  const roots: SpanNode[] = [];
  const open: Array<{ depth: number; node: SpanNode }> = [];
  for (const span of spans) {
    const node: SpanNode = {
      name: span.name,
      start: span.start,
      duration: Math.max(0, span.duration),
      error: span.error,
      children: [],
    };
    while (open.length > 0 && open[open.length - 1].depth >= span.depth) {
      open.pop();
    }
    const parent = open[open.length - 1];
    if (parent) parent.node.children.push(node);
    else roots.push(node);
    open.push({ depth: span.depth, node });
  }
  return roots;
}

/** The subagent each of a session's calls started, by call id. */
export function subagentLinks(record: AgentSessionRecord): Map<string, string> {
  const links = new Map<string, string>();
  for (const call of allCalls(record)) {
    if (call.subagentSessionId !== undefined) {
      links.set(call.id, call.subagentSessionId);
    }
  }
  return links;
}

export interface ShownFinding {
  readonly finding: AgentSessionFinding;
  /** The session the finding belongs to: the opened one or a subagent. */
  readonly sessionId: string;
  readonly fromSubagent: boolean;
  readonly calls: ReadonlySet<CallKey>;
}

const SEVERITY_ORDER: Record<Severity, number> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3,
};

/**
 * The opened session's findings with those of its loaded subagents, most
 * severe first, the session's own before its subagents' within a severity.
 */
export function mergedFindings(
  record: AgentSessionRecord,
  children: readonly AgentSessionRecord[],
): ShownFinding[] {
  const shown = [record, ...children].flatMap((session, s) =>
    session.findings.map((finding) => ({
      finding,
      sessionId: session.id,
      fromSubagent: s > 0,
      calls: new Set(finding.callIds.map((id) => callKey(session.id, id))),
    }))
  );
  return shown
    .map((f, i) => ({ f, i }))
    .sort((a, b) =>
      SEVERITY_ORDER[a.f.finding.severity] -
        SEVERITY_ORDER[b.f.finding.severity] || a.i - b.i
    )
    .map(({ f }) => f);
}

export type CallFilter =
  | { readonly kind: "all" }
  | { readonly kind: "label"; readonly label: CallLabel }
  | { readonly kind: "failed" }
  | {
    readonly kind: "calls";
    readonly calls: ReadonlySet<CallKey>;
    /** The finding the calls come from, so they show in its colour. */
    readonly severity?: Severity;
  };

/**
 * The colour a filter shows in, as an `as-tone-*` class suffix: a label's
 * own colour, red for failed calls, a finding's severity.
 */
export function filterTone(filter: CallFilter): string {
  switch (filter.kind) {
    case "all":
      return "all";
    case "label":
      return `l-${filter.label}`;
    case "failed":
      return "failed";
    case "calls":
      return `sev-${filter.severity ?? "info"}`;
  }
}

/** Whether a call passes the filter. */
export function passes(
  filter: CallFilter,
  sessionId: string,
  call: Pick<AgentSessionToolCall, "id" | "label" | "ok">,
): boolean {
  switch (filter.kind) {
    case "all":
      return true;
    case "label":
      return call.label === filter.label;
    case "failed":
      return !call.ok;
    case "calls":
      return filter.calls.has(callKey(sessionId, call.id));
  }
}

/** Every call in the sessions that passes the filter. */
export function matchingCalls(
  filter: CallFilter,
  sessions: readonly AgentSessionRecord[],
): Set<CallKey> {
  const keys = new Set<CallKey>();
  for (const session of sessions) {
    for (const call of allCalls(session)) {
      if (passes(filter, session.id, call)) {
        keys.add(callKey(session.id, call.id));
      }
    }
  }
  return keys;
}
