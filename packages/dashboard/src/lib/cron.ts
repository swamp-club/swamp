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

// Cron expressions as serve's scheduler (croner) reads them: five fields
// (minute hour day-of-month month day-of-week), or six with a leading
// seconds field, plus the @hourly-style nicknames. Parses them to validate
// an edit as it is typed, describes common patterns in English ("Every 5
// minutes", "Every weekday at 09:00") and lists upcoming fire times for a
// preview. Patterns it cannot describe return null, and the caller shows
// the raw expression; syntax it does not model (L, W, #, and `?`, which
// croner replaces with the current date's value when the schedule is
// loaded) parses as unsupported, so serve stays the judge of what is valid.

export interface CronSchedule {
  hasSeconds: boolean;
  seconds: number[];
  minutes: number[];
  hours: number[];
  days: number[];
  months: number[];
  /** 0 = Sunday. */
  weekdays: number[];
  /** Day-of-month / day-of-week were `*` (unrestricted). */
  daysAny: boolean;
  weekdaysAny: boolean;
  /** The fields as written, after nickname expansion. */
  fields: string[];
}

export type CronParse =
  | { ok: true; schedule: CronSchedule }
  | { ok: false; error: string; unsupported?: boolean };

const NICKNAMES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTH_NAMES = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** Offset added to a name's index (months are 1-based). */
  nameBase?: number;
}

const SECOND: FieldSpec = { name: "second", min: 0, max: 59 };
const MINUTE: FieldSpec = { name: "minute", min: 0, max: 59 };
const HOUR: FieldSpec = { name: "hour", min: 0, max: 23 };
const DAY: FieldSpec = { name: "day of month", min: 1, max: 31 };
const MONTH: FieldSpec = {
  name: "month",
  min: 1,
  max: 12,
  names: MONTH_NAMES,
  nameBase: 1,
};
const WEEKDAY: FieldSpec = {
  name: "day of week",
  min: 0,
  max: 7,
  names: DAY_NAMES,
  nameBase: 0,
};

class CronError extends Error {
  constructor(message: string, readonly unsupported = false) {
    super(message);
  }
}

function parseValue(token: string, spec: FieldSpec): number {
  const upper = token.toUpperCase();
  if (spec.names) {
    const i = spec.names.indexOf(upper);
    if (i >= 0) return i + (spec.nameBase ?? 0);
  }
  if (!/^\d+$/.test(token)) {
    if (/[LW#?]/i.test(token)) {
      throw new CronError(`"${token}" can't be previewed here`, true);
    }
    throw new CronError(`"${token}" is not a valid ${spec.name}`);
  }
  const n = Number(token);
  if (n < spec.min || n > spec.max) {
    throw new CronError(
      `${spec.name} ${n} is out of range (${spec.min}–${spec.max})`,
    );
  }
  return n;
}

function parseField(raw: string, spec: FieldSpec): Set<number> {
  const values = new Set<number>();
  if (raw === "") throw new CronError(`Missing ${spec.name}`);
  for (const part of raw.split(",")) {
    if (part === "") throw new CronError(`Empty item in ${spec.name}`);
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined) {
      throw new CronError(`"${part}" has more than one "/"`);
    }
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) === 0) {
        throw new CronError(`Step "${stepText}" must be a positive number`);
      }
      step = Number(stepText);
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = spec.min;
      hi = spec.max === 7 ? 6 : spec.max;
    } else if (range.includes("-")) {
      const [a, b, more] = range.split("-");
      if (more !== undefined || a === "" || b === "") {
        throw new CronError(`"${range}" is not a valid range`);
      }
      lo = parseValue(a, spec);
      hi = parseValue(b, spec);
      if (lo > hi) {
        throw new CronError(`Range "${range}" runs backwards`);
      }
    } else {
      lo = parseValue(range, spec);
      // "5/15" means every 15 from 5 to the field's end.
      hi = stepText !== undefined ? spec.max : lo;
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);

