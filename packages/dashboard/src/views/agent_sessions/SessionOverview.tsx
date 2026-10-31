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

/** @jsxRuntime automatic */
/** @jsxImportSource react */
import type { ReactNode } from "react";
import type { SessionRow } from "../../client/agent_sessions.ts";
import {
  type CallFilter,
  type CallLabel,
  filterTone,
  type ListTotals,
  type SessionTiles,
  type Severity,
  type ShownFinding,
} from "../../lib/agent_session_view.ts";
import type { AgentSessionRecord } from "../../lib/agent_sessions/record.ts";
import { InvocationIcon, LabelMix } from "./SessionsTable.tsx";
import {
  formatCompactCount,
  formatDuration,
  formatShortDateTime,
  pluralize,
} from "../../lib/format.ts";

function percent(share: number | null): string {
  return share === null ? "—" : `${Math.round(share * 100)}%`;
}

/** One figure in a stat strip: its value, what it is, and a short note. */
type Stat = {
  label: string;
  value: ReactNode;
  unit?: string;
  /** A short line under the label. */
  sub?: ReactNode;
  /** The longer story, on hover. */
  title?: string;
  /** Makes the figure a filter: what clicking it shows. */
  filter?: { pressed: boolean; onClick: () => void; tone: string };
};

/**
 * Figures in one row, divided by rules rather than boxed, so a page of them
 * stays one line high. `lead` names what they describe.
 */
function StatStrip(
  { items, label, lead }: {
    items: readonly Stat[];
    label: string;
    lead?: ReactNode;
  },
) {
  return (
    <div className="panel as-stats" role="group" aria-label={label}>
      {lead && <div className="as-stats-lead">{lead}</div>}
      {items.map((stat) => {
        const body = (
          <>
            <span className="as-stat-value">
              {stat.value}
              {stat.unit && <small>{stat.unit}</small>}
            </span>
            <span className="as-stat-label">{stat.label}</span>
            {stat.sub && <span className="as-stat-sub">{stat.sub}</span>}
          </>
        );
        return stat.filter
          ? (
            <button
              type="button"
              key={stat.label}
              className={`as-stat as-stat-button as-tone-${stat.filter.tone}`}
              title={`${stat.title ? `${stat.title}. ` : ""}${
                stat.filter.pressed
                  ? "Click to show all calls"
                  : `Click to show only these calls in the turns`
              }`}
              aria-pressed={stat.filter.pressed}
              onClick={stat.filter.onClick}
            >
              {body}
            </button>
          )
          : (
            <div key={stat.label} className="as-stat" title={stat.title}>
              {body}
            </div>
          );
      })}
    </div>
  );
}

function FindingBadges({ findings }: { findings: Record<Severity, number> }) {
  const flagged = (["high", "medium", "low"] as const).filter((s) =>
    findings[s] > 0
  );
  if (flagged.length === 0) {
    return (
      <span className="as-count as-sev-clean" title="No findings to review">
        ✓
      </span>
    );
  }
  return (
    <span className="as-flags">
      {flagged.map((s) => {
        const n = findings[s];
        const text = `${n} ${s} finding${n === 1 ? "" : "s"}`;
        return (
          <span
            key={s}
            className={`as-count as-sev-${s}`}
            title={text}
            aria-label={text}
          >
            {n} {s}
          </span>
        );
      })}
    </span>
  );
}

/**
 * The open session: what it was (type icon, repo, harness, model, start),
 * then what the table row does not already say: the label mix, which
 * bypasses, where failures began, working against wall time, and context.
 */
