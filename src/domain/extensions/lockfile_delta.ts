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
 * The change one checkout made to the extension lockfile's entry set:
 * entries it wrote (`upserts`, by extension name) and entries it removed
 * (`removals`). A name appears in at most one of the two.
 *
 * Replaying a delta onto a lockfile fetched from the datastore reproduces
 * this checkout's change without reverting entries other checkouts wrote
 * meanwhile (swamp-club#2838).
 */
export interface LockfileDelta<E> {
  readonly upserts: Readonly<Record<string, E>>;
  readonly removals: readonly string[];
}

/** A delta that changes nothing. */
export function emptyLockfileDelta<E>(): LockfileDelta<E> {
  return { upserts: {}, removals: [] };
}

/** True when applying `delta` changes no entry set. */
export function isEmptyLockfileDelta<E>(delta: LockfileDelta<E>): boolean {
  return Object.keys(delta.upserts).length === 0 &&
    delta.removals.length === 0;
}

/**
 * The delta that turns `before` into `after`. Entries are compared by
 * value with object keys sorted, so a lockfile rewritten with a different
 * key order is not a change.
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

/** `entries` with `delta` applied. Does not modify `entries`. */
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
