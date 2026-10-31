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
import type { KeyboardEvent } from "react";
import {
  firstSortDir,
  type SessionRow,
  type SessionSort,
  type SessionSortKey,
} from "../../client/agent_sessions.ts";
import type { AgentSessionSummary } from "../../lib/agent_sessions/record.ts";
import { labelMix, swampShare } from "../../lib/agent_session_view.ts";
import {
  formatCompactCount,
  formatDuration,
  formatShortDateTime,
} from "../../lib/format.ts";

const LABELS = ["swamp", "bypass", "neutral", "unlabeled"] as const;

const INVOCATION_TEXT = {
  interactive: "Interactive: a person steered this session",
  headless:
    "Headless: run by automation (for example claude -p), with no person steering it",
  unknown: "The harness did not say whether a person steered this session",
} as const;

/** A person for an interactive session, a terminal for a headless one. */
export function InvocationIcon(
  { invocation }: { invocation: keyof typeof INVOCATION_TEXT },
) {
  const text = INVOCATION_TEXT[invocation];
  return (
    <span className="as-type" title={text} aria-label={text} role="img">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        {invocation === "headless"
          ? (
            <>
              <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
              <path d="M4.5 6l2 2-2 2M8.5 10.5h3" />
            </>
          )
          : invocation === "interactive"
          ? (
            <>
              <circle cx="8" cy="5" r="2.5" />
              <path d="M3 14c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5" />
            </>
          )
          : <path d="M6 6a2 2 0 1 1 2.5 2c-.4.2-.5.5-.5 1v.5M8 12v.5" />}
      </svg>
    </span>
  );
}

/** The swamp, bypass, neutral and not-classified shares of a session's calls. */
export function LabelMix(
  { summary }: {
    summary: Pick<
      AgentSessionSummary,
      "swamp" | "bypass" | "neutral" | "unlabeled" | "calls"
    >;
  },
) {
  const mix = labelMix(summary);
  const title = LABELS.map((l) =>
    `${summary[l]} ${l === "unlabeled" ? "not classified" : l}`
  ).join(", ");
  return (
    <div className="as-mix" role="img" aria-label={title} title={title}>
      {LABELS.map((l) => (
        <span
          key={l}
          className={`as-l-${l}`}
          style={{ width: `${mix[l] * 100}%` }}
        />
      ))}
    </div>
  );
}

const SEVERITIES = [
  ["high", "high"],
  ["medium", "medium"],
  ["low", "low"],
] as const;

/** Findings by severity as coloured counts; info findings are not flagged. */
export function Flags({ summary }: { summary: AgentSessionSummary }) {
  const shown = SEVERITIES.filter(([key]) => summary.findings[key] > 0);
  if (shown.length === 0) {
    return (
      <span className="as-count as-sev-clean" title="No findings to review">
        ✓
      </span>
    );
  }
  return (
    <>
      {shown.map(([key, word]) => {
        const n = summary.findings[key];
        const text = `${n} ${word} finding${n === 1 ? "" : "s"}`;
        return (
          <span
            key={key}
            className={`as-count as-sev-${key}`}
            title={text}
            aria-label={text}
          >
            {n}
          </span>
        );
      })}
    </>
  );
}

function SummaryCells({ summary }: { summary: AgentSessionSummary }) {
  const share = swampShare(summary);
  const subagents = `${summary.subagents} subagent${
    summary.subagents === 1 ? "" : "s"
  }`;
  return (
    <>
      <td className="as-num">{formatDuration(summary.wallMs)}</td>
      <td className="as-num">{summary.turns}</td>
      <td className="as-num">
        {summary.calls}
        {summary.subagents > 0 && (
          <span
            className="as-count as-count-plain"
            title={`Started ${subagents}`}
            aria-label={subagents}
          >
            +{summary.subagents}
          </span>
        )}
      </td>
      <td>
        <div className="as-share">
          <LabelMix summary={summary} />
          <span className="as-muted">
            {share === null ? "—" : `${Math.round(share * 100)}%`}
          </span>
        </div>
      </td>
      <td
        className={`as-num${summary.failedCalls > 0 ? " as-failed" : ""}`}
      >
        {summary.failedCalls}
      </td>
      <td className="as-num">{formatCompactCount(summary.tokens.output)}</td>
      <td className="as-flags">
        <Flags summary={summary} />
      </td>
    </>
  );
}

const COLUMNS: ReadonlyArray<{
  key: SessionSortKey;
  label: string;
  title?: string;
  className?: string;
}> = [
  {
    key: "type",
    label: "Type",
    title: "Interactive or headless",
    className: "as-type-col",
  },
  { key: "repo", label: "Repo" },
  { key: "harness", label: "Harness" },
  { key: "started", label: "Started" },
  { key: "length", label: "Length", className: "as-num" },
  { key: "turns", label: "Turns", className: "as-num" },
  { key: "calls", label: "Calls", className: "as-num" },
  {
    key: "share",
    label: "swamp share",
    title: "swamp calls out of the calls that used swamp or went around it",
  },
  { key: "failed", label: "Failed", className: "as-num" },
  {
    key: "tokens",
    label: "Tokens",
    title: "Output tokens",
    className: "as-num",
  },
  {
    key: "findings",
    label: "Findings",
    title: "Findings, most severe first",
  },
];

export function SessionsTable(
  { rows, openName, onOpen, sort, onSort }: {
    rows: readonly SessionRow[];
    openName: string | null;
    onOpen: (row: SessionRow) => void;
    sort: SessionSort;
    onSort: (sort: SessionSort) => void;
  },
) {
  const onKey = (row: SessionRow) => (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(row);
    }
  };
  return (
    <div className="table-wrap">
      <table className="data-table as-table" aria-label="Agent sessions">
        <thead>
          <tr>
            {COLUMNS.map((column) => {
              const active = sort.key === column.key;
              const next: SessionSort = {
                key: column.key,
                dir: active
                  ? sort.dir === "asc" ? "desc" : "asc"
                  : firstSortDir(column.key),
              };
              return (
                <th
                  key={column.key}
                  className={column.className}
                  aria-sort={active
                    ? sort.dir === "asc" ? "ascending" : "descending"
                    : "none"}
                >
                  <button
                    type="button"
                    className="as-sort"
                    data-active={active}
                    title={`${column.title ?? column.label}: sort ${
                      next.dir === "asc" ? "ascending" : "descending"
                    }`}
                    onClick={() => onSort(next)}
                  >
                    {column.label}
                    <span className="as-sort-mark" aria-hidden="true">
                      {(active ? sort.dir : next.dir) === "asc" ? "▲" : "▼"}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.name}
              className="as-row"
              tabIndex={0}
              aria-selected={row.name === openName}
              onClick={() => onOpen(row)}
              onKeyDown={onKey(row)}
            >
              <td className="as-type-col">
                <InvocationIcon
                  invocation={row.summary?.invocation ??
                    (row.headless ? "headless" : "unknown")}
                />
              </td>
              <td>{row.summary?.repo ?? "—"}</td>
              <td
                title={row.summary?.harnessVersion
                  ? `${row.summary.harness} ${row.summary.harnessVersion}`
                  : undefined}
              >
                {row.summary?.harness ?? "—"}
              </td>
              <td className="as-nowrap">
                {row.startedAt ? formatShortDateTime(row.startedAt) : "—"}
              </td>
              {row.summary
                ? <SummaryCells summary={row.summary} />
                : (
                  <td colSpan={7} className="as-muted">
                    Summary unavailable; open the session to read it.
                  </td>
                )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
