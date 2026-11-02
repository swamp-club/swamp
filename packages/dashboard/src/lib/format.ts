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

const NUMBER = new Intl.NumberFormat("en-US");
const COMPACT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatCount(n: number): string {
  return NUMBER.format(n);
}

export function formatCompactCount(n: number): string {
  return Math.abs(n) < 10_000 ? NUMBER.format(n) : COMPACT.format(n);
}

export function pluralize(
  n: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${formatCount(n)} ${n === 1 ? singular : plural}`;
}

export function formatDuration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = ms / 1000;
  if (secs < 10) return `${secs.toFixed(1)}s`;
  if (secs < 60) return `${Math.floor(secs)}s`;
  const totalSecs = Math.floor(secs);
  const mins = Math.floor(totalSecs / 60);
  if (mins < 60) {
    return `${mins}m ${String(totalSecs % 60).padStart(2, "0")}s`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${String(mins % 60).padStart(2, "0")}m`;
  const days = Math.floor(hours / 24);
  return `${formatCount(days)}d ${hours % 24}h`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatRelativeTime(
  iso: string | number | Date,
  now: number = Date.now(),
): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = t - now;
  const abs = Math.abs(diff);
  if (abs < MINUTE) return diff >= 0 ? "in < 1m" : "just now";
  let text: string;
  if (abs < HOUR) text = `${Math.floor(abs / MINUTE)}m`;
  else if (abs < DAY) {
    const h = Math.floor(abs / HOUR);
    const m = Math.floor((abs % HOUR) / MINUTE);
    text = diff > 0 && m > 0 ? `${h}h ${m}m` : `${h}h`;
  } else text = `${Math.floor(abs / DAY)}d`;
  return diff > 0 ? `in ${text}` : `${text} ago`;
}

export function formatAbsoluteTime(iso: string | number | Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

export function formatShortDateTime(iso: string | number | Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