export function SessionStats(
  { record, tiles, filter, onFilter }: {
    record: AgentSessionRecord;
    tiles: SessionTiles;
    /** The turns' filter, which the swamp, bypass and failed figures set. */
    filter: CallFilter;
    onFilter: (filter: CallFilter) => void;
  },
) {
  const toggle = (next: CallFilter) => ({
    pressed: sameFilter(filter, next),
    tone: filterTone(next),
    onClick: () => onFilter(sameFilter(filter, next) ? { kind: "all" } : next),
  });
  const topBypasses = tiles.bypassCategories
    .map(([category, n]) => `${n} ${category}`)
    .join(", ");
  const harness = record.harnessVersion
    ? `${record.harness} ${record.harnessVersion}`
    : record.harness;
  return (
    <StatStrip
      label="This session"
      lead={
        <>
          <InvocationIcon invocation={record.invocation} />
          <span className="as-stats-who">
            <strong>{record.repo}</strong>
            <span className="as-muted">
              {harness}
              {record.model && ` · ${record.model}`} ·{" "}
              {formatShortDateTime(record.startedAt)}
            </span>
          </span>
        </>
      }
      items={[
        {
          label: "swamp share",
          value: percent(tiles.share),
          sub: <LabelMix summary={{ ...tiles.counts, calls: tiles.calls }} />,
          title:
            `${tiles.counts.swamp} swamp calls, ${tiles.counts.bypass} bypasses; ${tiles.counts.neutral} neutral and ${tiles.counts.unlabeled} not classified not counted`,
          filter: toggle({ kind: "label", label: "swamp" }),
        },
        {
          label: "bypasses",
          value: String(tiles.counts.bypass),
          sub: tiles.bypassCategories[0]
            ? `${tiles.bypassCategories[0][1]} ${tiles.bypassCategories[0][0]}${
              tiles.bypassCategories.length > 1 ? " …" : ""
            }`
            : undefined,
          title: topBypasses || "No bypasses",
          filter: toggle({ kind: "label", label: "bypass" }),
        },
        {
          label: "failed",
          value: String(tiles.failed),
          unit: `/${tiles.calls}`,
          sub: tiles.firstFailedTurn === null
            ? undefined
            : `first in turn ${tiles.firstFailedTurn}`,
          filter: toggle({ kind: "failed" }),
        },
        {
          label: "working",
          value: formatDuration(tiles.activeMs),
          sub: `of ${formatDuration(tiles.wallMs)} wall`,
          title: `${tiles.turns} turns; idle time between them not counted`,
        },
        {
          label: "tokens out",
          value: formatCompactCount(tiles.outputTokens),
          sub: `${percent(tiles.cacheShare)} cached`,
          title: `${formatCompactCount(tiles.contextTokens)} context read, ${
            percent(tiles.cacheShare)
          } from cache`,
        },
      ]}
    />
  );
}

/**
 * Totals across every listed session that passes the filter, not just the
 * page shown, read from the sessions' summaries.
 */
export function ListTotalsRow({ totals }: { totals: ListTotals }) {
  const summarized = totals.sessions - totals.unsummarized;
  const interactive = summarized - totals.headless;
  return (
    <StatStrip
      label="Totals across the listed sessions"
      items={[
        {
          label: "sessions",
          value: String(totals.sessions),
          sub: (
            <span className="as-stat-types">
              <InvocationIcon invocation="interactive" /> {interactive}
              <InvocationIcon invocation="headless" /> {totals.headless}
            </span>
          ),
          title: `${interactive} interactive, ${totals.headless} headless${
            totals.unsummarized > 0
              ? `; ${totals.unsummarized} without a summary not counted`
              : ""
          }`,
        },
        {
          label: "swamp share",
          value: percent(totals.share),
          sub: <LabelMix summary={{ ...totals.counts, calls: totals.calls }} />,
          title:
            `${totals.counts.swamp} swamp calls, ${totals.counts.bypass} bypasses across ${totals.calls} calls`,
        },
        {
          label: "bypasses",
          value: String(totals.counts.bypass),
          sub: `in ${pluralize(totals.sessionsWithBypasses, "session")}`,
        },
        {
          label: "failed",
          value: String(totals.failed),
          unit: `/${totals.calls}`,
          sub: `in ${pluralize(totals.sessionsWithFailures, "session")}`,
        },
        {
          label: "working",
          value: formatDuration(totals.activeMs),
          sub: `${totals.turns} turns`,
        },
        {
          label: "tokens out",
          value: formatCompactCount(totals.outputTokens),
          sub: `${percent(totals.cacheShare)} cached`,
          title: `${formatCompactCount(totals.contextTokens)} context read, ${
            percent(totals.cacheShare)
          } from cache`,
        },
        {
          label: "findings",
          value: String(
            totals.findings.high + totals.findings.medium + totals.findings.low,
          ),
          sub: (
            <span className="as-stat-findings">
              <span>
                in {pluralize(totals.sessionsWithFindings, "session")}
              </span>
              <FindingBadges findings={totals.findings} />
            </span>
          ),
          title: totals.findings.info > 0
            ? `${totals.findings.info} info findings not counted`
            : undefined,
        },
      ]}
    />
  );
}

const SEVERITY_TEXT = {
  high: "high",
  medium: "medium",
  low: "low",
  info: "info",
} as const;

/** Names one shown finding across re-sorts, as subagents load. */
export function findingKey(shown: ShownFinding): string {
  return `${shown.sessionId}\n${shown.finding.title}`;
}

/**
 * "What to look at": the findings the importer wrote, one headline each. A
 * headline opens into its detail, what to tune, and a way to show its calls.
 */
