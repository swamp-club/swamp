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

import { useEffect, useId, useRef, useState } from "react";
import { useRequest } from "../client/useRequest";
import { extractObject } from "../client/extract";
import type { ScheduleMutations } from "../client/schedule_mutations.ts";
import { ScheduleEditorForm } from "../components/ScheduleEditorForm.tsx";
import { Skeleton, SkeletonRegion } from "../components/Skeleton.tsx";
import { isDeniedCode } from "../lib/triggers.ts";

/** `workflow.trigger.get`: the schedule from the file, the override, and what applies. */
export interface TriggerInfo {
  workflowName: string;
  builtIn: { schedule: string | null; inputs: Record<string, unknown> } | null;
  override: {
    schedule?: string;
    inputs?: Record<string, unknown>;
    paused?: boolean;
  } | null;
  effective: {
    schedule: string | null;
    inputs: Record<string, unknown>;
    paused?: boolean;
  };
}

/**
 * The schedule editor as a modal dialog. Loads the effective schedule and
 * inputs, saves both together with `workflow.trigger.set`, and closes once
 * the change landed; a refusal stays in the dialog.
 */
export function ScheduleEditDialog(
  { workflowName, mutations, onClose, onSaved, timeZone }: {
    workflowName: string;
    mutations: ScheduleMutations;
    /** Serve's scheduler time zone, for the preview. */
    timeZone?: string;
    onClose: () => void;
    onSaved?: () => void;
  },
) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { data, error, errorInfo } = useRequest("workflow.trigger.get", {
    workflowName,
  });
  const trigger = extractObject<TriggerInfo>(data);
  const saving = mutations.pending.get(workflowName) === "save";
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  const close = () => {
    if (!saving) onClose();
  };

  const save = async (schedule: string, inputs: Record<string, unknown>) => {
    setSaveError(null);
    const failure = await mutations.save(workflowName, schedule, inputs);
    if (failure === null) {
      onSaved?.();
      onClose();
    } else {
      // The refusal belongs in the dialog, not also beside the row.
      mutations.dismiss(workflowName);
      setSaveError(failure);
    }
  };

  return (
    <dialog
      ref={ref}
      className="sched-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onKeyDown={(e) => {
        // Escape closes the dialog, not the page behind it.
        if (e.key === "Escape") e.stopPropagation();
      }}
      onClick={(e) => {
        if (e.target === ref.current) close();
      }}
    >
      <div className="sched-dialog-head">
        <div>
          <h2 id={titleId}>Edit schedule</h2>
          <p className="mono">{workflowName}</p>
        </div>
        <button
          type="button"
          className="sched-dialog-close"
          aria-label="Close"
          disabled={saving}
          onClick={close}
        >
          ×
        </button>
      </div>
      <div className="sched-dialog-body">
        {error
          ? (
            <div className="notice notice-danger" role="alert">
              {isDeniedCode(errorInfo?.code)
                ? `You don't have permission to read the schedule of ${workflowName}.`
                : `Couldn't load the schedule: ${error}`}
            </div>
          )
          : !trigger
          ? (
            <SkeletonRegion label="Loading schedule">
              <div className="sched-form">
                <Skeleton height={36} radius={6} />
                <Skeleton width="70%" height={20} radius={999} />
                <Skeleton height={110} radius={6} />
                <Skeleton height={120} radius={6} />
              </div>
            </SkeletonRegion>
          )
          : (
            <ScheduleEditorForm
              workflowName={workflowName}
              initialSchedule={trigger.effective.schedule ?? ""}
              initialInputs={trigger.effective.inputs ?? {}}
              builtInSchedule={trigger.builtIn?.schedule}
              saving={saving}
              error={saveError}
              onSave={(schedule, inputs) => void save(schedule, inputs)}
              onCancel={close}
              timeZone={timeZone}
            />
          )}
      </div>
    </dialog>
  );
}
