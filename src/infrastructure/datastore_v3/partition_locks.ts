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

import type { Intent } from "../../domain/datastore_v3/intent.ts";
import type { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";

const MINT: unique symbol = Symbol("partition-locks");

/** proof that the holder's caller already holds these keys, made only here */
export class HeldPartitionLocks {
  readonly #keys: ReadonlySet<string>;
  #released = false;

  constructor(token: typeof MINT, keys: ReadonlySet<string>) {
    if (token !== MINT) throw new Error("Only PartitionLocks holds keys");
    this.#keys = keys;
  }

  /** a token kept past its hold proves nothing */
  holds(key: string): boolean {
    return !this.#released && this.#keys.has(key);
  }

  keys(): readonly string[] {
    return this.#released ? [] : [...this.#keys];
  }

  release(): void {
    this.#released = true;
  }
}

/**
 * One FIFO queue per key. Several keys are taken in sorted order, so two
 * holders of overlapping sets never wait on each other in a cycle.
 */
export class PartitionLocks {
  readonly #tails = new Map<string, Promise<void>>();

  async hold<T>(
    keys: Iterable<string>,
    fn: (held: HeldPartitionLocks) => Promise<T>,
    already?: HeldPartitionLocks,
  ): Promise<T> {
    const wanted = [...new Set(keys)]
      .filter((key) => already?.holds(key) !== true)
      .sort();
    const releases: (() => void)[] = [];
    try {
      for (const key of wanted) releases.push(await this.#acquire(key));
      const held = new HeldPartitionLocks(
        MINT,
        new Set([...wanted, ...(already?.keys() ?? [])]),
      );
      try {
        return await fn(held);
      } finally {
        held.release();
      }
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  get size(): number {
    return this.#tails.size;
  }

  async #acquire(key: string): Promise<() => void> {
    const before = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => release = resolve);
    const tail = before.then(() => done);
    this.#tails.set(key, tail);
    await before;
    return () => {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    };
  }
}

const locksBySink = new WeakMap<object, PartitionLocks>();

/** every writer appending through `sink` queues on the same locks */
export function partitionLocksOf(sink: object): PartitionLocks {
  let locks = locksBySink.get(sink);
  if (locks === undefined) {
    locks = new PartitionLocks();
    locksBySink.set(sink, locks);
  }
  return locks;
}

export function partitionLockKey(
  namespace: string,
  partition: PartitionKey,
): string {
  return `partition\u0000${namespace}\u0000${partition.toString()}`;
}

/**
 * a run id names one run across every workflow, so a first record and a
 * snapshot under it are judged against all of them
 */
export function runIdLockKey(namespace: string, runId: string): string {
  return `${RUN_ID_PREFIX}${namespace}\u0000${runId.toLowerCase()}`;
}

const RUN_ID_PREFIX = "run-id\u0000";

export function isRunIdLockKey(key: string): boolean {
  return key.startsWith(RUN_ID_PREFIX);
}

/**
 * a run's first record is judged against every workflow's runs, and a
 * snapshot's key names the run id alone, so writers of either queue on the id
 */
export function runIdLockKeysOf(
  namespace: string,
  intents: Iterable<Intent>,
): string[] {
  const keys = new Set<string>();
  for (const intent of intents) {
    if (
      "run" in intent &&
      (intent.kind === "run.create" || intent.kind.startsWith("run-snapshot."))
    ) {
      keys.add(runIdLockKey(namespace, intent.run.runId));
    }
  }
  return [...keys];
}
