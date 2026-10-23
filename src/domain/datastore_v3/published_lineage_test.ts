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

import { ReplicaRoot } from "./replica_root.ts";
import { assertEquals, assertThrows } from "@std/assert";
import {
  collectableLineages,
  compareTxid,
  copyNeverRestored,
  copyStateAdvances,
  currentLineage,
  decideChunkCollection,
  decideLocalCopy,
  type LineageHead,
  lineagesKeptForFork,
  mayContinueLineage,
  normalizeTxid,
  outrankingForeignLineage,
  parseLineageConfirmed,
  parseLineageHead,
  parseLineageStarted,
  parseLocalCopyState,
  type PublishedLineage,
  restartLineage,
  serializeLineageRecord,
} from "./published_lineage.ts";
import type { ReplicationLineage } from "./replication_lineage.ts";

const ROOT = "file:/replica";
const AT = "2026-10-14T00:00:00.000Z";

function txid(n: number): string {
  return n.toString(16).padStart(16, "0");
}

function head(fence: number, at: number, cursor = at): LineageHead {
  return {
    fence,
    txid: txid(at),
    writerFence: fence,
    mark: cursor === 0 ? { cursor: 0 } : {
      cursor,
      commit: {
        namespace: "",
        partition: "data/a",
        seq: cursor,
        txnId: `t${cursor}`,
      },
    },
    publishedAt: AT,
  };
}

function published(
  fence: number,
  options: {
    confirmed?: number;
    head?: number;
    root?: string;
  } = {},
): PublishedLineage {
  return {
    fence,
    started: {
      fence,
      holder: "me@host",
      replicaRoot: options.root ?? ROOT,
      startedAt: AT,
    },
    ...(options.confirmed !== undefined
      ? {
        confirmed: { fence, txid: txid(options.confirmed), confirmedAt: AT },
      }
      : {}),
    ...(options.head !== undefined ? { head: head(fence, options.head) } : {}),
  };
}

function own(
  lineageFence: number,
  lastFence = lineageFence,
): ReplicationLineage {
  return { replicaRoot: ROOT, lineageFence, lastFence, previousLineages: [] };
}

Deno.test("currentLineage: the highest confirmed lineage under the root", () => {
  const lineages = [
    published(3, { confirmed: 1, head: 4 }),
    published(7, { confirmed: 1, head: 2 }),
    published(9),
    published(11, { confirmed: 1, root: "file:/other" }),
  ];
  assertEquals(currentLineage(lineages, ReplicaRoot.of(ROOT))?.fence, 7);
});

Deno.test("currentLineage: nothing confirmed is no current state", () => {
  assertEquals(currentLineage([published(3)], ReplicaRoot.of(ROOT)), undefined);
  assertEquals(currentLineage([], ReplicaRoot.of(ROOT)), undefined);
});

Deno.test("copyNeverRestored: a missing copy, or one no restore or writer recorded, never held the state", () => {
  assertEquals(copyNeverRestored(undefined), true);
  assertEquals(copyNeverRestored({}), true);
});

Deno.test("copyNeverRestored: a restored copy, or a writer's own, held the state", () => {
  const copy = { replicaRoot: ROOT, lineageFence: 3, txid: txid(5) };
  assertEquals(copyNeverRestored({ copy }), false);
  assertEquals(copyNeverRestored({ lineage: own(4) }), false);
  assertEquals(copyNeverRestored({ copy, lineage: own(4) }), false);
});

Deno.test("decideLocalCopy: nothing published leaves the copy as it is", () => {
  assertEquals(
    decideLocalCopy(undefined, [published(3)], ReplicaRoot.of(ROOT)),
    {
      kind: "none",
    },
  );
});

Deno.test("decideLocalCopy: a missing copy restores the current lineage at its head", () => {
  const decision = decideLocalCopy(
    undefined,
    [published(3, { confirmed: 2, head: 5 })],
    ReplicaRoot.of(ROOT),
  );
  assertEquals(decision.kind, "missing");
  if (decision.kind === "missing") {
    assertEquals(decision.lineage.head.txid, txid(5));
  }
});

Deno.test("decideLocalCopy: a copy at the head is current and downloads nothing", () => {
  const lineages = [published(3, { confirmed: 2, head: 5 })];
  const copy = { replicaRoot: ROOT, lineageFence: 3, txid: txid(5) };
  assertEquals(decideLocalCopy({ copy }, lineages, ReplicaRoot.of(ROOT)), {
    kind: "current",
  });
  assertEquals(
    decideLocalCopy(
      { copy: { ...copy, txid: txid(9) } },
      lineages,
      ReplicaRoot.of(ROOT),
    ),
    { kind: "current" },
  );
});

