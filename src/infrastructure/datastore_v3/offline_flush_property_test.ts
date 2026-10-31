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
 * Property: whatever the interleaving of offline commits, other writers'
 * commits and flushes cut off part-way or refused, every offline entry is
 * in the end landed (once), rejected or quarantined; none is lost
 * (swamp-club#4195).
 */

import { assertEquals } from "@std/assert";
import fc from "fast-check";
import type { Commit } from "../../domain/datastore_v3/commit.ts";
import type {
  OutboxEntry,
  OutboxEntryState,
} from "../../domain/datastore_v3/commit_outbox.ts";
import { Partition } from "../../domain/datastore_v3/partition.ts";
import {
  encodeMetadata,
  fixtureChanges,
  fixtureCommit,
  FixtureHistory,
  metadata,
  saveOps,
  toOps,
} from "../../domain/datastore_v3/offline_rebase_test_helpers.ts";
import {
  EMPTY_REBASE_CARRY,
  mergeRebaseCarry,
  type OfflineRebaseCarry,
} from "../../domain/datastore_v3/offline_rebase.ts";
import type { DataMetadata } from "../../domain/data/data_metadata.ts";
import type { Op } from "../../domain/datastore_v3/op.ts";
import { initializeLogging } from "../logging/logger.ts";
import { flushOfflineEntries, type OfflineFlushPort } from "./offline_flush.ts";
import {
  ChunkNotCachedError,
  ServeCommitRefusedError,
  ServeUnreachableError,
} from "./serve_upstream_errors.ts";

await initializeLogging({});

/** How serve answers one send. */
type Answer = "land" | "unreachable" | "forbidden" | "content" | "uncached";

/** One step of the interleaving. */
type Step =
  | { readonly kind: "offline"; readonly minute: number }
  | { readonly kind: "online"; readonly minute: number }
  | { readonly kind: "flush"; readonly answers: readonly Answer[] };

/** A checkout's outbox and serve's log, in memory. */
class Model implements OfflineFlushPort {
  readonly history = new FixtureHistory();
  readonly commits: Commit[] = [];
  /** The outbox: entries by txnId, in queue order. */
  readonly outbox = new Map<string, OutboxEntry>();
  readonly own = new Set<string>();
  answers: Answer[] = [];

  catchUpPartition(): Promise<void> {
    return Promise.resolve();
  }
  partitionState(): Promise<Partition> {
    const partition = this.history.partition;
    return Promise.resolve(
      Partition.restore(partition.key, partition.snapshot(), () => false),
    );
  }
  partitionCommits(): Promise<readonly Commit[]> {
    return Promise.resolve(this.commits);
  }
  head(): Promise<number> {
    return Promise.resolve(this.history.partition.seq);
  }
  send(commit: Commit): Promise<unknown> {
    const answer = this.answers.shift() ?? "land";
    switch (answer) {
      case "unreachable":
        return Promise.reject(
          new ServeUnreachableError("https://serve.test", "never", new Error()),
        );
      case "forbidden":
        return Promise.reject(
          new ServeCommitRefusedError("forbidden", "forbidden", 0, "no grant"),
        );
      case "content":
        return Promise.reject(
          new ServeCommitRefusedError(
            "forbidden",
            "content-refused",
            0,
            "refused",
          ),
        );
      case "uncached":
        return Promise.reject(new ChunkNotCachedError("abc", "p"));
      case "land":
        this.land(commit);
        return Promise.resolve();
    }
  }
  encodeMetadata = encodeMetadata;
  storeChunks(): never {
    throw new Error("the fixtures inline everything");
  }
  mark(
    keys: readonly { txnId: string }[],
    state: OutboxEntryState,
  ): Promise<void> {
    for (const key of keys) {
      const entry = this.outbox.get(key.txnId)!;
      this.outbox.set(key.txnId, { ...entry, state });
    }
    return Promise.resolve();
  }
  settle(keys: readonly { txnId: string }[]): Promise<void> {
    for (const key of keys) this.outbox.delete(key.txnId);
    return Promise.resolve();
  }
  carry: OfflineRebaseCarry = EMPTY_REBASE_CARRY;
  recordOwnLanded(
    key: { txnId: string },
    _at: number,
    carry?: OfflineRebaseCarry,
  ): Promise<void> {
    this.own.add(key.txnId);
    if (carry !== undefined) this.carry = mergeRebaseCarry(this.carry, carry);
    return Promise.resolve();
  }
  landedCarry(): Promise<OfflineRebaseCarry> {
    return Promise.resolve(this.carry);
  }
  ownLanded(): Promise<ReadonlySet<string>> {
    return Promise.resolve(new Set(this.own));
  }

  land(commit: Commit): void {
    this.history.append(commit);
    this.commits.push(commit);
  }

  /** The highest version of `out` known here: landed or queued. */
  highWater(): number {
    let high = this.history.partition.highWater("out");
    for (const entry of this.outbox.values()) {
      for (const op of entry.commit.ops) {
        if (op.kind === "data-version") {
          high = Math.max(high, op.metadata.version);
        }
      }
    }
    return high;
  }

  /** The entries a flush takes: queued offline, in queue order. */
  queued(): OutboxEntry[] {
    return [...this.outbox.values()].filter((entry) =>
      entry.state === "offline"
    );
  }
}

const minuteAt = (minute: number) =>
  new Date(Date.parse("2026-10-30T09:00:00.000Z") + minute * 60_000)
    .toISOString();

const answer = fc.constantFrom<Answer>(
  "land",
  "land",
  "land",
  "unreachable",
  "forbidden",
  "content",
  "uncached",
);
const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant("offline" as const),
    minute: fc.integer({ min: 0, max: 30 }),
  }),
  fc.record({
    kind: fc.constant("online" as const),
    minute: fc.integer({ min: 0, max: 30 }),
  }),
  fc.record({
    kind: fc.constant("flush" as const),
    answers: fc.array(answer, { maxLength: 6 }),
  }),
);

