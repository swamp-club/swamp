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
import {
  filterRows,
  formatSessionSort,
  type HeadlessFilter,
  pageOf,
  parseSessionSort,
  SESSION_LIST_LIMIT,
  SESSION_PAGE_SIZE,
  type SessionSort,
  sortRows,
} from "../client/agent_sessions.ts";
import { useSessionList } from "../client/useAgentSessions.ts";
import { useQueryState } from "../client/useQueryState.ts";
import { LoadError } from "../components/LoadError.tsx";
import { Pager } from "../components/Pager.tsx";
import { listTotals } from "../lib/agent_session_view.ts";
import { pluralize } from "../lib/format.ts";
import { ListTotalsRow } from "./agent_sessions/SessionOverview.tsx";
import { SessionDetail } from "./agent_sessions/SessionDetail.tsx";
import { SessionsTable } from "./agent_sessions/SessionsTable.tsx";
import "../styles/agent-sessions.css";

const HEADLESS_FILTERS: Array<[HeadlessFilter, string]> = [
  ["all", "All sessions"],
  ["interactive", "Interactive"],
  ["headless", "Headless"],
];

function parseHeadless(raw: string | null): HeadlessFilter {
  return raw === "interactive" || raw === "headless" ? raw : "all";
}

/**
 * What coding agents did in this repo: their sessions, turns and tool calls,
 * labelled swamp, bypass or neutral, with the findings the importer wrote
 * (swamp-club#4155). A Preview page: the sidebar shows it only when the
 * viewer can read a session.
 */
export function AgentSessions() {
  const sessions = useSessionList();
  const [headless, setHeadless] = useQueryState<HeadlessFilter>(
    "headless",
    "all",
    parseHeadless,
    (v) => (v === "all" ? null : v),
  );
  const [page, setPage] = useQueryState<number>(
    "page",
    0,
    (raw) => Math.max(0, Number(raw) || 0),
    (v) => (v === 0 ? null : String(v)),
  );
  const [openName, setOpenName] = useQueryState<string | null>(
    "session",
    null,
    (raw) => raw,
    (v) => v,
  );

  const [sort, setSort] = useQueryState<SessionSort>(
    "sort",
    parseSessionSort(null),
    parseSessionSort,
    formatSessionSort,
  );

  const rows = sortRows(filterRows(sessions.list.rows, headless), sort);
  const shown = pageOf(rows, page);
  const open = sessions.list.rows.find((r) => r.name === openName) ?? null;

  return (
    <>
      <div className="page-header">
        <h1 className="as-title">
          Agent sessions
          <span
            className="as-preview-chip"
            title="A preview: what it shows may change"
          >
            Preview
          </span>
        </h1>
        <div className="header-right">
          <div className="as-chips" role="group" aria-label="Filter sessions">
            {HEADLESS_FILTERS.map(([value, label]) => (
              <button
                type="button"
                key={value}
                className="as-chip"
                aria-pressed={headless === value}
                onClick={() => {
                  setHeadless(value);
                  setPage(0);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {!sessions.loading && (
            <span className="as-muted">
              {pluralize(rows.length, "session")}
            </span>
          )}
        </div>
      </div>

      {rows.length > 0 && (
        <div className="as-totals">
          <ListTotalsRow totals={listTotals(rows.map((r) => r.summary))} />
        </div>
      )}

      <div className="panel">
        {(sessions.list.nextCursor !== undefined || sessions.loadingOlder ||
          sessions.olderError) && (
          <div className="as-notice as-older">
            <span>
              Showing the newest {sessions.list.rows.length}{" "}
              sessions; sorting, filters and totals cover these.
            </span>
            {sessions.loadingOlder
              ? <span className="as-muted">Loading older sessions…</span>
              : sessions.loadOlder && (
                <button
                  type="button"
                  className="as-chip"
                  onClick={sessions.loadOlder}
                >
                  Load {SESSION_LIST_LIMIT} older
                </button>
              )}
            {sessions.olderError && (
              <span className="as-failed">
                Could not load older sessions: {sessions.olderError}
              </span>
            )}
          </div>
        )}
        {sessions.loading && sessions.list.rows.length === 0 && (
          <div className="as-notice">Loading sessions…</div>
        )}
        {sessions.error && (
          <LoadError
            subject="agent sessions"
            message={sessions.error}
            onRetry={sessions.refetch}
            inset
          />
        )}
        {!sessions.loading && !sessions.error && rows.length === 0 && (
          <div className="as-notice">
            {sessions.list.rows.length === 0
              ? "No agent sessions you can read."
              : "No sessions match this filter."}
          </div>
        )}
        {rows.length > 0 && (
          <SessionsTable
            rows={shown.rows}
            openName={openName}
            sort={sort}
            onSort={(next) => {
              setSort(next);
              setPage(0);
            }}
            onOpen={(row) =>
              setOpenName(row.name === openName ? null : row.name)}
          />
        )}
        <Pager
          page={shown.page}
          pageSize={SESSION_PAGE_SIZE}
          total={rows.length}
          onPageChange={setPage}
        />
      </div>

      {open && <SessionDetail key={open.name} row={open} />}
    </>
  );
}
