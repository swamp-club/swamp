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

// Edit and reset a schedule through serve's `workflow.trigger.*` requests,
// with per-workflow pending state and the message to show beside the
// controls.

import { useCallback, useState } from "react";
import { useSwamp } from "./SwampProvider.tsx";
import { requestErrorInfo } from "./stream.ts";
import {
  type ScheduleAction,
  scheduleErrorMessage,
  type ScheduleFeedback,
  scheduleSuccessMessage,
} from "../lib/triggers.ts";

export interface ScheduleMutations {
  /** The action in flight per workflow. */
  pending: ReadonlyMap<string, ScheduleAction>;
  feedback: ReadonlyMap<string, ScheduleFeedback>;
  save: (
    workflowName: string,
    schedule: string,
    inputs: Record<string, unknown>,
  ) => Promise<string | null>;
  /** Removes the serve override so the workflow file's schedule applies. */
  reset: (workflowName: string) => Promise<boolean>;
  dismiss: (workflowName: string) => void;
}

function withEntry<K, V>(map: ReadonlyMap<K, V>, key: K, value: V | null) {
  const next = new Map(map);
  if (value === null) next.delete(key);
  else next.set(key, value);
  return next;
}

export function useScheduleMutations(
  onChanged?: (workflowName: string) => void,
): ScheduleMutations {
  const { request } = useSwamp();
  const [pending, setPending] = useState<ReadonlyMap<string, ScheduleAction>>(
    new Map(),
  );
  const [feedback, setFeedback] = useState<
    ReadonlyMap<string, ScheduleFeedback>
  >(new Map());

  const run = useCallback(
    async (
      workflowName: string,
      action: ScheduleAction,
      type: string,
      payload: Record<string, unknown>,
    ): Promise<string | null> => {
      setPending((m) => withEntry(m, workflowName, action));
      setFeedback((m) => withEntry(m, workflowName, null));
      try {
        await request(type, payload);
        setFeedback((m) =>
          withEntry(m, workflowName, {
            tone: "success",
            text: scheduleSuccessMessage(action),
          })
        );
        onChanged?.(workflowName);
        return null;
      } catch (err) {
        const text = scheduleErrorMessage(action, workflowName, {
          code: requestErrorInfo(err)?.code,
          message: err instanceof Error ? err.message : String(err),
        });
        setFeedback((m) =>
          withEntry(m, workflowName, { tone: "danger", text })
        );
        return text;
      } finally {
        setPending((m) => withEntry(m, workflowName, null));
      }
    },
    [request, onChanged],
  );

  const save = useCallback(
    (workflowName: string, schedule: string, inputs: Record<string, unknown>) =>
      run(workflowName, "save", "workflow.trigger.set", {
        workflowName,
        schedule,
        inputs,
      }),
    [run],
  );

  const reset = useCallback(
    async (workflowName: string) => {
      const error = await run(
        workflowName,
        "reset",
        "workflow.trigger.remove",
        { workflowName },
      );
      return error === null;
    },
    [run],
  );

  const dismiss = useCallback((workflowName: string) => {
    setFeedback((m) => withEntry(m, workflowName, null));
  }, []);

  return { pending, feedback, save, reset, dismiss };
}
