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
  useMemo,
  useState,
} from "react";

// The dashboard-wide time window that run-based views (stats, pips,
// executions, calendars) look at. One window for every page, remembered
// per browser, so moving between pages keeps the same lens.

export type TimePreset = "1h" | "24h" | "7d" | "30d" | "90d" | "all";

export type TimeRange =
  | { kind: "preset"; preset: TimePreset }
  | { kind: "custom"; from: string; to: string };

export const TIME_PRESETS: ReadonlyArray<
  { preset: TimePreset; label: string }
> = [
  { preset: "1h", label: "1h" },
  { preset: "24h", label: "24h" },
  { preset: "7d", label: "7d" },
  { preset: "30d", label: "30d" },
  { preset: "90d", label: "90d" },
  { preset: "all", label: "All" },
];

const PRESET_MS: Record<Exclude<TimePreset, "all">, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  "90d": 90 * 86_400_000,
};

export const DEFAULT_TIME_RANGE: TimeRange = { kind: "preset", preset: "7d" };

/** The ISO bounds a range covers at `now`; `until` absent means "now". */
export function resolveTimeRange(
  range: TimeRange,
  now: number = Date.now(),
): { since?: string; until?: string } {
  if (range.kind === "custom") return { since: range.from, until: range.to };
  if (range.preset === "all") return {};
  return { since: new Date(now - PRESET_MS[range.preset]).toISOString() };
}

/**
 * The bounds to send serve for a range. A preset goes as a relative
 * duration (`since: "7d"`), which serve reads back from its own clock, so
 * the request is the same however long the page stays open.
 */
export function requestTimeBounds(
  range: TimeRange,
): { since?: string; until?: string } {
  if (range.kind === "custom") return { since: range.from, until: range.to };
  if (range.preset === "all") return {};
  return { since: range.preset };
}

/**
 * Whether a request's `since` is a duration back from serve's now (`1h`,
 * `7d`), so the window it names moves with the clock. An ISO time, or no
 * bound, stays put.
 */
export function isRelativeBound(since: string | undefined): boolean {
  return since !== undefined && /^\d+(mo|y|h|m|d|w)$/.test(since);
}

/** Short label for the picker button: "Last 7 days", "Oct 3 – Oct 9". */
export function describeTimeRange(range: TimeRange, locale?: string): string {
  if (range.kind === "preset") {
    switch (range.preset) {
      case "1h":
        return "Last hour";
      case "24h":
        return "Last 24 hours";
      case "7d":
        return "Last 7 days";
      case "30d":
        return "Last 30 days";
      case "90d":
        return "Last 90 days";
      case "all":
        return "All time";
    }
  }
  const from = new Date(range.from);
  const to = new Date(range.to);
  // A range of whole local days (00:00 to 23:59) reads as just its days.
  const wholeDays = from.getHours() === 0 && from.getMinutes() === 0 &&
    to.getHours() === 23 && to.getMinutes() === 59;
  const fmt = (d: Date) =>
    d.toLocaleString(locale, {
      month: "short",
      day: "numeric",
      ...(!wholeDays && { hour: "2-digit", minute: "2-digit" }),
    });
  if (
    wholeDays && from.getFullYear() === to.getFullYear() &&
    from.getMonth() === to.getMonth() && from.getDate() === to.getDate()
  ) {
    return fmt(from);
  }
  return `${fmt(from)} – ${fmt(to)}`;
}

const STORAGE_KEY = "swamp.dashboard.timeRange";

/** Parses a stored range, rejecting anything malformed. */
export function parseTimeRange(raw: string | null): TimeRange | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (
      v.kind === "preset" &&
      TIME_PRESETS.some((p) => p.preset === v.preset)
    ) {
      return { kind: "preset", preset: v.preset as TimePreset };
    }
    if (
      v.kind === "custom" && typeof v.from === "string" &&
      typeof v.to === "string" &&
      !Number.isNaN(Date.parse(v.from)) && !Number.isNaN(Date.parse(v.to)) &&
      Date.parse(v.from) < Date.parse(v.to)
    ) {
      return { kind: "custom", from: v.from, to: v.to };
    }
  } catch {
    // fall through
  }
  return null;
}

function readStored(): TimeRange {
  try {
    return parseTimeRange(localStorage.getItem(STORAGE_KEY)) ??
      DEFAULT_TIME_RANGE;
  } catch {
    return DEFAULT_TIME_RANGE;
  }
}

interface TimeRangeContextValue {
  range: TimeRange;
  setRange: (range: TimeRange) => void;
}

const TimeRangeContext = createContext<TimeRangeContextValue>({
  range: DEFAULT_TIME_RANGE,
  setRange: () => {},
});

export function TimeRangeProvider({ children }: { children: ReactNode }) {
  const [range, setRangeState] = useState<TimeRange>(readStored);
  const setRange = useCallback((next: TimeRange) => {
    setRangeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage blocked: the range lasts for this page load only.
    }
  }, []);
  const value = useMemo(() => ({ range, setRange }), [range, setRange]);
  return createElement(TimeRangeContext.Provider, { value }, children);
}

export function useTimeRange(): TimeRangeContextValue {
  return useContext(TimeRangeContext);
}

/**
 * The current range's ISO bounds, for work done here: calendars, chart
 * buckets and filtering rows. A preset's bounds move with the clock
 * (rounded down to the minute), so they must not key a request that only
 * accepts a relative bound; use `useRequestTimeBounds` for that.
 */
export function useTimeBounds(): { since?: string; until?: string } {
  const { range } = useTimeRange();
  const minute = Math.floor(Date.now() / 60_000) * 60_000;
  return useMemo(() => resolveTimeRange(range, minute), [range, minute]);
}

/**
 * The current range's bounds to send serve's run summary and run search.
 * Changes only when the range does.
 */
export function useRequestTimeBounds(): { since?: string; until?: string } {
  const { range } = useTimeRange();
  return useMemo(() => requestTimeBounds(range), [range]);
}