/** Parses an expression; errors are short sentences fit for a form. */
export function parseCron(expression: string): CronParse {
  const trimmed = expression.trim();
  if (trimmed === "") return { ok: false, error: "Enter a cron expression" };
  const expanded = NICKNAMES[trimmed.toLowerCase()] ?? trimmed;
  if (expanded.startsWith("@")) {
    return { ok: false, error: `Unknown shortcut "${trimmed}"` };
  }
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) {
    return {
      ok: false,
      error:
        `Expected 5 fields (minute hour day month weekday), got ${fields.length}`,
    };
  }
  const hasSeconds = fields.length === 6;
  const [s, m, h, dom, mon, dow] = hasSeconds ? fields : ["0", ...fields];
  try {
    const weekdays = parseField(dow, WEEKDAY);
    if (weekdays.has(7)) {
      weekdays.delete(7);
      weekdays.add(0);
    }
    return {
      ok: true,
      schedule: {
        hasSeconds,
        seconds: sorted(parseField(s, SECOND)),
        minutes: sorted(parseField(m, MINUTE)),
        hours: sorted(parseField(h, HOUR)),
        days: sorted(parseField(dom, DAY)),
        months: sorted(parseField(mon, MONTH)),
        weekdays: sorted(weekdays),
        daysAny: dom === "*",
        weekdaysAny: dow === "*",
        fields,
      },
    };
  } catch (err) {
    if (err instanceof CronError) {
      return {
        ok: false,
        error: err.message,
        ...(err.unsupported && { unsupported: true }),
      };
    }
    throw err;
  }
}

// ── Description ─────────────────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, "0");
const clock = (h: number, m: number) => `${pad2(h)}:${pad2(m)}`;

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** "a", "a and b", "a, b and c". */
function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The step of a field written as `*` + `/n` covering the whole range. */
function evenStep(values: number[], min: number, span: number): number | null {
  if (values.length < 2 || values[0] !== min) return null;
  const step = values[1] - values[0];
  if (span % step !== 0 || values.length !== span / step) return null;
  for (let i = 1; i < values.length; i++) {
    if (values[i] - values[i - 1] !== step) return null;
  }
  return step;
}

function isFull(values: number[], min: number, max: number): boolean {
  return values.length === max - min + 1;
}

function contiguous(values: number[]): boolean {
  return values.every((v, i) => i === 0 || v === values[i - 1] + 1);
}

const WEEKDAYS_MON_FRI = [1, 2, 3, 4, 5];

