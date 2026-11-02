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
 * a name appears in at most one of upserts and removals; replaying a delta onto
 * a datastore lockfile reproduces this checkout's change without reverting
 * entries other checkouts wrote meanwhile
 */
export interface LockfileDelta<E> {
  readonly upserts: Readonly<Record<string, E>>;
  readonly removals: readonly string[];
}

export function emptyLockfileDelta<E>(): LockfileDelta<E> {
  return { upserts: {}, removals: [] };
}

export function isEmptyLockfileDelta<E>(delta: LockfileDelta<E>): boolean {
  return Object.keys(delta.upserts).length === 0 &&
    delta.removals.length === 0;
}

/**
 * entries compare by value with object keys sorted, so a lockfile rewritten in
 * a different key order is not a change
 */
export function diffLockfileEntries<E>(
  before: Readonly<Record<string, E>>,
  after: Readonly<Record<string, E>>,
): LockfileDelta<E> {
  const upserts: Record<string, E> = {};
  const removals: string[] = [];
  for (const [name, entry] of Object.entries(after)) {
    if (
      !Object.hasOwn(before, name) ||
      canonicalJson(before[name]) !== canonicalJson(entry)
    ) {
      upserts[name] = entry;
    }
  }
  for (const name of Object.keys(before)) {
    if (!Object.hasOwn(after, name)) removals.push(name);
  }
  removals.sort();
  return { upserts, removals };
}

export function applyLockfileDelta<E>(
  entries: Readonly<Record<string, E>>,
  delta: LockfileDelta<E>,
): Record<string, E> {
  const result: Record<string, E> = { ...entries };
  for (const name of delta.removals) delete result[name];
  for (const [name, entry] of Object.entries(delta.upserts)) {
    result[name] = entry;
  }
  return result;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    return Object.fromEntries(
      Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]),
    );
  });
}

export function mergeLockfileDeltas<E>(
  older: LockfileDelta<E>,
  newer: LockfileDelta<E>,
): LockfileDelta<E> {
  const newerRemovals = new Set(newer.removals);
  const upserts: Record<string, E> = {};
  for (const [name, entry] of Object.entries(older.upserts)) {
    if (!newerRemovals.has(name)) upserts[name] = entry;
  }
  Object.assign(upserts, newer.upserts);
  const removals = new Set(
    older.removals.filter((name) => !Object.hasOwn(newer.upserts, name)),
  );
  for (const name of newer.removals) removals.add(name);
  return { upserts, removals: [...removals].sort() };
}
