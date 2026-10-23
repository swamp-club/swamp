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

// A model-based check of the published-lineage protocol (swamp-club#3482,
// Phase 4 D2): two or three writers share one replica root, take the lease
// at increasing fences, restore, continue or restart their lineage, commit,
// and end each command with sync → head → confirmed → lease check →
// acknowledge. They may crash at any point, pause past their lease
// (zombies) or take a read-only recovery hold. The real rules in
// `published_lineage.ts` and `replication_lineage.ts` make every decision;
// the model only plays the object store, the replica paths and the copies.

import { ReplicaRoot } from "./replica_root.ts";
import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  type CompleteLineage,
  currentLineage,
  decideLocalCopy,
  type LineageHead,
  type LocalCopyState,
  mayContinueLineage,
  normalizeTxid,
  type PublishedLineage,
  restartLineage,
} from "./published_lineage.ts";
import {
  decideLineage,
  type ReplicationLineage,
} from "./replication_lineage.ts";

const ROOT = "file:/replica";
const AT = "2026-10-14T00:00:00.000Z";

function txidOf(n: number): string {
  return normalizeTxid(n)!;
}

/** One lineage's records in the control plane, as the store holds them. */
interface Records {
  started?: PublishedLineage["started"];
  confirmed?: PublishedLineage["confirmed"];
  head?: LineageHead;
}

/** How far a write command's end has got. */
type Phase = "open" | "synced" | "headed" | "confirmed";

/** A write command in progress on one copy. */
interface Session {
  readonly fence: number;
  phase: Phase;
  /** How many commits of the copy the command's sync covered. */
  markLen: number;
  /** The head's TXID, once the command published its head. */
  txid?: string;
  /** The commits the command's head covers, once it published one. */
  headed: string[];
}

interface Writer {
  /** `commits.db`: commit ids in cursor order (cursor = index + 1). */
  copy?: string[];
  copyState?: LocalCopyState;
  lineage?: ReplicationLineage;
  session?: Session;
}

interface World {
  maxFence: number;
  readonly records: Map<number, Records>;
  /** Each replica path's content: a prefix of its writer's copy. */
  readonly replicas: Map<number, string[]>;
  readonly writers: Writer[];
  /** Every commit a writer acknowledged, from any writer. */
  readonly acked: Set<string>;
  /**
   * Commits a head covered whose command then ended without acknowledging
   * them: its lease check failed, or it crashed after publishing the head.
   */
  readonly exposed: Set<string>;
  nextCommit: number;
}

const BRANCHES = [
  "takeover",
  "zombie-commit-after-takeover",
  "zombie-lease-check-failed",
  "crash-before-started",
  "crash-before-confirm",
  "crash-after-sync-before-head",
  "crash-between-head-and-confirmed",
  "crash-between-confirmed-and-check",
  "recovery-hold",
  "late-zombie-head",
  "restore",
  "continue",
  "restart",
  "fresh-reader",
] as const;
type Branch = typeof BRANCHES[number];

type ActionKind =
  | "begin"
  | "beginCrash"
  | "commit"
  | "upload"
  | "sync"
  | "publishHead"
  | "publishConfirmed"
  | "check"
  | "crash"
  | "hold"
  | "reader";

interface Action {
  readonly kind: ActionKind;
  readonly w: number;
  readonly k: number;
}

const IN_COMMAND: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "commit",
  "sync",
  "publishHead",
  "publishConfirmed",
  "check",
  "crash",
]);