function sameList(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The days a schedule fires on, phrased to follow a time ("at 09:00") or a
 * frequency ("every 5 minutes"). Null when both day fields are restricted:
 * cron then fires on either, which no short phrase says clearly.
 */
function dayPhrase(
  s: CronSchedule,
): { lead: string; suffix: string } | null {
  const monthsAll = isFull(s.months, 1, 12);
  const monthList = joinList(s.months.map((m) => MONTH_LABELS[m - 1]));
  if (!s.daysAny && !s.weekdaysAny) return null;
  if (!s.weekdaysAny) {
    const w = s.weekdays;
    let lead: string;
    let suffix: string;
    if (sameList(w, WEEKDAYS_MON_FRI)) {
      lead = "every weekday";
      suffix = " on weekdays";
    } else if (sameList(w, [0, 6])) {
      lead = "every Saturday and Sunday";
      suffix = " on weekends";
    } else {
      const names = w.map((d) => DAY_LABELS[d]);
      lead = `every ${joinList(names)}`;
      suffix = ` on ${joinList(names.map((n) => `${n}s`))}`;
    }
    if (!monthsAll) {
      lead += ` in ${monthList}`;
      suffix += ` in ${monthList}`;
    }
    return { lead, suffix };
  }
  if (!s.daysAny) {
    const days = joinList(s.days.map(ordinal));
    if (monthsAll) {
      return {
        lead: `on the ${days} of every month`,
        suffix: ` on the ${days} of every month`,
      };
    }
    if (s.months.length === 1 && s.days.length === 1) {
      const date = `${MONTH_LABELS[s.months[0] - 1]} ${s.days[0]}`;
      return { lead: `every year on ${date}`, suffix: ` on ${date}` };
    }
    return {
      lead: `on the ${days} of ${monthList}`,
      suffix: ` on the ${days} of ${monthList}`,
    };
  }
  if (!monthsAll) {
    return { lead: `every day in ${monthList}`, suffix: ` in ${monthList}` };
  }
  return { lead: "every day", suffix: "" };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Times of day a schedule fires at, when there are only a few. */
function clockTimes(s: CronSchedule): string[] | null {
  if (s.hours.length * s.minutes.length > 6) return null;
  if (isFull(s.hours, 0, 23) || isFull(s.minutes, 0, 59)) return null;
  const times: string[] = [];
  for (const h of s.hours) {
    for (const m of s.minutes) times.push(clock(h, m));
  }
  return times;
}

/**
 * Describes an expression in English: "Every 5 minutes", "Every weekday at
 * 09:00", "On the 1st of every month at 00:00". Null for anything it can't
 * say clearly — show the raw expression instead.
 */
export function describeCron(expression: string): string | null {
  const parsed = parseCron(expression);
  if (!parsed.ok) return null;
  const s = parsed.schedule;
  const days = dayPhrase(s);
  if (!days) return null;

  if (s.hasSeconds && !(s.seconds.length === 1 && s.seconds[0] === 0)) {
    // Sub-minute schedules: only the plain "every N seconds" forms.
    const everyMinuteRest = isFull(s.minutes, 0, 59) &&
      isFull(s.hours, 0, 23);
    if (!everyMinuteRest) return null;
    if (isFull(s.seconds, 0, 59)) {
      return capitalize(`every second${days.suffix}`);
    }
    const step = evenStep(s.seconds, 0, 60);
    if (step === null) return null;
    return capitalize(`every ${step} seconds${days.suffix}`);
  }

  const minutesAll = isFull(s.minutes, 0, 59);
  const hoursAll = isFull(s.hours, 0, 23);
  const minuteStep = evenStep(s.minutes, 0, 60);
  const hourStep = evenStep(s.hours, 0, 24);
  const singleMinute = s.minutes.length === 1 ? s.minutes[0] : null;

  let freq: string | null = null;
  if (hoursAll) {
    if (minutesAll) freq = "every minute";
    else if (minuteStep !== null) freq = `every ${minuteStep} minutes`;
    else if (singleMinute !== null) {
      freq = singleMinute === 0
        ? "every hour"
        : `every hour at :${pad2(singleMinute)}`;
    } else if (s.minutes.length <= 4) {
      freq = `every hour at ${joinList(s.minutes.map((m) => `:${pad2(m)}`))}`;
    }
  } else if (hourStep !== null && singleMinute !== null) {
    freq = `every ${hourStep} hours${
      singleMinute === 0 ? "" : ` at :${pad2(singleMinute)}`
    }`;
  } else if (
    (minutesAll || minuteStep !== null) && contiguous(s.hours)
  ) {
    const first = s.hours[0];
    const last = s.hours[s.hours.length - 1];
    const every = minutesAll ? "every minute" : `every ${minuteStep} minutes`;
    freq = s.hours.length === 1
      ? `${every} from ${clock(first, 0)} to ${clock(first, 59)}`
      : `${every} between ${clock(first, 0)} and ${clock(last, 59)}`;
  }
  if (freq !== null) return capitalize(`${freq}${days.suffix}`);

  const times = clockTimes(s);
  if (times === null) return null;
  return capitalize(`${days.lead} at ${joinList(times)}`);
}

// ── Upcoming fire times ─────────────────────────────────────────────────

interface Calendar {
  get(d: Date): {
    second: number;
    minute: number;
    hour: number;
    day: number;
    month: number;
    weekday: number;
  };
  /** The first instant of the next unit after `d`. */
  nextMonth(d: Date): Date;
  nextDay(d: Date): Date;
  nextHour(d: Date): Date;
  nextMinute(d: Date): Date;
}

const LOCAL: Calendar = {
  get: (d) => ({
    second: d.getSeconds(),
    minute: d.getMinutes(),
    hour: d.getHours(),
    day: d.getDate(),
    month: d.getMonth() + 1,
    weekday: d.getDay(),
  }),
  nextMonth: (d) => new Date(d.getFullYear(), d.getMonth() + 1, 1),
  nextDay: (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1),
  nextHour: (d) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1),
  nextMinute: (d) =>
    new Date(Math.floor(d.getTime() / 60_000) * 60_000 + 60_000),
};

const UTC: Calendar = {
  get: (d) => ({
    second: d.getUTCSeconds(),
    minute: d.getUTCMinutes(),
    hour: d.getUTCHours(),
    day: d.getUTCDate(),
    month: d.getUTCMonth() + 1,
    weekday: d.getUTCDay(),
  }),
  nextMonth: (d) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)),
  nextDay: (d) =>
    new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1),
    ),
  nextHour: (d) =>
    new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000 + 3_600_000),
  nextMinute: (d) =>
    new Date(Math.floor(d.getTime() / 60_000) * 60_000 + 60_000),
};

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * A calendar in an IANA time zone, or null when the runtime doesn't know
 * the zone. Wall times are read with `Intl`; the start of the next day or
 * month is found from the zone's UTC offset there, so DST days work.
 */
