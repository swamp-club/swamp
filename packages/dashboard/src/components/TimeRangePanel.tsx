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

/** @jsxRuntime automatic */
/** @jsxImportSource react */

// The time range picker's popover body: preset chips, a range calendar
// whose days carry a tiny success/failure bar, time inputs and
// Apply/Cancel. Pure presentation over props so it renders in tests;
// TimeRangePicker.tsx owns the popover, data fetching and styles.

import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import {
  TIME_PRESETS,
  type TimePreset,
  type TimeRange,
} from "../client/time_range.ts";
import {
  addMonths,
  compareMonths,
  dayBar,
  type DayKey,
  type DaySelection,
  type DayStats,
  describeDay,
  describeSelection,
  formatDayKey,
  formatMonth,
  isDayNavKey,
  localDayKey,
  makeDayKey,
  monthGrid,
  monthMaxRuns,
  monthOf,
  type MonthRef,
  monthsToShow,
  moveDay,
  previewSpan,
  rangeToSelection,
  selectDay,
  selectionToRange,
} from "../lib/calendar.ts";

const PRESET_NAMES: Record<TimePreset, string> = {
  "1h": "Last hour",
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "all": "All time",
};

export interface TimeRangePanelProps {
  range: TimeRange;
  /** The current range's resolved bounds, to show a preset's days. */
  bounds: { since?: string; until?: string };
  now: number;
  /** The first visible month and how many are shown side by side. */
  firstMonth: MonthRef;
  monthCount: number;
  onFirstMonthChange: (month: MonthRef) => void;
  /** Runs per local day over the visible months; null while unknown. */
  stats: ReadonlyMap<DayKey, DayStats> | null;
  statsLoading: boolean;
  /** The server could not supply run history (e.g. an older serve). */
  statsUnavailable: boolean;
  onApply: (range: TimeRange) => void;
  onCancel: () => void;
  /** Move focus to the focused day on mount. */
  autoFocus?: boolean;
  /**
   * Moves DOM focus to a day's button (`[data-day="YYYY-MM-DD"]`); the
   * popover supplies it so this component stays free of DOM calls.
   */
  focusDay?: (key: DayKey) => void;
  locale?: string;
  /** Prefix for element ids, unique per picker. */
  idPrefix?: string;
}

function weekdayNames(locale?: string): Array<{ short: string; long: string }> {
  // 2026-01-04 is a Sunday.
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 0, 4 + i));
    return {
      short: d.toLocaleDateString(locale, {
        weekday: "narrow",
        timeZone: "UTC",
      }),
      long: d.toLocaleDateString(locale, { weekday: "long", timeZone: "UTC" }),
    };
  });
}

/** An input's value, typed without the DOM lib (tests run without it). */
function inputValue(target: unknown): string {
  return String((target as { value?: unknown }).value ?? "");
}

function isVisible(key: DayKey, first: MonthRef, count: number): boolean {
  const m = monthOf(key);
  return compareMonths(m, first) >= 0 &&
    compareMonths(m, addMonths(first, count - 1)) <= 0;
}

