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

/** A step's wait for a signal, as the run view carries it. */
export interface StepSignalWaitInfo {
  id: string;
  deadline: string;
  receipt?: {
    id: string;
    receivedAt: string;
    submittedBy: string;
  };
}

interface StepSignalWaitProps {
  /** The step's status, as the run view reports it. */
  status: string;
  wait?: StepSignalWaitInfo;
}

/**
 * A `wait_for_signal` step's wait: its ID and deadline while it waits, and
 * the receipt of the signal that settled it. A step still `waiting` with a
 * receipt was signalled after the run suspended; the next resume applies
 * the signal. Renders nothing for a step with no wait.
 */
export function StepSignalWait({ status, wait }: StepSignalWaitProps) {
  if (!wait) return null;
  const waiting = status === "waiting";
  return (
    <div
      style={{
        marginTop: 6,
        padding: "6px 10px",
        borderRadius: 4,
        fontSize: "0.78rem",
        background: wait.receipt ? "var(--success-bg)" : "var(--warning-bg)",
        color: wait.receipt ? "var(--success)" : "var(--warning)",
      }}
    >
      {wait.receipt
        ? (
          <span>
            Signal <span className="mono">{wait.receipt.id}</span> from{" "}
            {wait.receipt.submittedBy} at{" "}
            <span className="mono">{wait.receipt.receivedAt}</span>
            {waiting && " — a resume applies it"}
          </span>
        )
        : (
          <span>
            {waiting ? "Waiting for signal" : "Waited for signal"}{" "}
            <span className="mono">{wait.id}</span> until{" "}
            <span className="mono">{wait.deadline}</span>
          </span>
        )}
    </div>
  );
}