const arbAction: fc.Arbitrary<Action> = fc.record({
  kind: fc.oneof(
    { arbitrary: fc.constant<ActionKind>("begin"), weight: 4 },
    { arbitrary: fc.constant<ActionKind>("beginCrash"), weight: 1 },
    { arbitrary: fc.constant<ActionKind>("commit"), weight: 6 },
    { arbitrary: fc.constant<ActionKind>("upload"), weight: 3 },
    { arbitrary: fc.constant<ActionKind>("sync"), weight: 4 },
    { arbitrary: fc.constant<ActionKind>("publishHead"), weight: 4 },
    { arbitrary: fc.constant<ActionKind>("publishConfirmed"), weight: 4 },
    { arbitrary: fc.constant<ActionKind>("check"), weight: 4 },
    { arbitrary: fc.constant<ActionKind>("crash"), weight: 2 },
    { arbitrary: fc.constant<ActionKind>("hold"), weight: 1 },
    { arbitrary: fc.constant<ActionKind>("reader"), weight: 1 },
  ),
  w: fc.nat(2),
  k: fc.integer({ min: 1, max: 3 }),
});

const arbScenario = fc.record({
  writers: fc.integer({ min: 2, max: 3 }),
  actions: fc.array(arbAction, { minLength: 1, maxLength: 80, size: "max" }),
});

function publishedList(world: World): PublishedLineage[] {
  return [...world.records.entries()].map(([fence, r]) => ({
    fence,
    ...(r.started !== undefined ? { started: r.started } : {}),
    ...(r.confirmed !== undefined ? { confirmed: r.confirmed } : {}),
    ...(r.head !== undefined ? { head: r.head } : {}),
  }));
}

function recordsOf(world: World, fence: number): Records {
  let records = world.records.get(fence);
  if (records === undefined) {
    records = {};
    world.records.set(fence, records);
  }
  return records;
}

/**
 * A Litestream restore of `lineage` up to its head's TXID, then swamp's
 * truncation to the head's high-water mark: every commit past the mark's
 * cursor is dropped.
 */
function restore(world: World, lineage: CompleteLineage): string[] {
  const replica = world.replicas.get(lineage.fence) ?? [];
  const upToTxid = replica.slice(0, Number(BigInt(`0x${lineage.head.txid}`)));
  return upToTxid.slice(0, lineage.head.mark.cursor);
}

/** What a fresh copy restores now, or undefined when nothing is published. */
function freshRestore(world: World): string[] | undefined {
  const decision = decideLocalCopy(
    undefined,
    publishedList(world),
    ReplicaRoot.of(ROOT),
  );
  if (decision.kind === "none") return undefined;
  assertEquals(decision.kind, "missing");
  if (decision.kind !== "missing") return undefined;
  return restore(world, decision.lineage);
}

function isStarted(world: World, fence: number): boolean {
  return world.records.get(fence)?.started?.replicaRoot === ROOT;
}

/** A command ended without acknowledging what its head covered. */
function endUnacknowledged(world: World, w: Writer): void {
  for (const id of w.session!.headed) {
    if (!world.acked.has(id)) world.exposed.add(id);
  }
  w.session = undefined;
}

/**
 * Applies one action, skipping it when it does not apply in this state, and
 * adds the branches it reached to `hit`.
 */