function zonedCalendar(timeZone: string): Calendar | null {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
  } catch {
    return null;
  }
  const wall = (ms: number) => {
    const parts: Record<string, string> = {};
    for (const p of format.formatToParts(new Date(ms))) parts[p.type] = p.value;
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour: Number(parts.hour),
      minute: Number(parts.minute),
      second: Number(parts.second),
      weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
    };
  };
  /** Milliseconds the zone is ahead of UTC at `ms`. */
  const offsetAt = (ms: number) => {
    const w = wall(ms);
    const asUtc = Date.UTC(
      w.year,
      w.month - 1,
      w.day,
      w.hour,
      w.minute,
      w.second,
    );
    return asUtc - Math.floor(ms / 1000) * 1000;
  };
  /** The instant of a wall-clock midnight in the zone (the later side of a gap). */
  const midnight = (year: number, month: number, day: number) => {
    const guess = Date.UTC(year, month - 1, day);
    const first = guess - offsetAt(guess);
    const second = guess - offsetAt(first);
    return new Date(Math.max(first, second));
  };
  const nextHour = (d: Date) => {
    const w = wall(d.getTime());
    const minuteStart = Math.floor(d.getTime() / 60_000) * 60_000;
    return new Date(minuteStart + (60 - w.minute) * 60_000);
  };
  // Never step backwards (a repeated hour can map midnight behind `d`).
  const ahead = (d: Date, next: Date) => next > d ? next : nextHour(d);
  return {
    get: (d) => {
      const w = wall(d.getTime());
      return {
        second: w.second,
        minute: w.minute,
        hour: w.hour,
        day: w.day,
        month: w.month,
        weekday: w.weekday,
      };
    },
    nextMonth: (d) => {
      const w = wall(d.getTime());
      return ahead(
        d,
        w.month === 12
          ? midnight(w.year + 1, 1, 1)
          : midnight(w.year, w.month + 1, 1),
      );
    },
    nextDay: (d) => {
      const w = wall(d.getTime());
      const next = new Date(Date.UTC(w.year, w.month - 1, w.day + 1));
      return ahead(
        d,
        midnight(
          next.getUTCFullYear(),
          next.getUTCMonth() + 1,
          next.getUTCDate(),
        ),
      );
    },
    nextHour,
    nextMinute: (d) =>
      new Date(Math.floor(d.getTime() / 60_000) * 60_000 + 60_000),
  };
}

