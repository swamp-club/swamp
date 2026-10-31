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
import { type KeyboardEvent, type ReactNode, useState } from "react";
import type {
  AgentSessionRecord,
  AgentSessionToolCall,
  AgentSessionTurn,
} from "../../lib/agent_sessions/record.ts";
import {
  callBar,
  type CallFilter,
  compressIdle,
  filterTone,
  passes,
  type StripSegment,
  turnScale,
} from "../../lib/agent_session_view.ts";
import { formatCompactCount, formatDuration } from "../../lib/format.ts";
import { VirtualRows } from "../../components/VirtualRows.tsx";

/** Turns with more calls than this draw only the rows in view. */
export const VIRTUALISE_OVER = 100;
const ROW_HEIGHT = 26;
const VISIBLE_ROWS = 16;

export interface SelectedCall {
  readonly sessionId: string;
  readonly callId: string;
}

export interface WaterfallProps {
  readonly record: AgentSessionRecord;
  readonly filter: CallFilter;
  readonly openTurns: ReadonlySet<string>;
  readonly onToggleTurn: (key: string) => void;
  readonly selected: SelectedCall | null;
  readonly onSelect: (call: SelectedCall) => void;
  readonly openSubagents: ReadonlySet<string>;
  readonly onToggleSubagent: (childId: string) => void;
  /** Draws an opened subagent: its own turns, at full detail. */
  readonly renderSubagent: (childId: string) => ReactNode;
}

/** The key that opens one turn of one session. */
export function turnKey(sessionId: string, n: number): string {
  return `${sessionId}#${n}`;
}

function CallRow(
  {
    call,
    sessionId,
    scale,
    dim,
    severity,
    selected,
    onSelect,
    subagentOpen,
    onToggleSubagent,
  }: {
    call: AgentSessionToolCall;
    sessionId: string;
    scale: { start: number; length: number };
    dim: boolean;
    /** Set when the call is one of a shown finding's calls. */
    severity: string | undefined;
    selected: boolean;
    onSelect: (call: SelectedCall) => void;
    subagentOpen: boolean;
    onToggleSubagent: (childId: string) => void;
  },
) {
  const bar = callBar(call, scale);
  const select = () => onSelect({ sessionId, callId: call.id });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      select();
    }
  };
  const child = call.subagentSessionId;
  return (
    <div
      className="as-call"
      role="button"
      tabIndex={0}
      aria-selected={selected}
      data-dim={dim}
      data-sev={severity}
      onClick={select}
      onKeyDown={onKey}
    >
      <span className={`as-dot as-l-${call.label}`} title={call.label} />
      <span>
        {call.tool}
        {child && (
          <button
            type="button"
            className="as-link-button"
            style={{ marginLeft: 6 }}
            aria-expanded={subagentOpen}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSubagent(child);
            }}
          >
            {subagentOpen ? "hide" : "open"}
          </button>
        )}
      </span>
      <span className="as-call-text" title={call.text}>
        {call.ok ? "" : "✕ "}
        {call.text || "—"}
      </span>
      <span className="as-call-track">
        <span
          className={`as-call-bar as-l-${call.label}`}
          data-failed={!call.ok}
          style={{ left: `${bar.left * 100}%`, width: `${bar.width * 100}%` }}
        />
      </span>
    </div>
  );
}

function TurnCalls(
  { turn, props }: { turn: AgentSessionTurn; props: WaterfallProps },
) {
  const scale = turnScale(turn);
  const sessionId = props.record.id;
  const findingSeverity = props.filter.kind === "calls"
    ? props.filter.severity
    : undefined;
  const row = (call: AgentSessionToolCall) => {
    const pass = passes(props.filter, sessionId, call);
    return (
      <CallRow
        key={call.id}
        call={call}
        sessionId={sessionId}
        scale={scale}
        dim={!pass}
        severity={pass ? findingSeverity : undefined}
        selected={props.selected?.sessionId === sessionId &&
          props.selected.callId === call.id}
        onSelect={props.onSelect}
        subagentOpen={call.subagentSessionId !== undefined &&
          props.openSubagents.has(call.subagentSessionId)}
        onToggleSubagent={props.onToggleSubagent}
      />
    );
  };
  const opened = turn.calls
    .map((c) => c.subagentSessionId)
    .filter((id): id is string =>
      id !== undefined && props.openSubagents.has(id)
    );
  return (
    <div>
      {turn.calls.length > VIRTUALISE_OVER
        ? (
          <VirtualRows
            count={turn.calls.length}
            rowHeight={ROW_HEIGHT}
            height={ROW_HEIGHT * VISIBLE_ROWS}
            label={`Calls in turn ${turn.n}`}
            renderRow={(i) => row(turn.calls[i])}
          />
        )
        : turn.calls.map(row)}
      {opened.map((childId) => (
        <div key={childId} className="as-subagent">
          {props.renderSubagent(childId)}
        </div>
      ))}
    </div>
  );
}

