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

// Pause, resume, edit and reset a schedule through serve's
// `workflow.trigger.*` requests, with per-workflow pending state and the
// message to show beside the controls. A pause or resume is reflected at
// once and held until the health stream agrees.

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
  /** The paused state to show: an unconfirmed change wins over `fromHealth`. */
  pausedOf: (workflowName: string, fromHealth: boolean | undefined) =>
    | boolean
    | undefined;
  setPaused: (workflowName: string, paused: boolean) => Promise<boolean>;
  save: (
    workflowName: string,
    schedule: string,
    inputs: Record<string, unknown>,
  ) => Promise<string | null>;
  /**
   * Removes the serve override so the workflow file's schedule applies.
   * `workflow.trigger.remove` drops the whole override, pause included (as
   * `swamp workflow trigger remove` does), so a paused schedule is paused
   * again right after: Reset never silently resumes it.
   */
  reset: (workflowName: string, paused: boolean) => Promise<boolean>;
  dismiss: (workflowName: string) => void;
  /** Drops unconfirmed pause states the health stream now agrees with. */
  sync: (
    entries: ReadonlyArray<{ workflowName: string; paused?: boolean }>,
  ) => void;
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
  const [optimistic, setOptimistic] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );

  const run = useCallback(
    async (
      workflowName: string,
      action: ScheduleAction,
      type: string,
      payload: Record<string, unknown>,
      followUp?: { type: string; payload: Record<string, unknown> },
    ): Promise<string | null> => {
      setPending((m) => withEntry(m, workflowName, action));
      setFeedback((m) => withEntry(m, workflowName, null));
      try {
        await request(type, payload);
        if (followUp) await request(followUp.type, followUp.payload);
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

  const setPaused = useCallback(
    async (workflowName: string, paused: boolean) => {
      const error = await run(
        workflowName,
        paused ? "pause" : "resume",
        "workflow.trigger.set",
        { workflowName, paused },
      );
      if (error === null) {
        setOptimistic((m) => withEntry(m, workflowName, paused));
      }
      return error === null;
    },
    [run],
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
    async (workflowName: string, paused: boolean) => {
      const error = await run(
        workflowName,
        "reset",
        "workflow.trigger.remove",
        { workflowName },
        paused
          ? {
            type: "workflow.trigger.set",
            payload: { workflowName, paused: true },
          }
          : undefined,
      );
      if (error === null) {
        setOptimistic((m) => withEntry(m, workflowName, paused));
      }
      return error === null;
    },
    [run],
  );

  const pausedOf = useCallback(
    (workflowName: string, fromHealth: boolean | undefined) => {
      const local = optimistic.get(workflowName);
      return local ?? fromHealth;
    },
    [optimistic],
  );

  const dismiss = useCallback((workflowName: string) => {
    setFeedback((m) => withEntry(m, workflowName, null));
  }, []);

  const sync = useCallback(
    (entries: ReadonlyArray<{ workflowName: string; paused?: boolean }>) => {
      setOptimistic((m) => {
        if (m.size === 0) return m;
        const health = new Map(entries.map((e) => [e.workflowName, e.paused]));
        const next = new Map(
          [...m].filter(([name, paused]) => health.get(name) !== paused),
        );
        return next.size === m.size ? m : next;
      });
    },
    [],
  );

  return {
    pending,
    feedback,
    pausedOf,
    setPaused,
    save,
    reset,
    dismiss,
    sync,
  };
}
