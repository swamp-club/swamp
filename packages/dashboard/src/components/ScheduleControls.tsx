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

import { useState } from "react";
import type { ScheduleAction, ScheduleFeedback } from "../lib/triggers.ts";

interface ScheduleControlsProps {
  workflowName: string;
  /** A serve override exists that a reset would remove. */
  canReset: boolean;
  pending?: ScheduleAction;
  feedback?: ScheduleFeedback;
  onEdit: () => void;
  onReset: () => void;
  /** "row" keeps the controls compact for a table cell. */
  layout?: "row" | "header";
}

const PENDING_TEXT: Record<ScheduleAction, string> = {
  save: "Saving…",
  reset: "Resetting…",
};

/**
 * Edit and Reset for one schedule. Reset removes the serve
 * override, so it asks for a second click; every control is disabled while
 * a change is in flight, and the outcome is announced beside them.
 */
export function ScheduleControls(
  {
    workflowName,
    canReset,
    pending,
    feedback,
    onEdit,
    onReset,
    layout = "row",
  }: ScheduleControlsProps,
) {
  const [confirming, setConfirming] = useState(false);
  const busy = pending !== undefined;

  return (
    <div className={`sched-controls layout-${layout}`}>
      <div
        className="sched-buttons"
        role="group"
        aria-label={`Schedule actions for ${workflowName}`}
      >
        {confirming
          ? (
            <>
              <span className="sched-confirm-text">
                Drop the override and use the workflow file's schedule?
              </span>
              <button
                type="button"
                className="trig-btn danger"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  onReset();
                }}
              >
                Reset
              </button>
              <button
                type="button"
                className="trig-btn"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                Keep
              </button>
            </>
          )
          : (
            <>
              <button
                type="button"
                className="trig-btn"
                disabled={busy}
                onClick={onEdit}
              >
                {pending === "save" ? PENDING_TEXT.save : "Edit"}
              </button>
              {canReset && (
                <button
                  type="button"
                  className="trig-btn subtle"
                  disabled={busy}
                  title="Remove the serve override and use the workflow file's schedule"
                  onClick={() => setConfirming(true)}
                >
                  {pending === "reset" ? PENDING_TEXT.reset : "Reset"}
                </button>
              )}
            </>
          )}
      </div>
      <div className="sched-feedback-slot" aria-live="polite">
        {feedback && (
          <span
            className={`sched-feedback tone-${feedback.tone}`}
            role={feedback.tone === "danger" ? "alert" : undefined}
          >
            {feedback.text}
          </span>
        )}
      </div>
    </div>
  );
}
