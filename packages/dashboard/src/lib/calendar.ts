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

// Calendar arithmetic for the time range picker. Days are "YYYY-MM-DD"
// keys in the viewer's calendar; arithmetic on keys runs in UTC so a DST
// change never shifts a day. Only converting between a key and an instant
// involves a time zone.

import type { TimeRange } from "../client/time_range.ts";

/** A calendar day, "YYYY-MM-DD". Keys sort chronologically as strings. */
export type DayKey = string;

/** A calendar month; `month` is 0-11. */
export interface MonthRef {
  year: number;
  month: number;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** The key of a year/month(0-11)/day, normalizing overflow (Jan 32 → Feb 1). */
export function makeDayKey(year: number, month: number, day: number): DayKey {
  const d = new Date(Date.UTC(year, month, day));
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${
    pad(d.getUTCDate())
  }`;
}

export function parseDayKey(
  key: DayKey,
): { year: number; month: number; day: number } {
  const [y, m, d] = key.split("-").map(Number);
  return { year: y, month: m - 1, day: d };
}

/** The local calendar day of an instant. */
export function localDayKey(date: Date): DayKey {
  return makeDayKey(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Maps instants to day keys in `timeZone` (the viewer's zone when omitted).
 * One formatter is built per call so bucketing thousands of hours stays
 * cheap.
 */
export function dayKeyFormatter(timeZone?: string): (iso: string) => DayKey {
  if (!timeZone) return (iso) => localDayKey(new Date(iso));
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  return (iso) => {
    const parts = fmt.formatToParts(new Date(iso));
    const get = (type: string) =>
      Number(parts.find((p) => p.type === type)?.value);
    return makeDayKey(get("year"), get("month") - 1, get("day"));
  };
}

export function addDays(key: DayKey, n: number): DayKey {
  const { year, month, day } = parseDayKey(key);
  return makeDayKey(year, month, day + n);
}

/** Day of week, 0 = Sunday. */
export function dayOfWeek(key: DayKey): number {
  const { year, month, day } = parseDayKey(key);
  return new Date(Date.UTC(year, month, day)).getUTCDay();
}

export function daysInMonth(ref: MonthRef): number {
  return new Date(Date.UTC(ref.year, ref.month + 1, 0)).getUTCDate();
}

export function monthOf(key: DayKey): MonthRef {
  const { year, month } = parseDayKey(key);
  return { year, month };
}

export function addMonths(ref: MonthRef, n: number): MonthRef {
  const total = ref.year * 12 + ref.month + n;
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
}

export function compareMonths(a: MonthRef, b: MonthRef): number {
  return (a.year * 12 + a.month) - (b.year * 12 + b.month);
}

/**
 * The weeks of a month, each seven slots long; slots outside the month
 * are null.
 */
export function monthGrid(
  ref: MonthRef,
  weekStartsOn = 0,
): Array<Array<DayKey | null>> {
  const first = makeDayKey(ref.year, ref.month, 1);
  const lead = (dayOfWeek(first) - weekStartsOn + 7) % 7;
  const total = daysInMonth(ref);
  const weeks: Array<Array<DayKey | null>> = [];
  let week: Array<DayKey | null> = Array(lead).fill(null);
  for (let d = 1; d <= total; d++) {
    week.push(makeDayKey(ref.year, ref.month, d));
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length > 0) {
    weeks.push([...week, ...Array(7 - week.length).fill(null)]);
  }
  return weeks;
}

/**
 * The instants bounding `count` months from `first`, at local midnight,
 * for fetching a calendar's own data window.
 */
export function monthsWindow(
  first: MonthRef,
  count: number,
): { since: string; until: string } {
  return {
    since: new Date(first.year, first.month, 1).toISOString(),
    until: new Date(first.year, first.month + count, 1).toISOString(),
  };
}

// ── Per-day run stats ──

export interface DayStats {
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

interface HourBucket {
  start: string;
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

/**
 * Folds hourly UTC buckets into calendar days. A bucket counts toward the
 * day its hour starts in, so in a zone offset by a half hour the runs of a
 * bucket straddling midnight land on the earlier day.
 */
export function bucketByDay(
  buckets: ReadonlyArray<HourBucket>,
  keyOf: (iso: string) => DayKey = dayKeyFormatter(),
): Map<DayKey, DayStats> {
  const days = new Map<DayKey, DayStats>();
  for (const b of buckets) {
    if (Number.isNaN(Date.parse(b.start))) continue;
    const key = keyOf(b.start);
    const day = days.get(key) ??
      { runs: 0, succeeded: 0, failed: 0, cancelled: 0 };
    day.runs += b.runs;
    day.succeeded += b.succeeded;
    day.failed += b.failed;
    day.cancelled += b.cancelled;
    days.set(key, day);
  }
  return days;
}

/** The busiest day's run count among a month's days (0 when idle). */
export function monthMaxRuns(
  days: ReadonlyMap<DayKey, DayStats>,
  ref: MonthRef,
): number {
  let max = 0;
  const prefix = makeDayKey(ref.year, ref.month, 1).slice(0, 8);
  for (const [key, stats] of days) {
    if (key.startsWith(prefix) && stats.runs > max) max = stats.runs;
  }
  return max;
}

/**
 * Heights (0-1 of the day's bar area) of the stacked segments, scaled to
 * the busiest day so a quiet day reads as a short bar. Any failure gets a
 * visible sliver so an incident on a busy day is never rounded away.
 */
export function dayBar(
  stats: DayStats | undefined,
  max: number,
  minFailedShare = 0.18,
): { total: number; succeeded: number; failed: number; cancelled: number } {
  if (!stats || stats.runs <= 0 || max <= 0) {
    return { total: 0, succeeded: 0, failed: 0, cancelled: 0 };
  }
  // A square-root scale keeps quiet days visible next to a spike.
  const total = Math.max(0.2, Math.sqrt(stats.runs / max));
  const share = (n: number) => n / stats.runs;
  let failed = share(stats.failed);
  if (stats.failed > 0) failed = Math.max(failed, minFailedShare);
  const cancelled = Math.min(share(stats.cancelled), 1 - failed);
  const succeeded = Math.max(0, 1 - failed - cancelled);
  return {
    total,
    succeeded: succeeded * total,
    failed: failed * total,
    cancelled: cancelled * total,
  };
}

const MONTH_DAY: Record<string, Intl.DateTimeFormat> = {};

function monthDayFormat(locale?: string): Intl.DateTimeFormat {
  const k = locale ?? "";
  MONTH_DAY[k] ??= new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return MONTH_DAY[k];
}

/** "Oct 3". */
export function formatDayKey(key: DayKey, locale?: string): string {
  const { year, month, day } = parseDayKey(key);
  return monthDayFormat(locale).format(new Date(Date.UTC(year, month, day)));
}

/** "October 2026". */
export function formatMonth(ref: MonthRef, locale?: string): string {
  return new Date(Date.UTC(ref.year, ref.month, 1)).toLocaleDateString(
    locale,
    { month: "long", year: "numeric", timeZone: "UTC" },
  );
}

/** "Oct 3: 120 runs, 4 failed" — the accessible name of a day cell. */
export function describeDay(
  key: DayKey,
  stats: DayStats | undefined,
  locale?: string,
): string {
  const day = formatDayKey(key, locale);
  if (!stats || stats.runs === 0) return `${day}: no runs`;
  const parts = [
    `${stats.runs.toLocaleString(locale)} ${stats.runs === 1 ? "run" : "runs"}`,
  ];
  if (stats.failed > 0) {
    parts.push(`${stats.failed.toLocaleString(locale)} failed`);
  }
  if (stats.cancelled > 0) {
    parts.push(`${stats.cancelled.toLocaleString(locale)} cancelled`);
  }
  return `${day}: ${parts.join(", ")}`;
}

// ── Range selection ──

/** A selection in progress: a start day, and an end once one is picked. */
export interface DaySelection {
  start: DayKey | null;
  end: DayKey | null;
}

/**
 * Clicking a day: the first click sets the start, the second sets the end
 * (swapping if it is earlier), and a third starts over.
 */
export function selectDay(sel: DaySelection, key: DayKey): DaySelection {
  if (sel.start === null || sel.end !== null) return { start: key, end: null };
  return key < sel.start
    ? { start: key, end: sel.start }
    : { start: sel.start, end: key };
}

/**
 * The span to highlight: the chosen range, or, while only a start is
 * picked, the span from it to the hovered day.
 */
export function previewSpan(
  sel: DaySelection,
  hover: DayKey | null,
): { start: DayKey; end: DayKey } | null {
  if (sel.start === null) return null;
  const end = sel.end ?? hover ?? sel.start;
  return end < sel.start
    ? { start: end, end: sel.start }
    : { start: sel.start, end };
}

export type DayNavKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "ArrowDown"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown";

export function isDayNavKey(key: string): key is DayNavKey {
  return [
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
    "PageUp",
    "PageDown",
  ].includes(key);
}

/**
 * The day keyboard focus moves to: arrows by a day or a week, Home/End to
 * the week's edges, PageUp/PageDown by a month (keeping the day where the
 * month allows). Never past `latest` (today).
 */
export function moveDay(
  key: DayKey,
  nav: DayNavKey,
  latest: DayKey,
  weekStartsOn = 0,
): DayKey {
  let next: DayKey;
  switch (nav) {
    case "ArrowLeft":
      next = addDays(key, -1);
      break;
    case "ArrowRight":
      next = addDays(key, 1);
      break;
    case "ArrowUp":
      next = addDays(key, -7);
      break;
    case "ArrowDown":
      next = addDays(key, 7);
      break;
    case "Home":
      next = addDays(key, -((dayOfWeek(key) - weekStartsOn + 7) % 7));
      break;
    case "End":
      next = addDays(key, 6 - ((dayOfWeek(key) - weekStartsOn + 7) % 7));
      break;
    case "PageUp":
    case "PageDown": {
      const { year, month, day } = parseDayKey(key);
      const target = addMonths({ year, month }, nav === "PageUp" ? -1 : 1);
      next = makeDayKey(
        target.year,
        target.month,
        Math.min(day, daysInMonth(target)),
      );
      break;
    }
  }
  return next > latest ? latest : next;
}

/**
 * Keeps `focus` inside the `count` months shown from `first`, paging the
 * calendar when it moves out.
 */
export function monthsToShow(
  first: MonthRef,
  count: number,
  focus: DayKey,
): MonthRef {
  const f = monthOf(focus);
  if (compareMonths(f, first) < 0) return f;
  const last = addMonths(first, count - 1);
  if (compareMonths(f, last) > 0) return addMonths(f, -(count - 1));
  return first;
}

// ── Converting between selections and time ranges ──

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A local day at "HH:MM". */
export function localInstant(key: DayKey, time: string): Date {
  const { year, month, day } = parseDayKey(key);
  const m = TIME_RE.exec(time);
  const hh = m ? Number(m[1]) : 0;
  const mm = m ? Number(m[2]) : 0;
  return new Date(year, month, day, hh, mm, 0, 0);
}

export const DEFAULT_START_TIME = "00:00";
export const DEFAULT_END_TIME = "23:59";

/**
 * The custom range a selection describes. The end time includes its whole
 * minute, so the default 00:00–23:59 covers whole days. A single picked
 * day is a one-day range.
 */
export function selectionToRange(
  sel: DaySelection,
  startTime: string,
  endTime: string,
): { ok: true; range: TimeRange } | { ok: false; error: string } {
  if (sel.start === null) return { ok: false, error: "Pick a start day" };
  if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) {
    return { ok: false, error: "Enter times as HH:MM" };
  }
  const from = localInstant(sel.start, startTime);
  const to = new Date(
    localInstant(sel.end ?? sel.start, endTime).getTime() + 59_999,
  );
  if (to.getTime() <= from.getTime()) {
    return { ok: false, error: "The end must be after the start" };
  }
  return {
    ok: true,
    range: { kind: "custom", from: from.toISOString(), to: to.toISOString() },
  };
}

function hhmm(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The calendar state that shows `range`: the custom range's days and
 * times, or the days a preset currently covers.
 */
export function rangeToSelection(
  range: TimeRange,
  bounds: { since?: string; until?: string },
  now: number = Date.now(),
): { selection: DaySelection; startTime: string; endTime: string } {
  if (range.kind === "custom") {
    const from = new Date(range.from);
    const to = new Date(range.to);
    return {
      selection: { start: localDayKey(from), end: localDayKey(to) },
      startTime: hhmm(from),
      endTime: hhmm(to),
    };
  }
  if (!bounds.since) {
    return {
      selection: { start: null, end: null },
      startTime: DEFAULT_START_TIME,
      endTime: DEFAULT_END_TIME,
    };
  }
  return {
    selection: {
      start: localDayKey(new Date(bounds.since)),
      end: localDayKey(new Date(bounds.until ?? now)),
    },
    startTime: DEFAULT_START_TIME,
    endTime: DEFAULT_END_TIME,
  };
}

/** "Oct 3 – Oct 9", "Oct 3", or a prompt while nothing is picked. */
export function describeSelection(
  sel: DaySelection,
  locale?: string,
): string {
  if (sel.start === null) return "Pick a start day";
  if (sel.end === null) {
    return `${formatDayKey(sel.start, locale)} – pick an end day`;
  }
  if (sel.end === sel.start) return formatDayKey(sel.start, locale);
  return `${formatDayKey(sel.start, locale)} – ${
    formatDayKey(sel.end, locale)
  }`;
}