/** How far ahead a preview looks before giving up on a rare schedule. */
const HORIZON_MS = 30 * 366 * 24 * 3_600_000;

/**
 * The next `count` times a schedule fires strictly after `from`, in the
 * browser's time zone, UTC, or an IANA `timeZone` (serve's, so a preview
 * matches when serve's scheduler fires; an unknown zone falls back to the
 * browser's). Fewer when it fires rarely or never (e.g. February 30th).
 */
export function nextFireTimes(
  schedule: CronSchedule,
  from: Date,
  count: number,
  options: { utc?: boolean; timeZone?: string } = {},
): Date[] {
  const cal = options.utc
    ? UTC
    : (options.timeZone ? zonedCalendar(options.timeZone) : null) ?? LOCAL;
  const horizon = from.getTime() + HORIZON_MS;
  const sec = new Set(schedule.seconds);
  const min = new Set(schedule.minutes);
  const hr = new Set(schedule.hours);
  const dom = new Set(schedule.days);
  const mon = new Set(schedule.months);
  const dow = new Set(schedule.weekdays);
  const dayMatches = (day: number, weekday: number) => {
    if (schedule.daysAny && schedule.weekdaysAny) return true;
    if (schedule.daysAny) return dow.has(weekday);
    if (schedule.weekdaysAny) return dom.has(day);
    // Both restricted: cron fires on either.
    return dom.has(day) || dow.has(weekday);
  };

  const out: Date[] = [];
  const stepMs = schedule.hasSeconds ? 1000 : 60_000;
  let t = new Date(Math.floor(from.getTime() / stepMs) * stepMs + stepMs);
  for (
    let guard = 0;
    out.length < count && guard < 200_000 && t.getTime() <= horizon;
    guard++
  ) {
    const c = cal.get(t);
    if (!mon.has(c.month)) t = cal.nextMonth(t);
    else if (!dayMatches(c.day, c.weekday)) t = cal.nextDay(t);
    else if (!hr.has(c.hour)) t = cal.nextHour(t);
    else if (!min.has(c.minute)) t = cal.nextMinute(t);
    else if (schedule.hasSeconds && !sec.has(c.second)) {
      t = new Date(t.getTime() + 1000);
    } else {
      out.push(t);
      t = new Date(t.getTime() + stepMs);
    }
  }
  return out;
}

/** The viewer's IANA time zone, when the runtime reports one. */
export function viewerTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** "Mon, Oct 12, 09:00" in `timeZone` (the viewer's when omitted or unknown). */
export function formatFireTime(d: Date, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  };
  try {
    return d.toLocaleString(undefined, { ...options, timeZone });
  } catch {
    return d.toLocaleString(undefined, options);
  }
}

/**
 * A fire time as serve's scheduler sees it (`timeZone`), plus the viewer's
 * own wall time when that reads differently. `local` is null when the
 * zones agree or serve's zone is unknown.
 */
export function fireTimeLabels(
  d: Date,
  timeZone: string | undefined,
  viewerZone: string | undefined = viewerTimeZone(),
): { primary: string; local: string | null } {
  const primary = formatFireTime(d, timeZone);
  if (!timeZone || timeZone === viewerZone) return { primary, local: null };
  const local = formatFireTime(d, viewerZone);
  return { primary, local: local === primary ? null : local };
}

/** Common schedules offered as one-click starting points in the editor. */
export const CRON_PRESETS: ReadonlyArray<
  { label: string; expression: string }
> = [
  { label: "Every 5 min", expression: "*/5 * * * *" },
  { label: "Every 15 min", expression: "*/15 * * * *" },
  { label: "Hourly", expression: "0 * * * *" },
  { label: "Daily 09:00", expression: "0 9 * * *" },
  { label: "Weekdays 09:00", expression: "0 9 * * 1-5" },
  { label: "Mondays 09:00", expression: "0 9 * * 1" },
  { label: "Monthly", expression: "0 0 1 * *" },
];