Deno.test("flushOfflineEntries (property): every offline entry ends landed once, rejected or quarantined, whatever the interleaving", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(step, { minLength: 1, maxLength: 14 }),
      async (steps) => {
        const model = new Model();
        const queuedTxnIds: string[] = [];
        let next = 0;
        for (const current of steps) {
          if (current.kind === "offline") {
            const txnId = `offline-${next++}`;
            queuedTxnIds.push(txnId);
            const base = model.history.partition.seq;
            model.outbox.set(txnId, {
              sequence: next,
              createdAt: 0,
              unitId: `unit-${next}`,
              base: { seq: base, txnId: undefined },
              state: "offline",
              commit: fixtureCommit({
                seq: base + 1,
                txnId,
                ops: await saveOps({
                  name: "out",
                  version: model.highWater() + 1,
                }),
                executedAt: minuteAt(current.minute),
              }),
            });
          } else if (current.kind === "online") {
            model.land(fixtureCommit({
              seq: model.history.partition.seq + 1,
              txnId: `online-${next++}`,
              at: minuteAt(current.minute),
              // Serve's writer fence, as every flush below commits under.
              fence: 1,
              ops: await saveOps({
                name: "out",
                version: model.history.partition.versions("out").at(-1)! +
                    1 || 1,
                createdAt: minuteAt(current.minute),
              }),
            }));
          } else {
            model.answers = [...current.answers];
            await flushOfflineEntries(model, model.queued(), {
              writer: { host: "h", pid: 1, instance: "p" },
              fence: 1,
              clock: () => new Date("2026-10-30T12:00:00.000Z"),
            });
          }
        }
        // Serve answers every send from here on: the rest lands.
        model.answers = [];
        await flushOfflineEntries(model, model.queued(), {
          writer: { host: "h", pid: 1, instance: "p" },
          fence: 1,
          clock: () => new Date("2026-10-30T12:00:00.000Z"),
        });

        const landed = model.commits.map((commit) => commit.txnId);
        for (const txnId of queuedTxnIds) {
          const kept = model.outbox.get(txnId);
          const times = landed.filter((id) => id === txnId).length;
          if (kept === undefined) {
            assertEquals(times, 1, `${txnId} settled without landing once`);
          } else {
            assertEquals(times, 0, `${txnId} both landed and kept`);
            assertEquals(
              kept.state === "rejected" || kept.state === "quarantined",
              true,
              `${txnId} left ${kept.state ?? "pending"}`,
            );
          }
        }
        // The outbox holds nothing it was not given.
        for (const txnId of model.outbox.keys()) {
          assertEquals(queuedTxnIds.includes(txnId), true);
        }
      },
    ),
    { numRuns: 200 },
  );
});

