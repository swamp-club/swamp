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

/**
 * How long a published {@link DrainWait} counts as live without a refresh.
 * A waiting drain refreshes its own on every poll, so only a drain that was
 * killed leaves one to expire.
 */
export const DRAIN_WAIT_TTL_MS = 10_000;

export const MAX_DRAIN_WAIT_LOCKS = 1024;

const TOKEN = /^[A-Za-z0-9-]{1,64}$/;
const MAX_HOSTNAME_LENGTH = 255;

export interface DrainWait {
  readonly id: string;
  readonly pid: number;
  readonly hostname: string;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
  readonly ttlMs: number;
  /**
   * locks a swamp above the drain holds for the run that started it; a holder
   * that stops waiting re-keys its lock, so the next scan drops it from this
   * list
   */
  readonly skipping: readonly string[];
  readonly waitingOn: readonly string[];
}

/**
 * returns null for anything malformed or oversized: markers come from a
 * directory other processes write, and a drain must never act on one it cannot
 * fully validate
 */
export function parseDrainWait(value: unknown): DrainWait | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const skipping = parseLockIds(raw.skipping);
  const waitingOn = parseLockIds(raw.waitingOn);
  if (
    typeof raw.id !== "string" || !TOKEN.test(raw.id) ||
    !isPositiveInteger(raw.pid) ||
    typeof raw.hostname !== "string" || raw.hostname.length === 0 ||
    raw.hostname.length > MAX_HOSTNAME_LENGTH ||
    !isTimestamp(raw.startedAtMs) || !isTimestamp(raw.updatedAtMs) ||
    !isPositiveInteger(raw.ttlMs) || raw.ttlMs > DRAIN_WAIT_TTL_MS ||
    skipping === null || waitingOn === null
  ) {
    return null;
  }
  return {
    id: raw.id,
    pid: raw.pid,
    hostname: raw.hostname,
    startedAtMs: raw.startedAtMs,
    updatedAtMs: raw.updatedAtMs,
    ttlMs: raw.ttlMs,
    skipping,
    waitingOn,
  };
}

export function serializeDrainWait(wait: DrainWait): string {
  return JSON.stringify({
    id: wait.id,
    pid: wait.pid,
    hostname: wait.hostname,
    startedAtMs: wait.startedAtMs,
    updatedAtMs: wait.updatedAtMs,
    ttlMs: wait.ttlMs,
    skipping: wait.skipping,
    waitingOn: wait.waitingOn,
  });
}

export function isDrainWaitExpired(wait: DrainWait, nowMs: number): boolean {
  return nowMs - wait.updatedAtMs > wait.ttlMs;
}

/**
 * a skipped lock is held until its drain exits, so neither can finish first; a
 * drain skipping every lock the other skips is not waited on and breaks no tie
 */
export function areMutuallyWaiting(a: DrainWait, b: DrainWait): boolean {
  return waitsOn(a, b) && waitsOn(b, a);
}

/**
 * waits are ordered by start time then id so every drain reaches the same
 * answer; one yields only to an earlier drain that is not itself yielding, so
 * exactly one of a group keeps waiting
 */
export function drainToYieldTo(
  self: DrainWait,
  others: readonly DrainWait[],
  nowMs: number,
): DrainWait | undefined {
  const waits = [
    self,
    ...others.filter((other) =>
      other.id !== self.id && !isDrainWaitExpired(other, nowMs)
    ),
  ].sort(compareDrainWaits);

  const staying: DrainWait[] = [];
  for (const wait of waits) {
    const opponent = staying.find((earlier) =>
      areMutuallyWaiting(wait, earlier)
    );
    if (wait.id === self.id) {
      return opponent;
    }
    if (opponent === undefined) {
      staying.push(wait);
    }
  }
  return undefined;
}

function waitsOn(waiter: DrainWait, holder: DrainWait): boolean {
  const skipped = new Set(holder.skipping);
  return waiter.waitingOn.some((lockId) => skipped.has(lockId));
}

function compareDrainWaits(a: DrainWait, b: DrainWait): number {
  if (a.startedAtMs !== b.startedAtMs) {
    return a.startedAtMs - b.startedAtMs;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function parseLockIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_DRAIN_WAIT_LOCKS) {
    return null;
  }
  const lockIds: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !TOKEN.test(entry)) {
      return null;
    }
    lockIds.push(entry);
  }
  return lockIds;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0;
}
