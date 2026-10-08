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

import { useState } from "react";
import { useSwamp } from "../client/SwampProvider";
import {
  type CancelOutcome,
  cancelOutcome,
  type CancelStep,
  nextCancelStep,
} from "./cancel_confirm";

interface CancelRunActionProps {
  runId: string;
  workflowName: string;
  /** The workflow's id when the row has one; its name otherwise. */
  workflowIdOrName?: string;
  /** Called once the cancel landed, with what it did. */
  onCancelled: (outcome: CancelOutcome) => void;
  /** Called when the cancel was refused, so the view can refetch. */
  onRefused?: () => void;
}

/**
 * Cancels a suspended run after a second click. Serve authorizes the cancel
 * on `run` access to the workflow, which a reader may lack, so a refusal is
 * shown beside the button.
 */
export function CancelRunAction(
  { runId, workflowName, workflowIdOrName, onCancelled, onRefused }:
    CancelRunActionProps,
) {
  const { request } = useSwamp();
  const [step, setStep] = useState<CancelStep>("idle");
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    if (nextCancelStep(step, "confirm") !== "cancelling") return;
    setStep("cancelling");
    setError(null);
    try {
      const reply = await request("workflow.cancel", {
        runId,
        workflowIdOrName: workflowIdOrName ?? workflowName,
      });
      onCancelled(cancelOutcome(workflowName, reply));
    } catch (err) {
      setError(
        `Cancel failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      onRefused?.();
    } finally {
      setStep((current) => nextCancelStep(current, "settled"));
    }
  };

  return (
    <div className="cancel-action">
      <div className="approval-actions">
        {step === "idle"
          ? (
            <button
              type="button"
              className="btn-sm btn-reject"
              onClick={() => setStep(nextCancelStep(step, "ask"))}
            >
              Cancel run
            </button>
          )
          : (
            <>
              <button
                type="button"
                className="btn-sm btn-reject"
                disabled={step === "cancelling"}
                onClick={handleConfirm}
              >
                {step === "cancelling" ? "Cancelling…" : "Confirm cancel"}
              </button>
              <button
                type="button"
                className="btn-sm"
                disabled={step === "cancelling"}
                onClick={() => setStep(nextCancelStep(step, "keep"))}
              >
                Keep
              </button>
            </>
          )}
      </div>
      {error && <div className="resume-error">{error}</div>}
    </div>
  );
}
