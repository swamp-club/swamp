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

// The dashboard-wide time range picker: a button naming the current
// window that opens a dialog with presets and a calendar. Calendar days
// show that day's run outcomes, fetched for the visible months only.

import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  describeTimeRange,
  type TimeRange,
  useTimeBounds,
  useTimeRange,
} from "../client/time_range.ts";
import { useRunSummary } from "../client/run_summary.ts";
import {
  addMonths,
  bucketByDay,
  localDayKey,
  monthOf,
  type MonthRef,
  monthsWindow,
  rangeToSelection,
} from "../lib/calendar.ts";
import { TimeRangeButtonContent, TimeRangePanel } from "./TimeRangePanel.tsx";
import "../styles/time-range.css";

const TWO_MONTHS_QUERY = "(min-width: 1180px)";

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    globalThis.matchMedia?.(query).matches ?? true
  );
  useEffect(() => {
    const mql = globalThis.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), [tabindex="0"], a[href]';

export function TimeRangePicker() {
  const { range, setRange } = useTimeRange();
  const bounds = useTimeBounds();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const monthCount = useMediaQuery(TWO_MONTHS_QUERY) ? 2 : 1;
  const [firstMonth, setFirstMonth] = useState<MonthRef>(() =>
    monthOf(localDayKey(new Date()))
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const dialogId = `${id}-dialog`;

  // Opening shows the months ending at the range's last day (or today).
  const openPicker = useCallback(() => {
    const t = Date.now();
    const sel = rangeToSelection(range, bounds, t).selection;
    const end = sel.end ?? localDayKey(new Date(t));
    setNow(t);
    setFirstMonth(addMonths(monthOf(end), -(monthCount - 1)));
    setOpen(true);
  }, [range, bounds, monthCount]);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // Clicking outside closes without applying.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);

  const visibleWindow = useMemo(
    () => monthsWindow(firstMonth, monthCount),
    [firstMonth, monthCount],
  );
  const { summary, loading, error } = useRunSummary(
    {
      timeline: true,
      recentLimit: 0,
      since: visibleWindow.since,
      until: visibleWindow.until,
    },
    { enabled: open },
  );
  const stats = useMemo(
    () => (summary?.timeline ? bucketByDay(summary.timeline) : null),
    [summary],
  );

  const apply = (next: TimeRange) => {
    setRange(next);
    close(true);
  };

  const onDialogKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      // Keep the app's Escape (leave a detail page) from also firing.
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key !== "Tab" || !dialogRef.current) return;
    const items = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const focusDay = useCallback((key: string) => {
    dialogRef.current
      ?.querySelector<HTMLElement>(`[data-day="${key}"]`)
      ?.focus();
  }, []);

  const label = describeTimeRange(range);

  return (
    <div className="trp" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`trp-trigger${open ? " open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        aria-label={`Time range: ${label}`}
        title="Change the time range for runs and stats"
        onClick={() => (open ? close(false) : openPicker())}
      >
        <TimeRangeButtonContent label={label} />
      </button>
      {open && (
        <div
          ref={dialogRef}
          id={dialogId}
          className="trp-popover"
          role="dialog"
          aria-modal="true"
          aria-label="Choose a time range"
          onKeyDown={onDialogKeyDown}
        >
          <TimeRangePanel
            range={range}
            bounds={bounds}
            now={now}
            firstMonth={firstMonth}
            monthCount={monthCount}
            onFirstMonthChange={setFirstMonth}
            stats={stats}
            statsLoading={loading}
            statsUnavailable={!loading && error !== null}
            onApply={apply}
            onCancel={() => close(true)}
            autoFocus
            focusDay={focusDay}
            idPrefix={id}
          />
        </div>
      )}
    </div>
  );
}