/** The element id of one turn's row, so the strip can scroll to it. */
export function turnRowId(sessionId: string, n: number): string {
  return `as-turn-${sessionId}-${n}`;
}

/** A turn's calls as ticks, coloured by label, dimmed when filtered out. */
function Ticks(
  { turn, sessionId, filter }: {
    turn: AgentSessionTurn;
    sessionId: string;
    filter: CallFilter;
  },
) {
  const scale = turnScale(turn);
  return (
    <>
      {turn.calls.map((call) => (
        <span
          key={call.id}
          className={`as-strip-tick as-l-${call.label}`}
          style={{
            left: `${callBar(call, scale).left * 100}%`,
            opacity: passes(filter, sessionId, call) ? 1 : 0.2,
          }}
        />
      ))}
    </>
  );
}

function place(segment: StripSegment, total: number) {
  const width = Math.max(1, total);
  return {
    left: `${(segment.from / width) * 100}%`,
    width: `max(3px, ${((segment.to - segment.from) / width) * 100}%)`,
  };
}

/**
 * One session's turns as a timeline. The strip on top lays every turn end to
 * end with idle time removed; each turn's row below draws its track at the
 * same place on the same scale, so a row sits under its own piece of the
 * strip. A row opens into its calls, on the turn's own time scale.
 */
export function TurnWaterfall(props: WaterfallProps) {
  const { record, filter, openTurns, onToggleTurn } = props;
  const [hovered, setHovered] = useState<number | null>(null);
  const { segments, total } = compressIdle(record.turns);
  const segmentOf = new Map(segments.map((s) => [s.n, s]));
  const idle = segments.reduce((sum, s) => sum + s.idleBefore, 0);
  const byN = new Map(record.turns.map((t) => [t.n, t]));

  const openFromStrip = (n: number) => {
    const key = turnKey(record.id, n);
    if (!openTurns.has(key)) onToggleTurn(key);
    document.getElementById(turnRowId(record.id, n))?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  };

  return (
    <div className="as-timeline">
      <div className="as-tl-row as-tl-head">
        <div className="as-tl-label as-muted">
          {record.turns.length} turns · {formatDuration(idle)} idle removed
        </div>
        <div
          className="as-strip"
          role="group"
          aria-label="Turns end to end, idle time removed"
        >
          {segments.map((segment) => {
            const turn = byN.get(segment.n)!;
            return (
              <button
                type="button"
                key={segment.n}
                className="as-strip-turn"
                data-hover={hovered === segment.n}
                title={`Turn ${segment.n}${
                  segment.idleBefore > 0
                    ? `, after ${formatDuration(segment.idleBefore)} idle`
                    : ""
                }`}
                aria-label={`Turn ${segment.n}`}
                style={place(segment, total)}
                onMouseEnter={() => setHovered(segment.n)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => openFromStrip(segment.n)}
              >
                <Ticks turn={turn} sessionId={record.id} filter={filter} />
              </button>
            );
          })}
        </div>
      </div>
      {record.turns.map((turn) => {
        const key = turnKey(record.id, turn.n);
        const open = openTurns.has(key);
        const segment = segmentOf.get(turn.n);
        const failed = turn.calls.filter((c) => !c.ok).length;
        const matches = filter.kind === "all"
          ? turn.calls.length
          : turn.calls.filter((c) => passes(filter, record.id, c)).length;
        return (
          <div
            key={key}
            id={turnRowId(record.id, turn.n)}
            className="as-turn"
            data-hover={hovered === turn.n}
            onMouseEnter={() => setHovered(turn.n)}
            onMouseLeave={() => setHovered(null)}
          >
            <button
              type="button"
              className="as-tl-row as-turn-head"
              aria-expanded={open}
              title={`${formatCompactCount(turn.tokens.output)} output tokens`}
              onClick={() => onToggleTurn(key)}
            >
              <span className="as-tl-label">
                <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                <strong>Turn {turn.n}</strong>
                <span className="as-turn-meta">
                  {formatDuration(turnScale(turn).length)} ·{" "}
                  {filter.kind === "all"
                    ? (
                      <span className="as-turn-count">
                        {turn.calls.length} calls
                      </span>
                    )
                    : (
                      <span>
                        <span
                          className={`as-turn-count as-tone-${
                            filterTone(filter)
                          }`}
                          data-none={matches === 0}
                        >
                          {matches}
                        </span>
                        /{turn.calls.length} calls
                      </span>
                    )}
                  {failed > 0 && (
                    <span className="as-failed">{` · ${failed} failed`}</span>
                  )}
                </span>
              </span>
              <span className="as-tl-track" aria-hidden="true">
                {segment && (
                  <span className="as-strip-turn" style={place(segment, total)}>
                    <Ticks turn={turn} sessionId={record.id} filter={filter} />
                  </span>
                )}
              </span>
            </button>
            {open && <TurnCalls turn={turn} props={props} />}
          </div>
        );
      })}
    </div>
  );
}