/** One step of the interleaving with removals and appends. */
type EditStep =
  | { readonly kind: "save"; readonly minute: number }
  | {
    readonly kind: "append" | "delete" | "gc";
    /** Which of the checkout's own live versions, by index. */
    readonly pick: number;
    readonly minute: number;
  }
  | { readonly kind: "online"; readonly minute: number }
  | { readonly kind: "flush"; readonly cutAfter: number | undefined };

const editStep: fc.Arbitrary<EditStep> = fc.oneof(
  fc.record({
    kind: fc.constant("save" as const),
    minute: fc.integer({ min: 0, max: 30 }),
  }),
  fc.record({
    kind: fc.constantFrom("append" as const, "delete" as const, "gc" as const),
    pick: fc.nat(),
    minute: fc.integer({ min: 0, max: 30 }),
  }),
  fc.record({
    kind: fc.constant("online" as const),
    minute: fc.integer({ min: 0, max: 30 }),
  }),
  fc.record({
    kind: fc.constant("flush" as const),
    cutAfter: fc.option(fc.nat({ max: 4 }), { nil: undefined }),
  }),
);

/** A version the checkout wrote offline: its queued number and its save. */
interface OwnVersion {
  readonly queued: number;
  readonly saveTxnId: string;
}

Deno.test("flushOfflineEntries (property): offline saves, appends and removals across entries never touch another writer's version, and every one lands", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(editStep, { minLength: 1, maxLength: 16 }),
      async (steps) => {
        const model = new Model();
        const queuedTxnIds: string[] = [];
        /** The checkout's own versions it still holds live. */
        const own: OwnVersion[] = [];
        /** Other writers' versions: number to raw digest. */
        const theirs = new Map<number, string>();
        let next = 0;
        /** The number `version` goes by now: queued, or as it landed. */
        const currentNumber = (version: OwnVersion): number => {
          const saving = model.outbox.get(version.saveTxnId);
          if (saving !== undefined) return version.queued;
          return model.carry.versions.find((carried) =>
            carried.from === version.queued
          )?.to ?? version.queued;
        };
        const landedMetadata = (number: number): DataMetadata | undefined => {
          for (const commit of [...model.commits].reverse()) {
            for (const op of commit.ops) {
              if (
                op.kind === "data-version" && op.metadata.name === "out" &&
                op.metadata.version === number
              ) {
                return op.metadata;
              }
            }
          }
          return undefined;
        };
        const queue = (ops: readonly Op[], minute: number): string => {
          const txnId = `offline-${next++}`;
          queuedTxnIds.push(txnId);
          const base = model.history.partition.seq;
          model.outbox.set(txnId, {
            sequence: next,
            createdAt: 0,
            unitId: `unit-${next}`,
            base: { seq: base, txnId: undefined },
            state: "offline",
            commit: fixtureCommit({
              seq: base + 1,
              txnId,
              ops,
              executedAt: minuteAt(minute),
            }),
          });
          return txnId;
        };
        const flush = (cutAfter: number | undefined) => {
          model.answers = cutAfter === undefined
            ? []
            : [...Array(cutAfter).fill("land"), "unreachable"];
          return flushOfflineEntries(model, model.queued(), {
            writer: { host: "h", pid: 1, instance: "p" },
            fence: 1,
            clock: () => new Date("2026-10-30T12:00:00.000Z"),
          });
        };
        for (const current of steps) {
          if (current.kind === "save") {
            const version = model.highWater() + 1;
            const txnId = queue(
              await saveOps({ name: "out", version }),
              current.minute,
            );
            own.push({ queued: version, saveTxnId: txnId });
          } else if (
            current.kind === "append" || current.kind === "delete" ||
            current.kind === "gc"
          ) {
            if (own.length === 0) continue;
            const index = current.pick % own.length;
            const target = own[index];
            const number = currentNumber(target);
            if (current.kind === "append") {
              // The metadata this checkout holds for it: queued, or as it
              // landed.
              const held = model.outbox.has(target.saveTxnId)
                ? metadata("out", number)
                : landedMetadata(number);
              if (held === undefined) continue;
              const bytes = encodeMetadata(held);
              const expect = model.outbox.has(target.saveTxnId)
                ? await sha256Hex(bytes)
                : model.history.partition.record(
                  fixtureChanges().dataKey("out", number, "metadata.yaml"),
                )?.sha256;
              if (expect === undefined) continue;
              queue(
                await toOps(
                  fixtureChanges().writeVersion({ kind: "data.append" }, {
                    name: "out",
                    version: number,
                    metadata: held,
                    metadataBytes: bytes,
                    metadataExpect: { sha256: expect },
                    raw: new TextEncoder().encode(`more ${next}`),
                  }),
                ),
                current.minute,
              );
            } else {
              queue(
                await toOps(
                  fixtureChanges().removeVersion(
                    current.kind === "delete" ? "data.delete" : "data.gc",
                    "out",
                    number,
                  ),
                ),
                current.minute,
              );
              own.splice(index, 1);
            }
          } else if (current.kind === "online") {
            // Another writer numbers from serve's log alone, so it may take
            // a number the checkout holds queued.
            const version = model.history.partition.highWater("out") + 1;
            const commit = fixtureCommit({
              seq: model.history.partition.seq + 1,
              txnId: `online-${next++}`,
              at: minuteAt(current.minute),
              fence: 1,
              ops: await saveOps({
                name: "out",
                version,
                text: `theirs ${version}`,
                createdAt: minuteAt(current.minute),
              }),
            });
            model.land(commit);
            const digest = model.history.partition.record(
              fixtureChanges().dataKey("out", version, "raw"),
            )?.sha256;
            if (digest !== undefined) theirs.set(version, digest);
          } else if (current.kind === "flush") {
            await flush(current.cutAfter);
          }
        }
        await flush(undefined);

        // Every offline entry landed once: none was valid and refused.
        const landed = model.commits.map((commit) => commit.txnId);
        for (const txnId of queuedTxnIds) {
          assertEquals(
            model.outbox.get(txnId)?.state,
            undefined,
            `${txnId} was kept, not landed`,
          );
          assertEquals(landed.filter((id) => id === txnId).length, 1);
        }
        // Another writer's version is never removed or changed.
        for (const [version, digest] of theirs) {
          assertEquals(
            model.history.partition.versions("out").includes(version),
            true,
            `their version ${version} was removed`,
          );
          assertEquals(
            model.history.partition.record(
              fixtureChanges().dataKey("out", version, "raw"),
            )?.sha256,
            digest,
            `their version ${version} was changed`,
          );
        }
        // The checkout's own live versions are exactly the ones it kept.
        const restated = new Set<number>();
        for (const commit of model.commits) {
          for (const op of commit.ops) {
            if (
              op.kind === "data-version" &&
              op.metadata.tags["_swamp.restates"] !== undefined
            ) {
              restated.add(op.metadata.version);
            }
          }
        }
        const ownLive = model.history.partition.versions("out").filter((v) =>
          !theirs.has(v) && !restated.has(v)
        );
        assertEquals(
          ownLive,
          own.map(currentNumber).sort((a, b) => a - b),
        );
      },
    ),
    { numRuns: 150 },
  );
});

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
