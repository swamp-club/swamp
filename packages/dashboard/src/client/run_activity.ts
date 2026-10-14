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

import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type ActiveRunRef, activeRunsKey } from "./resume_state.ts";

// When a view's run summary is re-read. Not on a clock: only when serve
// starts or finishes a run, or when the tab comes back into view, so an
// open tab costs nothing while nothing happens (swamp-club#3444).

/** The least time between two activity refetches of one summary. */
export const RUN_ACTIVITY_REFETCH_MS = 30_000;

interface RunActivity {
  /** Changes only when a run starts or stops being driven. */
  activityKey: string;
  /** The tab is in view. */
  visible: boolean;
}

const RunActivityContext = createContext<RunActivity>({
  activityKey: "",
  visible: true,
});

interface VisibilityDocument {
  visibilityState?: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

function tabDocument(): VisibilityDocument | undefined {
  return (globalThis as { document?: VisibilityDocument }).document;
}

function tabVisible(): boolean {
  return tabDocument()?.visibilityState !== "hidden";
}

/** Shares the health snapshot's run activity and the tab's visibility. */
export function RunActivityProvider(
  { activeRuns, children }: {
    activeRuns: readonly ActiveRunRef[] | undefined;
    children: ReactNode;
  },
) {
  const [visible, setVisible] = useState(tabVisible);
  useEffect(() => {
    const doc = tabDocument();
    if (!doc) return;
    const onChange = () => setVisible(tabVisible());
    doc.addEventListener("visibilitychange", onChange);
    return () => doc.removeEventListener("visibilitychange", onChange);
  }, []);
  const activityKey = activeRunsKey(activeRuns);
  const value = useMemo(() => ({ activityKey, visible }), [
    activityKey,
    visible,
  ]);
  return createElement(RunActivityContext.Provider, { value }, children);
}

/**
 * Whether going from `previous` to `next` calls for a refetch: a run
 * started or stopped, or the tab came back into view.
 */
export function runActivityChanged(
  previous: RunActivity,
  next: RunActivity,
): boolean {
  return previous.activityKey !== next.activityKey ||
    (!previous.visible && next.visible);
}

export type RefetchStep =
  | { kind: "now" }
  | { kind: "at"; at: number }
  | { kind: "hold" }
  | { kind: "none" };

/**
 * What to do about a refetch: nothing without a pending change, hold it
 * while the tab is hidden, and otherwise send it now or once
 * `intervalMs` has passed since the last one, so a burst of changes costs
 * one refetch at the end of the window.
 */
export function nextRefetch(
  state: { lastAt: number; pending: boolean; visible: boolean },
  now: number,
  intervalMs: number = RUN_ACTIVITY_REFETCH_MS,
): RefetchStep {
  if (!state.pending) return { kind: "none" };
  if (!state.visible) return { kind: "hold" };
  const at = state.lastAt + intervalMs;
  return now >= at ? { kind: "now" } : { kind: "at", at };
}

/**
 * Calls `refetch` when serve starts or finishes a run, or the tab comes
 * back into view; at most once per `RUN_ACTIVITY_REFETCH_MS`, and never
 * while the tab is hidden. The first load counts as a fetch.
 */
export function useRefetchOnRunActivity(
  refetch: () => void,
  enabled: boolean = true,
): void {
  const activity = useContext(RunActivityContext);
  const latest = useRef(refetch);
  latest.current = refetch;
  const previous = useRef(activity);
  const state = useRef({ lastAt: Date.now(), pending: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const changed = runActivityChanged(previous.current, activity);
    previous.current = activity;
    if (!enabled) {
      state.current.pending = false;
      return;
    }
    if (changed) state.current.pending = true;
    const schedule = () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      const now = Date.now();
      const step = nextRefetch(
        { ...state.current, visible: previous.current.visible },
        now,
      );
      if (step.kind === "now") {
        state.current = { lastAt: now, pending: false };
        latest.current();
      } else if (step.kind === "at") {
        timer.current = setTimeout(schedule, step.at - now);
      }
    };
    schedule();
  }, [activity, enabled]);

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);
}
