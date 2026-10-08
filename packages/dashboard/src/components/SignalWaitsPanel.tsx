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
import type { SignalWaitRow } from "../client/signal_wait_state.ts";

interface SignalWaitsPanelProps {
  rows: readonly SignalWaitRow[];
  /**
   * The resume control for a signalled wait whose run can be resumed. Left
   * out, such a row shows only its resume command.
   */
  renderResume?: (row: SignalWaitRow) => ReactNode;
}

const STATE_LABELS: Record<SignalWaitRow["state"], string> = {
  open: "Waiting for signal",
  signalled: "Signalled",
  expired: "Expired",
};

const STATE_COLORS: Record<SignalWaitRow["state"], string> = {
  open: "var(--warning)",
  signalled: "var(--success)",
  expired: "var(--danger)",
};

const DETAIL_STYLE = {
  fontSize: "0.75rem",
  color: "var(--text-3)",
  marginTop: 2,
};

/**
 * The runs waiting for a signal: each wait with its ID, deadline and what
 * moves it on. An open wait shows the payload schema and the signal command;
 * a signalled wait shows its receipt and the resume that applies it; an
 * expired wait shows the resume that fails its step. Renders nothing when no
 * run waits. Takes its rows as props and reads no context, so it renders the
 * same anywhere.
 */
export function SignalWaitsPanel(
  { rows, renderResume }: SignalWaitsPanelProps,
) {
  if (rows.length === 0) return null;
  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="panel-header">
        <div className="panel-title">
          Waiting for signal <span className="panel-count">{rows.length}</span>
        </div>
      </div>
      {rows.map((row) => (
        <div
          className="approval-row"
          key={row.waitId}
          data-wait-state={row.state}
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
                {row.runId.slice(0, 8)}
              </span>
              <span
                className="mono"
                style={{ fontSize: "0.72rem", color: STATE_COLORS[row.state] }}
              >
                {STATE_LABELS[row.state]}
              </span>
            </div>
            <div style={DETAIL_STYLE}>
              Step <span className="mono">{row.stepName}</span> · wait{" "}
              <span className="mono">{row.waitId}</span>
            </div>
            {row.deadline && (
              <div style={DETAIL_STYLE}>
                {row.state === "expired" ? "Deadline passed" : "Deadline"}{" "}
                <span className="mono">{row.deadline}</span>
              </div>
            )}
            {row.receipt && (
              <div style={DETAIL_STYLE}>
                Signal <span className="mono">{row.receipt.id}</span> from{" "}
                {row.receipt.submittedBy}
                {row.receipt.receivedAt && (
                  <>
                    {" "}at{" "}
                    <span className="mono">{row.receipt.receivedAt}</span>
                  </>
                )}
              </div>
            )}
            {row.state === "open" && row.schema !== undefined && (
              <div style={DETAIL_STYLE}>
                Payload schema{" "}
                <span className="mono">{JSON.stringify(row.schema)}</span>
              </div>
            )}
            {row.state === "expired" && (
              <div style={DETAIL_STYLE}>
                No signal can reach it. A resume fails the step.
              </div>
            )}
            {row.state === "signalled" && row.awaitingResume && renderResume
              ? renderResume(row)
              : row.command && (
                <div className="mono" style={DETAIL_STYLE}>{row.command}</div>
              )}
          </div>
        </div>
      ))}
    </div>
  );
}