function step(world: World, action: Action, hit: Set<Branch>): void {
  // Actions a command takes go to a writer with a command in progress, so
  // runs reach the end of their commands; the others pick any writer.
  const busy = world.writers.filter((x) => x.session !== undefined);
  const w = IN_COMMAND.has(action.kind) && busy.length > 0
    ? busy[action.w % busy.length]
    : world.writers[action.w % world.writers.length];
  const session = w.session;
  const zombie = session !== undefined && session.fence < world.maxFence;
  switch (action.kind) {
    case "begin":
    case "beginCrash": {
      if (session !== undefined) return;
      if (world.writers.some((other) => other.session !== undefined)) {
        hit.add("takeover");
      }
      const fence = ++world.maxFence;
      const lineages = publishedList(world);
      const decision = decideLocalCopy(
        w.copy === undefined
          ? undefined
          : { copy: w.copyState, lineage: w.lineage },
        lineages,
        ReplicaRoot.of(ROOT),
      );
      let restored = false;
      if (
        decision.kind === "missing" || decision.kind === "behind" ||
        decision.kind === "foreign"
      ) {
        w.copy = restore(world, decision.lineage);
        w.copyState = {
          replicaRoot: ROOT,
          lineageFence: decision.lineage.fence,
          txid: decision.lineage.head.txid,
        };
        restored = true;
        hit.add("restore");
      } else if (w.copy === undefined) {
        w.copy = [];
      }
      const fenceRule = w.lineage !== undefined &&
        decideLineage(w.lineage, ReplicaRoot.of(ROOT), fence).kind ===
          "continue";
      let fresh: boolean;
      if (
        !restored && fenceRule &&
        mayContinueLineage(w.lineage, lineages, ReplicaRoot.of(ROOT))
      ) {
        // Invariant 3: a writer only ever continues a published lineage.
        assert(
          isStarted(world, w.lineage!.lineageFence),
          `writer continued unpublished lineage ${w.lineage!.lineageFence}`,
        );
        w.lineage = { ...w.lineage!, lastFence: fence };
        fresh = false;
        hit.add("continue");
      } else {
        w.lineage = restartLineage(w.lineage, ReplicaRoot.of(ROOT), fence);
        fresh = true;
        hit.add("restart");
      }
      if (action.kind === "beginCrash") {
        // The lineage record is written; a new lineage's `started` never is.
        if (fresh) hit.add("crash-before-started");
        return;
      }
      if (fresh) {
        const records = recordsOf(world, fence);
        assert(records.started === undefined, "started is create-only");
        records.started = {
          fence,
          holder: `w${world.writers.indexOf(w)}@host`,
          replicaRoot: ROOT,
          startedAt: AT,
        };
      }
      w.session = { fence, phase: "open", markLen: 0, headed: [] };
      return;
    }
    case "commit": {
      // Commits made after the sync (serve, or another context) are not
      // covered by this command's mark, though the sidecar may upload them.
      if (session === undefined) return;
      if (zombie) hit.add("zombie-commit-after-takeover");
      w.copy!.push(`c${world.nextCommit++}`);
      return;
    }
    case "upload": {
      // The sidecar uploads the copy's lineage asynchronously, also after
      // its command ended, once the lineage was started.
      if (w.copy === undefined || w.lineage === undefined) return;
      const path = w.lineage.lineageFence;
      if (!isStarted(world, path)) return;
      const replica = world.replicas.get(path) ?? [];
      assertEquals(replica, w.copy.slice(0, replica.length));
      world.replicas.set(
        path,
        w.copy.slice(0, Math.min(w.copy.length, replica.length + action.k)),
      );
      return;
    }
    case "sync": {
      if (session === undefined || session.phase !== "open") return;
      world.replicas.set(w.lineage!.lineageFence, [...w.copy!]);
      session.markLen = w.copy!.length;
      session.phase = "synced";
      return;
    }
    case "publishHead": {
      if (session === undefined || session.phase !== "synced") return;
      if (zombie) hit.add("late-zombie-head");
      const path = w.lineage!.lineageFence;
      // The sync's replicated TXID is at or past the commits it covered;
      // commits made since may already be uploaded too.
      const txid = txidOf(world.replicas.get(path)!.length);
      const markLen = session.markLen;
      recordsOf(world, path).head = {
        fence: path,
        txid,
        writerFence: session.fence,
        mark: markLen === 0 ? { cursor: 0 } : {
          cursor: markLen,
          commit: {
            namespace: "",
            partition: "p",
            seq: markLen,
            txnId: w.copy![markLen - 1],
          },
        },
        publishedAt: AT,
      };
      session.txid = txid;
      session.headed = w.copy!.slice(0, markLen);
      session.phase = "headed";
      return;
    }
    case "publishConfirmed": {
      if (session === undefined || session.phase !== "headed") return;
      const path = w.lineage!.lineageFence;
      const records = recordsOf(world, path);
      if (records.confirmed === undefined) {
        records.confirmed = {
          fence: path,
          txid: session.txid!,
          confirmedAt: AT,
        };
      }
      session.phase = "confirmed";
      return;
    }
    case "check": {
      if (session === undefined || session.phase !== "confirmed") return;
      if (session.fence !== world.maxFence) {
        // A failed lease check acknowledges nothing; the head stays.
        hit.add("zombie-lease-check-failed");
        endUnacknowledged(world, w);
        return;
      }
      for (const id of session.headed) {
        world.acked.add(id);
        world.exposed.delete(id);
      }
      w.copyState = {
        replicaRoot: ROOT,
        lineageFence: w.lineage!.lineageFence,
        txid: session.txid!,
      };
      w.session = undefined;
      return;
    }
    case "crash": {
      if (session === undefined) return;
      const records = world.records.get(w.lineage!.lineageFence);
      if (records?.confirmed === undefined) hit.add("crash-before-confirm");
      if (session.phase === "synced") hit.add("crash-after-sync-before-head");
      if (session.phase === "headed") {
        hit.add("crash-between-head-and-confirmed");
      }
      if (session.phase === "confirmed") {
        hit.add("crash-between-confirmed-and-check");
      }
      endUnacknowledged(world, w);
      return;
    }
    case "hold": {
      // A read-only recovery hold: it takes the lease and records the
      // fence in the copy's lineage, and publishes nothing.
      if (session !== undefined) return;
      const fence = ++world.maxFence;
      hit.add("recovery-hold");
      if (w.copy === undefined) return;
      const decision = decideLineage(w.lineage, ReplicaRoot.of(ROOT), fence);
      if (decision.kind !== "conflict") w.lineage = decision.lineage;
      return;
    }
    case "reader": {
      if (freshRestore(world) !== undefined) hit.add("fresh-reader");
      return;
    }
  }
}

