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
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionRow } from "../../client/agent_sessions.ts";
import {
  type ChildRecord,
  useChildRecords,
  useSessionChildren,
  useSessionDetail,
} from "../../client/useAgentSessions.ts";
import {
  agentSessionDataName,
  type AgentSessionReading,
  type AgentSessionRecord,
  type AgentSessionSkipReason,
} from "../../lib/agent_sessions/record.ts";
import {
  allCalls,
  type CallFilter,
  matchingCalls,
  mergedFindings,
  passes,
  sessionTiles,
  type ShownFinding,
} from "../../lib/agent_session_view.ts";
import { formatShortDateTime } from "../../lib/format.ts";
import { LoadError } from "../../components/LoadError.tsx";
import { CallInspector } from "./CallInspector.tsx";
import {
  FilterChips,
  findingKey,
  FindingsPanel,
  SessionStats,
} from "./SessionOverview.tsx";
import { type SelectedCall, turnKey, TurnWaterfall } from "./TurnWaterfall.tsx";

const SKIP_TEXT: Record<AgentSessionSkipReason, string> = {
  newer: "written by a newer swamp",
  older: "written in a version this swamp no longer reads",
  invalid: "not a valid session record",
};

function Skipped({ reading }: { reading: AgentSessionReading }) {
  if (reading.kind !== "skipped") return null;
  return (
    <div className="panel as-section">
      <h2>This session could not be read</h2>
      <p>It was {SKIP_TEXT[reading.reason]}: {reading.note}</p>
    </div>
  );
}

function readRecord(entry: ChildRecord | undefined): AgentSessionRecord | null {
  return entry?.state === "read" && entry.reading.kind === "record"
    ? entry.reading.record
    : null;
}

function subagentTitle(record: AgentSessionRecord): string {
  return `Subagent${record.agentType ? ` ${record.agentType}` : ""}`;
}

/** Turns of the sessions that hold a call passing the filter. */
function turnsWithMatches(
  filter: CallFilter,
  sessions: readonly AgentSessionRecord[],
): string[] {
  return sessions.flatMap((s) =>
    s.turns
      .filter((t) => t.calls.some((c) => passes(filter, s.id, c)))
      .map((t) => turnKey(s.id, t.n))
  );
}

