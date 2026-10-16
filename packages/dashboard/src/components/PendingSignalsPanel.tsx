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
import { useEffect, useState } from "react";
import { heldAt, type PendingSignalRow } from "../client/signal_wait_state.ts";
import { formatAbsoluteTime } from "../lib/format.ts";
import { formatWait } from "../lib/wait_order.ts";

interface PendingSignalsPanelProps {
  /** The held signals, soonest to lapse first. */
  rows: readonly PendingSignalRow[];
}

/**
 * How often the panel re-reads the clock. Serve sends nothing when a held
 * signal lapses, so the panel drops it on its own clock.
 */
const TICK_MS = 1000;

const DETAIL_STYLE = {
  fontSize: "0.75rem",
  color: "var(--text-3)",
  marginTop: 2,
};

/**
 * The time to judge held signals by: re-read every {@link TICK_MS} while
 * `active`, so a page counting held signals drops a lapsed one when the
 * panel does.
 */
export function useHeldSignalClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * The signals sent by key before any wait for the key was open: each with
 * its key, workflow, receipt, when serve received it and how long serve
 * holds it for the next wait on the key. A signal past its hold is hidden,
 * on a clock the panel ticks itself: a signal lapsing changes no run, so
 * nothing refetches the list. Renders nothing when no signal is held.
 */
export function PendingSignalsPanel({ rows }: PendingSignalsPanelProps) {
  const now = useHeldSignalClock(rows.length > 0);
  const held = heldAt(rows, now);
  if (held.length === 0) return null;
  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="panel-header">
        <div className="panel-title">
          Pending signals <span className="panel-count">{held.length}</span>
        </div>
      </div>
      {held.map((row) => (
        <div
          className="approval-row"
          key={row.receiptId}
          data-pending-signal={row.receiptId}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontWeight: 500,
                fontSize: "0.85rem",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {row.workflowName}
              <span className="mono" style={{ color: "var(--text-3)" }}>
                key {row.key}
              </span>
              <span
                className="mono"
                style={{ fontSize: "0.72rem", color: "var(--warning)" }}
              >
                Held for a wait
              </span>
            </div>
            <div style={DETAIL_STYLE}>
              Signal <span className="mono">{row.receiptId}</span> from{" "}
              {row.submittedBy}
              {row.receivedAt && (
                <>
                  {" "}at <span className="mono">{row.receivedAt}</span>
                </>
              )}
            </div>
            <div style={DETAIL_STYLE}>
              Held until{" "}
              <time
                className="mono"
                dateTime={row.heldUntil}
                title={formatAbsoluteTime(row.heldUntil)}
              >
                {row.heldUntil}
              </time>{" "}
              · {formatWait(Date.parse(row.heldUntil) - now)} left
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