export function FindingsPanel(
  { findings, unloaded, openKey, onToggle, onLoadSubagent, subagentName }: {
    findings: readonly ShownFinding[];
    /** Subagents whose summary has findings, not yet read. */
    unloaded: readonly SessionRow[];
    /** The finding opened, whose calls the turns show. */
    openKey: string | null;
    onToggle: (finding: ShownFinding) => void;
    onLoadSubagent: (row: SessionRow) => void;
    subagentName: (sessionId: string) => string;
  },
) {
  return (
    <div className="panel as-section">
      <h2>What to look at</h2>
      {findings.length === 0 && unloaded.length === 0 && (
        <p className="as-muted">No findings for this session.</p>
      )}
      <ul className="as-findings">
        {findings.map((shown, i) => {
          const expanded = openKey === findingKey(shown);
          return (
            <li
              key={i}
              className={`as-finding${
                expanded ? ` as-finding-open-${shown.finding.severity}` : ""
              }`}
              data-open={expanded}
            >
              <button
                type="button"
                className="as-finding-head"
                aria-expanded={expanded}
                title={shown.calls.size > 0
                  ? expanded
                    ? "Close, and show all calls again"
                    : "Open, and show its calls in the turns"
                  : undefined}
                onClick={() => onToggle(shown)}
              >
                <span className={`as-count as-sev-${shown.finding.severity}`}>
                  {SEVERITY_TEXT[shown.finding.severity]}
                </span>
                <span className="as-finding-title">{shown.finding.title}</span>
                {shown.fromSubagent && (
                  <span className="as-count as-count-plain">
                    {subagentName(shown.sessionId)}
                  </span>
                )}
                <span className="as-muted as-finding-calls">
                  {shown.calls.size > 0
                    ? `${shown.calls.size} call${
                      shown.calls.size === 1 ? "" : "s"
                    }`
                    : ""}
                </span>
              </button>
              {expanded && (
                <div className="as-finding-more">
                  {shown.finding.detail && <p>{shown.finding.detail}</p>}
                  {shown.finding.tune && (
                    <p className="as-finding-tune">{shown.finding.tune}</p>
                  )}
                </div>
              )}
            </li>
          );
        })}
        {unloaded.map((row) => {
          const f = row.summary?.findings;
          const count = f ? f.high + f.medium + f.low + f.info : 0;
          return (
            <li key={row.name} className="as-finding">
              <button
                type="button"
                className="as-finding-head"
                onClick={() => onLoadSubagent(row)}
              >
                <span className="as-count as-count-plain">subagent</span>
                <span className="as-muted">
                  {count} more finding{count === 1 ? "" : "s"}{" "}
                  from a subagent; load
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const FILTERS: Array<[string, CallFilter]> = [
  ["All calls", { kind: "all" }],
  ["swamp", { kind: "label", label: "swamp" }],
  ["Bypass", { kind: "label", label: "bypass" }],
  ["Neutral", { kind: "label", label: "neutral" }],
  ["Not classified", { kind: "label", label: "unlabeled" as CallLabel }],
  ["Failed", { kind: "failed" }],
];

function sameFilter(a: CallFilter, b: CallFilter): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "label" && b.kind === "label") return a.label === b.label;
  return a.kind !== "calls";
}

/**
 * The call filters, each with how many of the session's calls it matches,
 * and the active filter's count out of the total, in the filter's colour.
 */
export function FilterChips(
  { filter, onChange, findingTitle, count, total, withSubagents }: {
    filter: CallFilter;
    onChange: (filter: CallFilter) => void;
    /** Set while a finding's calls are shown. */
    findingTitle: string | null;
    /** How many calls a filter matches. */
    count: (filter: CallFilter) => number;
    total: number;
    /** Whether opened subagents' calls are counted too. */
    withSubagents: boolean;
  },
) {
  const scope = withSubagents ? " (with opened subagents)" : "";
  return (
    <div className="as-chips" role="group" aria-label="Filter calls">
      {FILTERS.map(([label, value]) => {
        const n = value.kind === "all" ? total : count(value);
        return (
          <button
            type="button"
            key={label}
            className={`as-chip as-tone-${filterTone(value)}`}
            aria-pressed={sameFilter(filter, value)}
            aria-label={`${label}, ${n} calls`}
            onClick={() => onChange(value)}
          >
            {label}
            <span className="as-chip-n">{n}</span>
          </button>
        );
      })}
      {filter.kind === "calls" && (
        <button
          type="button"
          className={`as-chip as-tone-${filterTone(filter)}`}
          aria-pressed="true"
          title="Show all calls again"
          onClick={() => onChange({ kind: "all" })}
        >
          {findingTitle ?? "A finding's calls"} ✕
        </button>
      )}
      {filter.kind !== "all" && (
        <span
          className={`as-chip-total as-tone-${filterTone(filter)}`}
          role="status"
        >
          <strong>{count(filter)}</strong> of {total} calls{scope}
        </span>
      )}
    </div>
  );
}