export function SessionDetail({ row }: { row: SessionRow }) {
  const detail = useSessionDetail(row);
  const record = detail.reading?.kind === "record"
    ? detail.reading.record
    : null;
  const children = useSessionChildren(record?.id ?? null);
  const childRecords = useChildRecords();
  const [filter, setFilter] = useState<CallFilter>({ kind: "all" });
  const [findingTitle, setFindingTitle] = useState<string | null>(null);
  const [openFinding, setOpenFinding] = useState<string | null>(null);
  const [openTurns, setOpenTurns] = useState<ReadonlySet<string>>(new Set());
  const [openSubagents, setOpenSubagents] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [selected, setSelected] = useState<SelectedCall | null>(null);

  // Escape closes the inspector.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [selected]);

  const childRow = useCallback((childId: string): SessionRow | undefined => {
    if (!record) return undefined;
    let name: string;
    try {
      name = agentSessionDataName(record.harness, childId);
    } catch {
      return undefined;
    }
    return children.list.rows.find((r) => r.name === name);
  }, [record, children.list.rows]);

  const loaded = useMemo(
    () =>
      children.list.rows
        .map((r) => readRecord(childRecords.records.get(r.name)))
        .filter((r): r is AgentSessionRecord => r !== null),
    [children.list.rows, childRecords.records],
  );
  const sessions = useMemo(() => (record ? [record, ...loaded] : []), [
    record,
    loaded,
  ]);
  const findings = useMemo(
    () => (record ? mergedFindings(record, loaded) : []),
    [record, loaded],
  );
  const unloaded = children.list.rows.filter((r) => {
    const f = r.summary?.findings;
    return !childRecords.records.has(r.name) && f !== undefined &&
      f.high + f.medium + f.low + f.info > 0;
  });
  const skippedChildren = [...childRecords.records.values()].flatMap((entry) =>
    entry.state === "read" && entry.reading.kind === "skipped"
      ? [entry.reading.reason]
      : []
  );

  const openAll = (keys: readonly string[]) =>
    setOpenTurns((current) => new Set([...current, ...keys]));

  const changeFilter = (next: CallFilter) => {
    setFilter(next);
    setFindingTitle(null);
    setOpenFinding(null);
    if (next.kind !== "all") openAll(turnsWithMatches(next, sessions));
  };

  /**
   * Opening a finding shows its calls in the turns, in its colour; closing
   * it shows every call again.
   */
  const toggleFinding = (shown: ShownFinding) => {
    const key = findingKey(shown);
    if (openFinding === key) {
      setOpenFinding(null);
      if (filter.kind === "calls") changeFilter({ kind: "all" });
      return;
    }
    setOpenFinding(key);
    if (shown.calls.size > 0) showCalls(shown);
  };

  const showCalls = (shown: ShownFinding) => {
    const next: CallFilter = {
      kind: "calls",
      calls: shown.calls,
      severity: shown.finding.severity,
    };
    setFilter(next);
    setFindingTitle(shown.finding.title);
    if (shown.fromSubagent) {
      setOpenSubagents((current) => new Set(current).add(shown.sessionId));
      // The subagent's own call that started it, so its turn opens too.
      const link = record &&
        allCalls(record).find((c) => c.subagentSessionId === shown.sessionId);
      if (record && link) openAll([turnKey(record.id, link.turn)]);
    }
    openAll(turnsWithMatches(next, sessions));
  };

  const toggleSubagent = (childId: string) => {
    const row = childRow(childId);
    if (row) void childRecords.load(row);
    setOpenSubagents((current) => {
      const next = new Set(current);
      if (next.has(childId)) next.delete(childId);
      else next.add(childId);
      return next;
    });
  };

  const toggleTurn = (key: string) =>
    setOpenTurns((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Selecting the selected call again closes the inspector.
  const selectCall = (call: SelectedCall) =>
    setSelected((current) =>
      current?.sessionId === call.sessionId && current.callId === call.callId
        ? null
        : call
    );

  const waterfallProps = {
    filter,
    openTurns,
    onToggleTurn: toggleTurn,
    selected,
    onSelect: selectCall,
    openSubagents,
    onToggleSubagent: toggleSubagent,
    renderSubagent: (childId: string) => renderSubagent(childId),
  };

  function renderSubagent(childId: string) {
    const row = childRow(childId);
    if (!row) {
      return (
        <p className="as-muted">
          {children.loading
            ? "Loading subagents…"
            : "This subagent's session is not in the repo, or you cannot read it."}
        </p>
      );
    }
    const entry = childRecords.records.get(row.name);
    if (!entry || entry.state === "loading") {
      return <p className="as-muted">Loading subagent…</p>;
    }
    if (entry.state === "error") {
      return (
        <p className="as-failed">Could not load the subagent: {entry.error}</p>
      );
    }
    if (entry.reading.kind === "skipped") {
      return <Skipped reading={entry.reading} />;
    }
    const child = entry.reading.record;
    return (
      <>
        <div className="as-subagent-head">
          <strong>{subagentTitle(child)}</strong> · {child.turns.length}{" "}
          turns · started {formatShortDateTime(child.startedAt)}
        </div>
        <TurnWaterfall record={child} {...waterfallProps} />
      </>
    );
  }

  if (detail.loading && !detail.reading) {
    return (
      <div className="panel as-section as-muted">Loading the session…</div>
    );
  }
  if (detail.error) {
    return (
      <LoadError
        subject="the session"
        message={detail.error}
        onRetry={detail.refetch}
      />
    );
  }
  if (!detail.reading) return null;
  if (!record) return <Skipped reading={detail.reading} />;

  const selectedSession = selected &&
    sessions.find((s) => s.id === selected.sessionId);
  const selectedCall = selectedSession
    ? allCalls(selectedSession).find((c) => c.id === selected!.callId) ?? null
    : null;
  const selectedChild = selectedCall?.subagentSessionId
    ? sessions.find((s) => s.id === selectedCall.subagentSessionId)
    : undefined;
  const nameOf = (sessionId: string) => {
    const s = sessions.find((x) => x.id === sessionId);
    return s ? subagentTitle(s) : "Subagent";
  };

  return (
    <div className="as-detail">
      <SessionStats
        record={record}
        tiles={sessionTiles(record)}
        filter={filter}
        onFilter={changeFilter}
      />
      <FindingsPanel
        findings={findings}
        unloaded={unloaded}
        openKey={openFinding}
        onToggle={toggleFinding}
        onLoadSubagent={(r) => void childRecords.load(r)}
        subagentName={nameOf}
      />
      <div className="panel as-section">
        <h2 className="as-turns-title">
          <span>Turns</span>
          {!selectedCall && (
            <span className="as-muted as-turns-hint">
              Select a call to inspect it
            </span>
          )}
        </h2>
        <FilterChips
          filter={filter}
          onChange={changeFilter}
          findingTitle={findingTitle}
          count={(f) => matchingCalls(f, sessions).size}
          total={sessions.reduce((n, s) => n + allCalls(s).length, 0)}
          withSubagents={loaded.length > 0}
        />
        {children.list.limited && (
          <p className="as-muted">
            More subagents exist than this page loads; some are not shown.
          </p>
        )}
        {skippedChildren.length > 0 && (
          <p className="as-muted">
            {skippedChildren.length}{" "}
            subagent session{skippedChildren.length === 1 ? "" : "s"}{" "}
            could not be read ({[...new Set(skippedChildren)].map((r) =>
              SKIP_TEXT[r]
            ).join("; ")}).
          </p>
        )}
        <div style={{ marginTop: 10 }}>
          <TurnWaterfall record={record} {...waterfallProps} />
        </div>
      </div>
      {selectedCall && (
        <CallInspector
          call={selectedCall}
          onClose={() => setSelected(null)}
          subagentLabel={selectedCall.subagentSessionId
            ? selectedChild
              ? subagentTitle(selectedChild)
              : "open the call to load it"
            : undefined}
        />
      )}
    </div>
  );
}
