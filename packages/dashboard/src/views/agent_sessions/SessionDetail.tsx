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
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import {
  jumpToId,
  type Place,
  placeOf,
  returnTo,
  revealScrollTop,
  scrollParent,
} from "../../lib/jump.ts";
import { LoadError } from "../../components/LoadError.tsx";
import { CallInspector } from "./CallInspector.tsx";
import {
  FilterChips,
  findingKey,
  FindingsPanel,
  SessionStats,
} from "./SessionOverview.tsx";
import {
  callRowId,
  type RevealCall,
  type SelectedCall,
  subagentBoxId,
  turnHeadId,
  turnKey,
  TurnWaterfall,
} from "./TurnWaterfall.tsx";

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

/** The first call passing the filter, in session then turn order. */
function firstMatch(
  filter: CallFilter,
  sessions: readonly AgentSessionRecord[],
): SelectedCall | null {
  for (const s of sessions) {
    for (const t of s.turns) {
      const call = t.calls.find((c) => passes(filter, s.id, c));
      if (call) return { sessionId: s.id, callId: call.id };
    }
  }
  return null;
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

export function SessionDetail(
  { row, onSettled }: {
    row: SessionRow;
    /** Called once the session has rendered: its record, a skip or an error. */
    onSettled?: () => void;
  },
) {
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
  const [reveal, setReveal] = useState<RevealCall | null>(null);
  const [jump, setJump] = useState<{ id: string; nonce: number } | null>(
    null,
  );
  const [returning, setReturning] = useState<Place | null>(null);
  const nonce = useRef(0);
  // Only the latest jump can be undone: an older place is stale once
  // anything else has moved the turns.
  const lastJump = useRef<{ key: string; place: Place } | null>(null);
  const turnsBox = useRef<HTMLDivElement>(null);
  const inspector = useRef<HTMLElement>(null);
  const detailRoot = useRef<HTMLDivElement>(null);

  useEffect(() => (jump ? jumpToId(jump.id) : undefined), [jump]);

  const settled = !(detail.loading && !detail.reading);
  useEffect(() => {
    if (settled) onSettled?.();
  }, [settled]);

  useLayoutEffect(() => {
    if (!returning) return;
    returnTo(returning);
    setReturning(null);
  }, [returning]);

  // Rows must clear the docked inspector, whose height follows its content.
  useEffect(() => {
    const panel = inspector.current;
    const root = detailRoot.current;
    if (!panel || !root || typeof ResizeObserver === "undefined") {
      root?.style.removeProperty("--as-inspector-h");
      return;
    }
    const observer = new ResizeObserver(() =>
      root.style.setProperty("--as-inspector-h", `${panel.offsetHeight}px`)
    );
    observer.observe(panel);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--as-inspector-h");
    };
  }, [selected !== null]);

  const jumpTo = (id: string, key: string) => {
    const box = turnsBox.current;
    if (lastJump.current?.key !== key) {
      lastJump.current = { key, place: placeOf([box, scrollParent(box)]) };
    }
    setJump({ id, nonce: ++nonce.current });
  };

  /** After closing what `key` opened: back to where its jump started. */
  const closed = (key: string) => {
    if (lastJump.current?.key !== key) return;
    setReturning(lastJump.current.place);
    lastJump.current = null;
  };

  const closeInspector = () => {
    if (!selected) return;
    setSelected(null);
    const row = document.getElementById(
      callRowId(selected.sessionId, selected.callId),
    );
    const box = scrollParent(row);
    if (!row || !box) return;
    const view = box.getBoundingClientRect();
    const at = row.getBoundingClientRect();
    const top = revealScrollTop(
      {
        top: view.top,
        height: view.height,
        scrollTop: box.scrollTop,
        header: 0,
      },
      { top: at.top, height: at.height },
    );
    if (top !== null) box.scrollTop = top;
    row.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") closeInspector();
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
    setReveal(null);
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
      setReveal(null);
      if (filter.kind === "calls") changeFilter({ kind: "all" });
      closed(`finding:${key}`);
      return;
    }
    setOpenFinding(key);
    if (shown.calls.size > 0) showCalls(shown, key);
  };

  const showCalls = (shown: ShownFinding, key: string) => {
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
    const first = firstMatch(next, sessions);
    if (first) {
      setReveal({ ...first, nonce: ++nonce.current });
      jumpTo(callRowId(first.sessionId, first.callId), `finding:${key}`);
    }
  };

  const toggleSubagent = (childId: string) => {
    const row = childRow(childId);
    if (row) void childRecords.load(row);
    const key = `subagent:${childId}`;
    const opening = !openSubagents.has(childId);
    setOpenSubagents((current) => {
      const next = new Set(current);
      if (opening) next.add(childId);
      else next.delete(childId);
      return next;
    });
    if (opening) jumpTo(subagentBoxId(childId), key);
    else closed(key);
  };

  const toggleTurn = (key: string) => {
    const opening = !openTurns.has(key);
    setOpenTurns((current) => {
      const next = new Set(current);
      if (opening) next.add(key);
      else next.delete(key);
      return next;
    });
    if (opening) jumpTo(turnHeadId(key), `turn:${key}`);
    else closed(`turn:${key}`);
  };

  const revealTurn = (key: string) => {
    if (!openTurns.has(key)) openAll([key]);
    jumpTo(turnHeadId(key), `turn:${key}`);
  };

  // Selecting the selected call again closes the inspector.
  const selectCall = (call: SelectedCall) => {
    if (
      selected?.sessionId === call.sessionId && selected.callId === call.callId
    ) {
      closeInspector();
    } else {
      setSelected(call);
    }
  };

  const waterfallProps = {
    filter,
    openTurns,
    onToggleTurn: toggleTurn,
    onRevealTurn: revealTurn,
    reveal,
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
    <div className="as-detail" ref={detailRoot}>
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
        <div className="as-turns-box" ref={turnsBox}>
          <TurnWaterfall record={record} {...waterfallProps} />
        </div>
      </div>
      {selectedCall && (
        <CallInspector
          ref={inspector}
          call={selectedCall}
          onClose={closeInspector}
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
