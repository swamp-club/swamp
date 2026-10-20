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
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type ActiveRunRef, activeRunsKey } from "./resume_state.ts";

// When a view's run summary is re-read. Not on a clock: only when serve
// starts or finishes a run, or when the tab comes back into view, so an
// open tab costs nothing while nothing happens (swamp-club#3444). On a
// preset range, also once when the oldest counted run leaves the window
// (swamp-club#3450).

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

/** Whether the tab is in view; true outside a `RunActivityProvider`. */
export function useTabVisible(): boolean {
  return useContext(RunActivityContext).visible;
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
 * How long until the oldest counted run leaves a preset window: its start
 * minus the window's start, both as serve resolved them, so the browser's
 * clock does not matter. Null without both times.
 */
export function ageOutDelayMs(
  since: string | undefined,
  oldestStartedAt: string | undefined,
): number | null {
  if (!since || !oldestStartedAt) return null;
  const sinceMs = Date.parse(since);
  const oldestMs = Date.parse(oldestStartedAt);
  if (Number.isNaN(sinceMs) || Number.isNaN(oldestMs)) return null;
  return Math.max(0, oldestMs - sinceMs);
}

/** The longest delay `setTimeout` keeps; a longer one fires at once. */
export const MAX_TIMER_MS = 2_147_483_647;

export type AgeOutStep = { kind: "fire" } | { kind: "wait"; waitMs: number };

/**
 * Whether an age-out deadline has come, or how long to wait before
 * looking again: never longer than a timer can hold, so a 30- or 90-day
 * window waits in steps instead of firing at once.
 */
export function ageOutTimerStep(
  deadline: number,
  now: number,
  maxMs: number = MAX_TIMER_MS,
): AgeOutStep {
  if (now >= deadline) return { kind: "fire" };
  return { kind: "wait", waitMs: Math.min(deadline - now, maxMs) };
}

/**
 * When an answer's oldest counted run leaves the window. `answer` is the
 * response it came from: each new answer arms the timer again, even with
 * the same delay. A null `delayMs` arms nothing.
 */
export interface AgeOut {
  answer: unknown;
  delayMs: number | null;
}

/**
 * Calls `refetch` when serve starts or finishes a run, or the tab comes
 * back into view, and once `ageOut`'s run leaves the window; at most once
 * per `RUN_ACTIVITY_REFETCH_MS`, and never while the tab is hidden. The
 * first load counts as a fetch.
 */
export function useRefetchOnRunActivity(
  refetch: () => void,
  enabled: boolean = true,
  ageOut?: AgeOut,
): void {
  useThrottledRefetch(refetch, enabled, true, ageOut);
}

/**
 * Calls `refetch` once `ageOut`'s run leaves the window, with the same
 * throttle as `useRefetchOnRunActivity` but not on run activity.
 */
export function useRefetchOnAgeOut(
  refetch: () => void,
  ageOut: AgeOut,
  enabled: boolean = true,
): void {
  useThrottledRefetch(refetch, enabled, false, ageOut);
}

function useThrottledRefetch(
  refetch: () => void,
  enabled: boolean,
  followActivity: boolean,
  ageOut: AgeOut | undefined,
): void {
  const activity = useContext(RunActivityContext);
  const latest = useRef(refetch);
  latest.current = refetch;
  const previous = useRef(activity);
  const state = useRef({ lastAt: Date.now(), pending: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sends a pending refetch now, or arms the throttle's timer for it.
  const schedule = useCallback(() => {
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
  }, []);

  useEffect(() => {
    const changed = runActivityChanged(previous.current, activity);
    previous.current = activity;
    if (!enabled) {
      state.current.pending = false;
      return;
    }
    if (changed && followActivity) state.current.pending = true;
    // Also sends an age-out refetch held while the tab was hidden.
    schedule();
  }, [activity, enabled, followActivity, schedule]);

  const answer = ageOut?.answer;
  const delayMs = ageOut?.delayMs ?? null;
  useEffect(() => {
    if (!enabled || delayMs === null) return;
    const deadline = Date.now() + delayMs;
    let handle: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      const step = ageOutTimerStep(deadline, Date.now());
      if (step.kind === "fire") {
        handle = null;
        state.current.pending = true;
        schedule();
      } else {
        handle = setTimeout(check, step.waitMs);
      }
    };
    check();
    return () => {
      if (handle !== null) clearTimeout(handle);
    };
  }, [answer, delayMs, enabled, schedule]);

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);
}