export function TimeRangePanel(props: TimeRangePanelProps) {
  const {
    range,
    bounds,
    now,
    firstMonth,
    monthCount,
    onFirstMonthChange,
    stats,
    statsLoading,
    statsUnavailable,
    onApply,
    onCancel,
    autoFocus,
    focusDay,
    locale,
    idPrefix = "trp",
  } = props;
  const today = localDayKey(new Date(now));
  // The panel mounts each time the popover opens, so the range it shows
  // is read once.
  const [initial] = useState(() => rangeToSelection(range, bounds, now));
  const [selection, setSelection] = useState<DaySelection>(initial.selection);
  const [startTime, setStartTime] = useState(initial.startTime);
  const [endTime, setEndTime] = useState(initial.endTime);
  const [hover, setHover] = useState<DayKey | null>(null);
  const [focused, setFocused] = useState<DayKey>(() => {
    const k = initial.selection.end ?? initial.selection.start ?? today;
    return k > today ? today : k;
  });
  // Bumped by keyboard navigation so the newly focused day takes focus.
  const [focusRequest, setFocusRequest] = useState(autoFocus ? 1 : 0);

  // A month change from the arrow buttons can leave the focused day out of
  // view; the grid's tab stop then falls on the first visible day.
  const tabStop = isVisible(focused, firstMonth, monthCount)
    ? focused
    : (() => {
      const first = makeDayKey(firstMonth.year, firstMonth.month, 1);
      return first > today ? today : first;
    })();

  useEffect(() => {
    if (focusRequest !== 0) focusDay?.(tabStop);
    // Only a new request moves focus; re-renders must not steal it.
  }, [focusRequest]);

  const months = Array.from(
    { length: monthCount },
    (_, i) => addMonths(firstMonth, i),
  );
  const span = previewSpan(selection, hover);
  const result = selectionToRange(selection, startTime, endTime);
  const lastMonth = addMonths(firstMonth, monthCount - 1);
  const atLatest = compareMonths(lastMonth, monthOf(today)) >= 0;
  const weekdays = useMemo(() => weekdayNames(locale), [locale]);

  const pick = (key: DayKey) => {
    if (key > today) return;
    setSelection((sel) => selectDay(sel, key));
    setFocused(key);
    setHover(null);
  };

  const onGridKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!isDayNavKey(e.key)) return;
    e.preventDefault();
    const next = moveDay(tabStop, e.key, today);
    setFocused(next);
    if (selection.start !== null && selection.end === null) setHover(next);
    const shown = monthsToShow(firstMonth, monthCount, next);
    if (compareMonths(shown, firstMonth) !== 0) onFirstMonthChange(shown);
    setFocusRequest((n) => n + 1);
  };

  const status = selection.start !== null && !result.ok
    ? result.error
    : describeSelection(selection, locale);

  const activePreset = range.kind === "preset" ? range.preset : null;

  return (
    <div className="trp-panel">
      <div className="trp-presets" role="group" aria-label="Quick ranges">
        <span className="trp-section-label" aria-hidden="true">
          Quick ranges
        </span>
        {TIME_PRESETS.map((p) => (
          <button
            type="button"
            key={p.preset}
            className={`trp-chip${activePreset === p.preset ? " active" : ""}`}
            aria-pressed={activePreset === p.preset}
            onClick={() => onApply({ kind: "preset", preset: p.preset })}
          >
            {PRESET_NAMES[p.preset]}
          </button>
        ))}
      </div>

      <div className="trp-custom">
        <div className="trp-nav">
          <button
            type="button"
            className="trp-icon-button"
            aria-label="Previous month"
            onClick={() => onFirstMonthChange(addMonths(firstMonth, -1))}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M10 3L5 8l5 5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            className="trp-icon-button"
            aria-label="Next month"
            disabled={atLatest}
            onClick={() => onFirstMonthChange(addMonths(firstMonth, 1))}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M6 3l5 5-5 5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        <div className="trp-months" onMouseLeave={() => setHover(null)}>
          {months.map((month) => {
            const monthId = `${idPrefix}-m-${month.year}-${month.month}`;
            const max = stats ? monthMaxRuns(stats, month) : 0;
            return (
              <div className="trp-month" key={monthId}>
                <div className="trp-month-title" id={monthId}>
                  {formatMonth(month, locale)}
                </div>
                <table
                  role="grid"
                  className="trp-grid"
                  aria-labelledby={monthId}
                  aria-busy={statsLoading || undefined}
                  onKeyDown={onGridKeyDown}
                >
                  <thead>
                    <tr>
                      {weekdays.map((w) => (
                        <th scope="col" key={w.long} abbr={w.long}>
                          {w.short}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {monthGrid(month).map((week, wi) => (
                      <tr key={wi}>
                        {week.map((key, di) =>
                          key === null
                            ? <td key={di} className="trp-pad" />
                            : (
                              <DayCell
                                key={key}
                                dayKey={key}
                                today={today}
                                span={span}
                                selection={selection}
                                tabStop={tabStop}
                                stats={stats?.get(key)}
                                max={max}
                                loading={statsLoading && stats === null}
                                locale={locale}
                                onPick={pick}
                                onHover={(k) => {
                                  if (
                                    selection.start !== null &&
                                    selection.end === null
                                  ) setHover(k);
                                }}
                              />
                            )
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>

        <div className="trp-legend">
          {statsUnavailable
            ? (
              <span className="trp-legend-note">
                Daily run history isn't available from this server.
              </span>
            )
            : (
              <>
                <span className="trp-swatch trp-swatch-ok" />Succeeded
                <span className="trp-swatch trp-swatch-failed" />Failed
                <span className="trp-swatch trp-swatch-cancelled" />Cancelled
                <span className="trp-legend-note">
                  Bar height: runs that day
                </span>
              </>
            )}
        </div>

        <div className="trp-times">
          <label className="trp-time">
            <span>
              From{" "}
              <strong>
                {selection.start ? formatDayKey(selection.start, locale) : "—"}
              </strong>
            </span>
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(inputValue(e.target))}
              aria-label="Start time"
            />
          </label>
          <label className="trp-time">
            <span>
              To{" "}
              <strong>
                {selection.start
                  ? formatDayKey(selection.end ?? selection.start, locale)
                  : "—"}
              </strong>
            </span>
            <input
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(inputValue(e.target))}
              aria-label="End time"
            />
          </label>
        </div>

        <div className="trp-footer">
          <p
            className={`trp-status${
              selection.start !== null && !result.ok ? " trp-status-error" : ""
            }`}
            aria-live="polite"
          >
            {status}
          </p>
          <div className="trp-actions">
            <button type="button" className="trp-button" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="trp-button trp-button-primary"
              disabled={!result.ok}
              onClick={() => {
                if (result.ok) onApply(result.range);
              }}
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface DayCellProps {
  dayKey: DayKey;
  today: DayKey;
  span: { start: DayKey; end: DayKey } | null;
  selection: DaySelection;
  tabStop: DayKey;
  stats: DayStats | undefined;
  max: number;
  loading: boolean;
  locale?: string;
  onPick: (key: DayKey) => void;
  onHover: (key: DayKey) => void;
}

function DayCell(
  {
    dayKey,
    today,
    span,
    selection,
    tabStop,
    stats,
    max,
    loading,
    locale,
    onPick,
    onHover,
  }: DayCellProps,
) {
  const future = dayKey > today;
  const inSpan = span !== null && dayKey >= span.start && dayKey <= span.end;
  const isStart = span !== null && dayKey === span.start;
  const isEnd = span !== null && dayKey === span.end;
  const isEndpoint = dayKey === selection.start || dayKey === selection.end;
  const bar = dayBar(stats, max);
  const failed = (stats?.failed ?? 0) > 0;
  const classes = [
    "trp-cell",
    inSpan && "in-span",
    isStart && "span-start",
    isEnd && "span-end",
  ].filter(Boolean).join(" ");
  const dayClasses = [
    "trp-day",
    dayKey === today && "is-today",
    isEndpoint && "is-endpoint",
    future && "is-future",
    failed && "has-failures",
  ].filter(Boolean).join(" ");
  const label = `${describeDay(dayKey, stats, locale)}${
    dayKey === today ? " (today)" : ""
  }`;

  return (
    <td role="gridcell" className={classes} aria-selected={inSpan}>
      <button
        type="button"
        className={dayClasses}
        data-day={dayKey}
        tabIndex={dayKey === tabStop ? 0 : -1}
        aria-label={label}
        aria-disabled={future || undefined}
        onClick={() => onPick(dayKey)}
        onMouseEnter={() => !future && onHover(dayKey)}
        onFocus={() => !future && onHover(dayKey)}
      >
        <span className="trp-num" aria-hidden="true">
          {Number(dayKey.slice(8))}
        </span>
        <span className="trp-bar" aria-hidden="true">
          {loading && !future
            ? <span className="skel trp-skel" />
            : bar.total > 0 && (
              <span
                className="trp-stack"
                style={{ height: `${Math.round(bar.total * 100)}%` }}
              >
                {bar.failed > 0 && (
                  <span
                    className="trp-seg trp-seg-failed"
                    style={{ flexGrow: bar.failed }}
                  />
                )}
                {bar.cancelled > 0 && (
                  <span
                    className="trp-seg trp-seg-cancelled"
                    style={{ flexGrow: bar.cancelled }}
                  />
                )}
                {bar.succeeded > 0 && (
                  <span
                    className="trp-seg trp-seg-ok"
                    style={{ flexGrow: bar.succeeded }}
                  />
                )}
              </span>
            )}
        </span>
      </button>
    </td>
  );
}

/** The trigger button's face: icon, current range, chevron. */
export function TimeRangeButtonContent({ label }: { label: string }) {
  return (
    <>
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <rect x="2" y="3" width="12" height="11" rx="2" />
        <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" />
      </svg>
      <span className="trp-trigger-label">{label}</span>
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        aria-hidden="true"
        className="trp-chevron"
      >
        <path
          d="M2 3.5l3 3 3-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </>
  );
}
