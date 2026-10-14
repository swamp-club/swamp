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

import { assertEquals, assertThrows } from "@std/assert";
import {
  collectableLineages,
  compareTxid,
  currentLineage,
  decideLocalCopy,
  type LineageHead,
  mayContinueLineage,
  normalizeTxid,
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
  assertEquals(currentLineage(lineages, ROOT)?.fence, 7);
});

Deno.test("currentLineage: nothing confirmed is no current state", () => {
  assertEquals(currentLineage([published(3)], ROOT), undefined);
  assertEquals(currentLineage([], ROOT), undefined);
});

Deno.test("decideLocalCopy: nothing published leaves the copy as it is", () => {
  assertEquals(decideLocalCopy(undefined, [published(3)], ROOT), {
    kind: "none",
  });
});

Deno.test("decideLocalCopy: a missing copy restores the current lineage at its head", () => {
  const decision = decideLocalCopy(
    undefined,
    [published(3, { confirmed: 2, head: 5 })],
    ROOT,
  );
  assertEquals(decision.kind, "missing");
  if (decision.kind === "missing") {
    assertEquals(decision.lineage.head.txid, txid(5));
  }
});

Deno.test("decideLocalCopy: a copy at the head is current and downloads nothing", () => {
  const lineages = [published(3, { confirmed: 2, head: 5 })];
  const copy = { replicaRoot: ROOT, lineageFence: 3, txid: txid(5) };
  assertEquals(decideLocalCopy({ copy }, lineages, ROOT), { kind: "current" });
  assertEquals(
    decideLocalCopy({ copy: { ...copy, txid: txid(9) } }, lineages, ROOT),
    { kind: "current" },
  );
});

Deno.test("decideLocalCopy: a copy below the head is behind", () => {
  const decision = decideLocalCopy(
    { copy: { replicaRoot: ROOT, lineageFence: 3, txid: txid(4) } },
    [published(3, { confirmed: 2, head: 5 })],
    ROOT,
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
      decideLocalCopy({ ...(copy ? { copy } : {}) }, lineages, ROOT).kind,
      "foreign",
    );
  }
});

Deno.test("decideLocalCopy: a writer's own newest pending lineage is current", () => {
  const lineages = [published(3, { confirmed: 2, head: 5 }), published(8)];
  const copy = { replicaRoot: ROOT, lineageFence: 3, txid: txid(5) };
  assertEquals(decideLocalCopy({ copy, lineage: own(8, 9) }, lineages, ROOT), {
    kind: "current",
  });
  // Another writer started after it: this copy's pending commits were never
  // acknowledged, and the current state is restored.
  assertEquals(
    decideLocalCopy(
      { copy: { ...copy, txid: txid(4) }, lineage: own(8, 9) },
      [...lineages, published(10)],
      ROOT,
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
  assertEquals(currentLineage(lineages, ROOT)?.fence, 2);
  assertEquals(
    decideLocalCopy(undefined, [published(4, { confirmed: 3 })], ROOT),
    {
      kind: "none",
    },
  );
});

Deno.test("mayContinueLineage: only a published lineage nothing started after", () => {
  const lineages = [published(3, { confirmed: 1, head: 1 }), published(5)];
  assertEquals(mayContinueLineage(own(5, 6), lineages, ROOT), true);
  assertEquals(mayContinueLineage(own(3, 4), lineages, ROOT), false);
  // Recorded by a recovery hold, never published.
  assertEquals(mayContinueLineage(own(7), lineages, ROOT), false);
  assertEquals(mayContinueLineage(undefined, lineages, ROOT), false);
  assertEquals(
    mayContinueLineage(
      { ...own(5), replicaRoot: "file:/other" },
      lineages,
      ROOT,
    ),
    false,
  );
});

Deno.test("restartLineage: keeps the replaced lineage for collection", () => {
  assertEquals(restartLineage(own(3, 4), ROOT, 9), {
    replicaRoot: ROOT,
    lineageFence: 9,
    lastFence: 9,
    previousLineages: [{ replicaRoot: ROOT, fence: 3 }],
  });
  assertEquals(restartLineage(undefined, ROOT, 2).previousLineages, []);
  assertThrows(() => restartLineage(undefined, ROOT, 0));
});

Deno.test("collectableLineages: below the current one, under the root only", () => {
  const lineages = [
    published(2, { confirmed: 1 }),
    published(4),
    published(5, { root: "file:/other" }),
    published(6, { confirmed: 1 }),
    published(8),
  ];
  assertEquals(collectableLineages(lineages, [1, 6, 7], ROOT, 6), [1, 2, 4]);
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
