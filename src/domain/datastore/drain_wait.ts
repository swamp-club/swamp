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

/** The most lock nonces a {@link DrainWait} lists on either side. */
export const MAX_DRAIN_WAIT_LOCKS = 1024;

const TOKEN = /^[A-Za-z0-9-]{1,64}$/;
const MAX_HOSTNAME_LENGTH = 255;

/**
 * One structural command's wait for per-model locks to clear, as it tells
 * the other drains on the datastore (design/enablers/datastores.md,
 * "Parent-Process Lock Awareness"). Locks are named by the nonce their lock
 * file records.
 */
export interface DrainWait {
  /** Names this wait; also its marker's file name. */
  readonly id: string;
  readonly pid: number;
  readonly hostname: string;
  /** When the wait began, in ms since the epoch. Orders who yields. */
  readonly startedAtMs: number;
  /** When the drain last published this wait, in ms since the epoch. */
  readonly updatedAtMs: number;
  readonly ttlMs: number;
  /**
   * The live locks the drain skips: those a swamp above it holds for the
   * run that started it, and so keeps while that run waits on this drain.
   * A holder that stops waiting re-keys its lock, and the next scan no
   * longer lists it here.
   */
  readonly skipping: readonly string[];
  /** The live locks the drain is waiting on. */
  readonly waitingOn: readonly string[];
}

/**
 * Reads a {@link DrainWait} from parsed JSON. Returns null for anything
 * malformed or oversized: markers come from a directory other processes
 * write, and a drain must never act on one it cannot fully validate.
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

/** The JSON a drain publishes for `wait`; {@link parseDrainWait} reads it. */
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

/** True once `wait` has gone a full ttl without a refresh. */
export function isDrainWaitExpired(wait: DrainWait, nowMs: number): boolean {
  return nowMs - wait.updatedAtMs > wait.ttlMs;
}

/**
 * True when each drain waits on a lock the other skips. A skipped lock is
 * held until its drain exits, so neither can finish first: they wait until
 * the lock timeout unless one gives up. A drain that skips every lock the
 * other skips (it runs under the same run, or deeper inside it) is not
 * waited on by the other and breaks no tie.
 */
export function areMutuallyWaiting(a: DrainWait, b: DrainWait): boolean {
  return waitsOn(a, b) && waitsOn(b, a);
}

/**
 * The drain `self` must give way to, if any.
 *
 * Every drain that sees the same waits reaches the same answer: unexpired
 * waits are ordered by start time, then id, and taken in that order. A
 * drain yields when it is mutually waiting with an earlier drain that is
 * not itself yielding, so of any group that all wait on each other exactly
 * one keeps waiting, and a drain never yields to one that is about to give
 * up anyway.
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