Deno.test("decideLocalCopy: a copy below the head is behind", () => {
  const decision = decideLocalCopy(
    { copy: { replicaRoot: ROOT, lineageFence: 3, txid: txid(4) } },
    [published(3, { confirmed: 2, head: 5 })],
    ReplicaRoot.of(ROOT),
  );
  assertEquals(decision.kind, "behind");
});

Deno.test("decideLocalCopy: a copy of another lineage or root is foreign", () => {
  const lineages = [
    published(3, { confirmed: 2, head: 2 }),
    published(6, {
      confirmed: 1,
      head: 2,
    }),
  ];
  for (
    const copy of [
      { replicaRoot: ROOT, lineageFence: 3, txid: txid(9) },
      { replicaRoot: "file:/other", lineageFence: 6, txid: txid(9) },
      undefined,
    ]
  ) {
    assertEquals(
      decideLocalCopy(
        { ...(copy ? { copy } : {}) },
        lineages,
        ReplicaRoot.of(ROOT),
      ).kind,
      "foreign",
    );
  }
});

Deno.test("decideLocalCopy: a writer's own newest pending lineage is current", () => {
  const lineages = [published(3, { confirmed: 2, head: 5 }), published(8)];
  const copy = { replicaRoot: ROOT, lineageFence: 3, txid: txid(5) };
  assertEquals(
    decideLocalCopy(
      { copy, lineage: own(8, 9) },
      lineages,
      ReplicaRoot.of(ROOT),
    ),
    {
      kind: "current",
    },
  );
  // A fenced writer published a later head on the old lineage since: it
  // covers nothing acknowledged, and the copy stays current.
  assertEquals(
    decideLocalCopy(
      { copy: { ...copy, txid: txid(4) }, lineage: own(8, 9) },
      [published(3, { confirmed: 2, head: 7 }), published(8)],
      ReplicaRoot.of(ROOT),
    ),
    { kind: "current" },
  );
  // Another writer started after it: this copy's pending commits were never
  // acknowledged, and the current state is restored.
  assertEquals(
    decideLocalCopy(
      { copy: { ...copy, txid: txid(4) }, lineage: own(8, 9) },
      [...lineages, published(10)],
      ReplicaRoot.of(ROOT),
    ).kind,
    "behind",
  );
});

Deno.test("currentLineage: a confirmed lineage without a head is not the current state", () => {
  // Its writer crashed between the head and the confirmation, or a record
  // was lost: the lineage before it still holds every acknowledged commit.
  const lineages = [
    published(2, { confirmed: 1, head: 3 }),
    published(4, { confirmed: 3 }),
  ];
  assertEquals(currentLineage(lineages, ReplicaRoot.of(ROOT))?.fence, 2);
  assertEquals(
    decideLocalCopy(
      undefined,
      [published(4, { confirmed: 3 })],
      ReplicaRoot.of(ROOT),
    ),
    {
      kind: "none",
    },
  );
});

Deno.test("mayContinueLineage: only a published lineage nothing started after", () => {
  const lineages = [published(3, { confirmed: 1, head: 1 }), published(5)];
  assertEquals(
    mayContinueLineage(own(5, 6), lineages, ReplicaRoot.of(ROOT)),
    true,
  );
  assertEquals(
    mayContinueLineage(own(3, 4), lineages, ReplicaRoot.of(ROOT)),
    false,
  );
  // Recorded by a recovery hold, never published.
  assertEquals(
    mayContinueLineage(own(7), lineages, ReplicaRoot.of(ROOT)),
    false,
  );
  assertEquals(
    mayContinueLineage(undefined, lineages, ReplicaRoot.of(ROOT)),
    false,
  );
  assertEquals(
    mayContinueLineage(
      { ...own(5), replicaRoot: "file:/other" },
      lineages,
      ReplicaRoot.of(ROOT),
    ),
    false,
  );
});

Deno.test("restartLineage: keeps the replaced lineage for collection", () => {
  assertEquals(restartLineage(own(3, 4), ReplicaRoot.of(ROOT), 9), {
    replicaRoot: ROOT,
    lineageFence: 9,
    lastFence: 9,
    previousLineages: [{ replicaRoot: ROOT, fence: 3 }],
  });
  assertEquals(
    restartLineage(undefined, ReplicaRoot.of(ROOT), 2).previousLineages,
    [],
  );
  assertThrows(() => restartLineage(undefined, ReplicaRoot.of(ROOT), 0));
});

Deno.test("collectableLineages: below the current one, under the root only", () => {
  const lineages = [
    published(2, { confirmed: 1 }),
    published(4),
    published(5, { root: "file:/other" }),
    published(6, { confirmed: 1 }),
    published(8),
  ];
  assertEquals(
    collectableLineages(lineages, [1, 6, 7], ReplicaRoot.of(ROOT), 6),
    [1, 2, 4],
  );
});