/** Brute force: the highest started, confirmed and headed lineage. */
function bruteCurrent(world: World): number | undefined {
  const fences = [...world.records.entries()]
    .filter(([fence, r]) =>
      r.started?.replicaRoot === ROOT && r.confirmed !== undefined &&
      r.head?.fence === fence
    )
    .map(([fence]) => fence);
  return fences.length === 0 ? undefined : Math.max(...fences);
}

/**
 * The invariants, after every action.
 *
 * 1. `currentLineage` is the highest lineage under the root with `started`,
 *    `confirmed` and its own `head`.
 *
 * 2. Let R be what a fresh copy restores: the current lineage's replica up
 *    to its head's TXID, truncated to the head's high-water mark. Then R
 *    holds no commit twice, and:
 *    - every acknowledged commit, from any writer, is in R (through every
 *      takeover, crash, zombie and hold);
 *    - every commit in R that was never acknowledged is covered by the mark
 *      of a head some writer published and then did not acknowledge: that
 *      writer is still between its head and its lease check, or its lease
 *      check failed, or it crashed after publishing the head. No other
 *      unacknowledged commit (a zombie's unsynced or unheaded commits, a
 *      crashed command's commits before its head, commits past a mark)
 *      is ever restored.
 *    A writer's own unacknowledged commits left in its copy (D1: the next
 *    write replicates them) fall under the same rule: they reach R only
 *    through a head that covers them.
 *
 * 3. A writer never continues a lineage whose `started` was never published
 *    (checked where the model continues, and here for every recorded
 *    lineage: `mayContinueLineage` is false for an unpublished one, such as
 *    a recovery hold's). `mayContinueLineage`'s separate `started` check is
 *    implied by `newestStartedFence(...) === previous.lineageFence`, so
 *    dropping it alone changes nothing.
 */
