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

import { type MouseEvent, useState } from "react";
import { useSwamp } from "../client/SwampProvider";
import { type ResumableRun, resumeStateFor } from "../client/resume_state";

interface ResumeActionProps {
  run: ResumableRun;
  onResumed?: () => void;
  /**
   * Serve reported that it is resuming this run itself (auto-resume). A
   * refetch can still see it suspended for a moment, so no Resume is offered.
   */
  resuming?: boolean;
}

/**
 * The resume control for an approved run: a Resume button, plus the CLI
 * command for anyone who cannot resume from here. Renders nothing for a run
 * that is not waiting for a resume.
 */
export function ResumeAction(
  { run, onResumed, resuming }: ResumeActionProps,
) {
  const { requestDetached } = useSwamp();
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = resumeStateFor(run);
  if (!state) return null;
  if (resuming) {
    return (
      <div className="resume-action">
        <span className="resume-label">Approved — serve is resuming</span>
      </div>
    );
  }

  const handleResume = async (e: MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    setError(null);
    try {
      await requestDetached("workflow.resume", {
        workflowIdOrName: run.workflowName,
        runId: run.runId,
      });
      setStarted(true);
      onResumed?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="resume-action" onClick={(e) => e.stopPropagation()}>
      <div className="resume-head">
        <span className="resume-label">Approved — awaiting resume</span>
        <button
          type="button"
          className="btn-sm btn-approve"
          disabled={busy || started}
          onClick={handleResume}
        >
          {busy || started ? "Resuming…" : "Resume"}
        </button>
      </div>
      {state.needsInputs && (
        <div className="resume-note">
          This workflow declares inputs. Resuming here supplies no new inputs;
          to supply them, run the command below.
        </div>
      )}
      <code className="resume-command mono">{state.command}</code>
      {error && <div className="resume-error">{error}</div>}
    </div>
  );
}