Deno.test("compareTxid and normalizeTxid: numeric order across renderings", () => {
  assertEquals(normalizeTxid(10), "000000000000000a");
  assertEquals(normalizeTxid("A"), "000000000000000a");
  assertEquals(normalizeTxid("xyz"), undefined);
  assertEquals(normalizeTxid(-1), undefined);
  assertEquals(compareTxid("a", "0000000000000009"), 1);
  assertEquals(compareTxid("1", "0000000000000001"), 0);
  assertThrows(() => compareTxid("g", "1"));
});

Deno.test("parse*: records round-trip and malformed ones are dropped", () => {
  const started = published(3).started!;
  const reread = (record: Parameters<typeof serializeLineageRecord>[0]) =>
    JSON.parse(serializeLineageRecord(record));
  assertEquals(parseLineageStarted(reread(started)), started);
  const confirmed = {
    fence: 3,
    txid: txid(2),
    confirmedAt: AT,
  };
  assertEquals(parseLineageConfirmed(reread(confirmed)), confirmed);
  assertEquals(parseLineageHead(reread(head(3, 5))), head(3, 5));
  assertEquals(parseLineageHead(reread(head(3, 5, 0))), head(3, 5, 0));
  const copy = { replicaRoot: ROOT, lineageFence: 3, txid: txid(1) };
  assertEquals(parseLocalCopyState(reread(copy)), copy);

  assertEquals(parseLineageStarted({ ...started }), undefined, "no format");
  assertEquals(
    parseLineageStarted({ ...reread(started), fence: 0 }),
    undefined,
  );
  assertEquals(
    parseLineageHead({
      ...reread(head(3, 5)),
      mark: { cursor: 4, commit: { seq: 1 } },
    }),
    undefined,
  );
  assertEquals(
    parseLineageConfirmed({ ...reread(confirmed), txid: "../x" }),
    undefined,
  );
  assertEquals(parseLocalCopyState([]), undefined);
});

Deno.test("copyStateAdvances: only a newer lineage, or a newer TXID on the same one", () => {
  const at = (lineageFence: number, n: number, replicaRoot = ROOT) => ({
    replicaRoot,
    lineageFence,
    txid: txid(n),
  });
  assertEquals(copyStateAdvances(undefined, at(3, 1)), true);
  assertEquals(copyStateAdvances(at(3, 5), at(3, 6)), true);
  assertEquals(copyStateAdvances(at(3, 5), at(3, 5)), false);
  assertEquals(copyStateAdvances(at(3, 5), at(3, 4)), false);
  assertEquals(copyStateAdvances(at(3, 5), at(4, 1)), true);
  // A fenced process publishing late on an older lineage never moves it back.
  assertEquals(copyStateAdvances(at(4, 1), at(3, 9)), false);
  assertEquals(copyStateAdvances(at(4, 9, "file:/other"), at(3, 1)), true);
});

Deno.test("decideChunkCollection: only from the current lineage's head, with nothing else restorable", () => {
  const copy = { replicaRoot: ROOT, lineageFence: 7, txid: txid(4) };
  const current = published(7, { confirmed: 1, head: 4 });
  assertEquals(
    decideChunkCollection(copy, [current], ReplicaRoot.of(ROOT)).kind,
    "collect",
  );
  // Another root's lineage is never restored here.
  assertEquals(
    decideChunkCollection(
      copy,
      [published(3, { confirmed: 1, head: 9, root: "file:/other" }), current],
      ReplicaRoot.of(ROOT),
    ).kind,
    "collect",
  );
  const deferred = (
    held: typeof copy | undefined,
    lineages: PublishedLineage[],
  ) => decideChunkCollection(held, lineages, ReplicaRoot.of(ROOT)).kind;
  assertEquals(deferred(copy, []), "defer");
  assertEquals(deferred(copy, [published(7)]), "defer");
  assertEquals(deferred(undefined, [current]), "defer");
  assertEquals(deferred({ ...copy, txid: txid(3) }, [current]), "defer");
  assertEquals(deferred({ ...copy, lineageFence: 5 }, [current]), "defer");
  // An older lineage under the root still restorable, a newer one that may
  // yet be confirmed, and one whose start was not read.
  assertEquals(
    deferred(copy, [published(5, { confirmed: 1, head: 9 }), current]),
    "defer",
  );
  assertEquals(deferred(copy, [current, published(9)]), "defer");
  assertEquals(deferred(copy, [{ fence: 5 }, current]), "defer");
  const unreadable = decideChunkCollection(
    copy,
    [{ fence: 5 }, current],
    ReplicaRoot.of(ROOT),
  );
  assertEquals(
    unreadable.kind === "defer" &&
      unreadable.reason.includes("_control/lineage/000000000005/"),
    true,
  );
});

