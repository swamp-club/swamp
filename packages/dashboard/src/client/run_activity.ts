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

// a run summary is re-read when serve starts or finishes a run or the tab comes
// back into view, not on a clock, so an idle open tab costs nothing; on a
// preset range also once when the oldest counted run leaves the window

export const RUN_ACTIVITY_REFETCH_MS = 30_000;

interface RunActivity {
  activityKey: string;
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

export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(tabVisible);
  useEffect(() => {
    const doc = tabDocument();
    if (!doc) return;
    const onChange = () => setVisible(tabVisible());
    doc.addEventListener("visibilitychange", onChange);
    return () => doc.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

export function RunActivityProvider(
  { activeRuns, children }: {
    activeRuns: readonly ActiveRunRef[] | undefined;
    children: ReactNode;
  },
) {
  const visible = useDocumentVisible();
  const activityKey = activeRunsKey(activeRuns);
  const value = useMemo(() => ({ activityKey, visible }), [
    activityKey,
    visible,
  ]);
  return createElement(RunActivityContext.Provider, { value }, children);
}

export function useTabVisible(): boolean {
  return useContext(RunActivityContext).visible;
}

export function visibleIntervalMs(
  intervalMs: number | null,
  visible: boolean,
): number | null {
  return visible ? intervalMs : null;
}

export function cameIntoView(previous: boolean, next: boolean): boolean {
  return !previous && next;
}

export function runActivityChanged(
  previous: RunActivity,
  next: RunActivity,
): boolean {
  return previous.activityKey !== next.activityKey ||
    cameIntoView(previous.visible, next.visible);
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

export function ageOutTimerStep(
  deadline: number,
  now: number,
  maxMs: number = MAX_TIMER_MS,
): AgeOutStep {
  if (now >= deadline) return { kind: "fire" };
  return { kind: "wait", waitMs: Math.min(deadline - now, maxMs) };
}

export interface AgeOut {
  answer: unknown;
  delayMs: number | null;
}

/**
 * pass `useRequest`'s `refresh`, which waits for a read still in flight: a read
 * slower than the throttle would otherwise never answer while runs keep
 * starting
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
 * throttle as `useRefetchOnRunActivity` but not on run activity. Pass
 * `useRequest`'s `refresh`, as there.
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