function checkInvariants(world: World): void {
  const lineages = publishedList(world);
  assertEquals(
    currentLineage(lineages, ReplicaRoot.of(ROOT))?.fence,
    bruteCurrent(world),
  );

  const restored = freshRestore(world) ?? [];
  assertEquals(new Set(restored).size, restored.length, "duplicate commit");
  const missing = [...world.acked].filter((id) => !restored.includes(id));
  assertEquals(missing, [], "acknowledged commits lost by a restore");
  const inFlight = new Set(
    world.writers.flatMap((w) => w.session?.headed ?? []),
  );
  const extra = restored.filter((id) =>
    !world.acked.has(id) && !world.exposed.has(id) && !inFlight.has(id)
  );
  assertEquals(extra, [], "unacknowledged commits restored without a head");

  for (const w of world.writers) {
    if (w.lineage !== undefined && !isStarted(world, w.lineage.lineageFence)) {
      assert(
        !mayContinueLineage(w.lineage, lineages, ReplicaRoot.of(ROOT)),
        `unpublished lineage ${w.lineage.lineageFence} is continuable`,
      );
    }
  }
}

type Scenario = { writers: number; actions: readonly Action[] };

function run(scenario: Scenario, hit = new Set<Branch>()): World {
  const world: World = {
    maxFence: 0,
    records: new Map(),
    replicas: new Map(),
    writers: Array.from({ length: scenario.writers }, () => ({})),
    acked: new Set(),
    exposed: new Set(),
    nextCommit: 1,
  };
  for (const action of scenario.actions) {
    step(world, action, hit);
    checkInvariants(world);
  }
  return world;
}

const RUNS = 3000;

Deno.test("published lineage: takeovers, crashes, zombies and holds keep every acknowledged commit and restore only headed ones", () => {
  const counts = new Map<Branch, number>(BRANCHES.map((b) => [b, 0]));
  fc.assert(
    fc.property(arbScenario, (scenario) => {
      const hit = new Set<Branch>();
      try {
        run(scenario, hit);
      } finally {
        for (const branch of hit) counts.set(branch, counts.get(branch)! + 1);
      }
    }),
    { numRuns: RUNS },
  );
  console.log(
    `published lineage: runs (of ${RUNS}) reaching each branch:`,
    Object.fromEntries(counts),
  );
  for (const branch of BRANCHES) {
    assert(counts.get(branch)! > 0, `no run reached ${branch}`);
  }
});

/** An action; in-command kinds index the writers with a command running. */
function act(kind: ActionKind, w = 0): Action {
  return { kind, w, k: 1 };
}

const END = [
  act("sync"),
  act("publishHead"),
  act("publishConfirmed"),
  act("check"),
];

Deno.test("published lineage: a crash between confirmed and the lease check keeps the commits the lineage inherited", () => {
  // The counterexample to the old order (confirmed before head, and a
  // headless lineage restored with an empty mark).
  for (const crashAfter of ["publishHead", "publishConfirmed"] as const) {
    const world = run({
      writers: 2,
      actions: [
        act("begin", 0),
        act("commit"),
        ...END,
        act("begin", 1),
        act("sync"),
        act("publishHead"),
        ...(crashAfter === "publishConfirmed" ? [act("publishConfirmed")] : []),
        act("crash"),
      ],
    });
    assertEquals([...world.acked], ["c1"]);
    assertEquals(freshRestore(world), ["c1"]);
    assertEquals(
      currentLineage(publishedList(world), ReplicaRoot.of(ROOT))?.fence,
      crashAfter === "publishConfirmed" ? 2 : 1,
    );
  }
});

Deno.test("published lineage: a zombie that publishes its head late acknowledges nothing (ADV-14)", () => {
  // w0 syncs and pauses; w1 takes fence 2 from nothing; w0 then publishes
  // its head and confirmed late, and its lease check fails.
  const world = run({
    writers: 2,
    actions: [
      act("begin", 0),
      act("commit"),
      act("sync"),
      act("begin", 1),
      act("publishHead", 0),
      act("publishConfirmed", 0),
      act("check", 0),
      act("commit"),
      ...END,
    ],
  });
  assertEquals([...world.acked], ["c2"]);
  assertEquals([...world.exposed], ["c1"]);
  assertEquals(freshRestore(world), ["c2"]);
});