const S3_OWN = ReplicaRoot.s3("http://localhost:47441", "bucket", "prefix");
const S3_OTHER_SPELLING = "s3:http://localhost:47411/:bucket:prefix";

Deno.test("currentLineage: a lineage another spelling of the S3 endpoint started is this replica's (swamp-club#3801)", () => {
  const lineages = [
    published(3, { confirmed: 1, head: 1, root: S3_OTHER_SPELLING }),
  ];
  assertEquals(currentLineage(lineages, S3_OWN)?.fence, 3);
  assertEquals(
    decideLocalCopy(undefined, lineages, S3_OWN),
    { kind: "missing", lineage: currentLineage(lineages, S3_OWN)! },
  );
  assertEquals(
    currentLineage(lineages, ReplicaRoot.s3(undefined, "bucket", "other")),
    undefined,
  );
});

Deno.test("outrankingForeignLineage: only a lineage under another root that would decide the state (swamp-club#3801)", () => {
  const foreign = "s3:http://localhost:47441:other:prefix";
  // Nothing published: nothing to refuse.
  assertEquals(outrankingForeignLineage([], S3_OWN), undefined);
  // Another spelling of this replica's endpoint is not foreign.
  assertEquals(
    outrankingForeignLineage(
      [published(4, { confirmed: 1, head: 1, root: S3_OTHER_SPELLING })],
      S3_OWN,
    ),
    undefined,
  );
  // Under another root, with none under this one: refused.
  assertEquals(
    outrankingForeignLineage(
      [published(2, { confirmed: 1, head: 1, root: foreign })],
      S3_OWN,
    )?.fence,
    2,
  );
  // Above this replica's newest start, even unconfirmed: a writer may be
  // about to confirm it. The highest one is named.
  assertEquals(
    outrankingForeignLineage(
      [
        published(9, { root: foreign }),
        published(7, { root: foreign }),
        published(5, { confirmed: 1, head: 1, root: S3_OTHER_SPELLING }),
      ],
      S3_OWN,
    )?.fence,
    9,
  );
  // Below a lineage this replica started later: history, ignored.
  assertEquals(
    outrankingForeignLineage(
      [
        published(6, { root: S3_OWN.value }),
        published(5, { confirmed: 1, head: 1, root: foreign }),
      ],
      S3_OWN,
    ),
    undefined,
  );
  // A lineage whose start was not read names no root: never refused.
  assertEquals(
    outrankingForeignLineage([{ fence: 8 }], S3_OWN),
    undefined,
  );
});

Deno.test("lineagesKeptForFork: keeps lineages a swamp before swamp-club#3801 left under two spellings, unless the current chain continues them", () => {
  const a = "s3::bucket:prefix";
  const b = "s3:http://proxy:1:bucket:prefix";
  const start = (fence: number, replicaRoot: string, follows?: number) => ({
    fence,
    holder: "h",
    replicaRoot,
    startedAt: AT,
    ...(follows !== undefined ? { follows } : {}),
  });
  const starts = (...list: ReturnType<typeof start>[]) =>
    new Map(list.map((s) => [s.fence, s]));
  // One history: nothing kept, whatever the spellings of later lineages.
  assertEquals(
    lineagesKeptForFork(
      starts(start(1, a), start(2, a), start(5, b, 2), start(6, a, 5)),
      6,
    ),
    new Set(),
  );
  // Forked: only what the current lineage's chain continues may go.
  assertEquals(
    lineagesKeptForFork(
      starts(
        start(1, a),
        start(2, b),
        start(3, a),
        start(4, b),
        start(5, a, 4),
        start(6, b, 5),
      ),
      6,
    ),
    new Set([1, 2, 3]),
  );
  // A chain that loops on a malformed record still ends.
  assertEquals(
    lineagesKeptForFork(
      starts(start(1, a), start(2, b), start(3, a, 3), start(4, a, 3)),
      4,
    ),
    new Set([1, 2]),
  );
});

Deno.test("parseLineageStarted: reads a lower follows fence, and drops one that is not", () => {
  const base = { fence: 5, holder: "h", replicaRoot: ROOT, startedAt: AT };
  const read = (record: Record<string, unknown>) =>
    parseLineageStarted(
      JSON.parse(serializeLineageRecord(record as typeof base)),
    );
  assertEquals(read({ ...base, follows: 3 })?.follows, 3);
  assertEquals(read({ ...base, follows: 5 })?.follows, undefined);
  assertEquals(read({ ...base, follows: "3" })?.follows, undefined);
  assertEquals(read(base), base);
});
