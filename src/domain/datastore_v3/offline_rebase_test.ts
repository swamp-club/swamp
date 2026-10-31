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

import { assertEquals, assertRejects } from "@std/assert";
import { RESTATES_TAG } from "./latest_choice.ts";
import { rebaseOfflineCommits } from "./offline_rebase.ts";
import { tombstoneOp } from "./op.ts";
import {
  encodeMetadata,
  fixtureChanges,
  fixtureCommit,
  FixtureHistory,
  metadata,
  saveOps,
  toOps,
} from "./offline_rebase_test_helpers.ts";
import { Partition } from "./partition.ts";
import { partitionOf } from "./partition_key.ts";
import { MODEL_TYPE, modelIntent } from "./v3_test_helpers.ts";

const T0 = Date.parse("2026-10-30T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MINUTE = 60_000;

/** A history holding versions 1 and 2 of `name`, both committed at T0. */
async function historyWithTwo(name = "state"): Promise<FixtureHistory> {
  const history = new FixtureHistory();
  for (const version of [1, 2]) {
    history.append(fixtureCommit({
      seq: history.nextSeq,
      txnId: `online-${version}`,
      at: iso(T0),
      ops: await saveOps({ name, version, createdAt: iso(T0) }),
    }));
  }
  return history;
}

/** An offline save of `version` of `name`, run at `executedAt`. */
async function offlineSave(
  txnId: string,
  name: string,
  version: number,
  executedAt: number,
  clockOffsetMs?: number,
) {
  return fixtureCommit({
    seq: 1,
    txnId,
    at: iso(executedAt),
    executedAt: iso(executedAt),
    clockOffsetMs,
    // The writer's own clock, uncorrected, as the data repository stamps it.
    ops: await saveOps({
      name,
      version,
      text: `offline ${txnId}`,
      createdAt: iso(executedAt),
    }),
  });
}

Deno.test("rebaseOfflineCommits: renumbers past versions written meanwhile and keeps the txnId", async () => {
  const history = await historyWithTwo();
  // Written offline as version 2, which another checkout took meanwhile.
  const offline = await offlineSave("off-1", "state", 2, T0 + 30 * MINUTE);
  const [result] = await rebaseOfflineCommits(
    [offline],
    history.partition,
    history.lookups(),
    { encodeMetadata },
  );
  assertEquals(result.kind, "rebased");
  if (result.kind !== "rebased") return;
  assertEquals(result.renumbered, [{ name: "state", from: 2, to: 3 }]);
  assertEquals(result.latest, [{ name: "state", kind: "rebased", version: 3 }]);
  const landed = await history.land(result, iso(T0 + 31 * MINUTE));
  assertEquals(landed?.txnId, "off-1");
  assertEquals(history.partition.versions("state"), [1, 2, 3]);
  assertEquals(history.partition.latest("state"), 3);
});

Deno.test("rebaseOfflineCommits: keeps a version already above the high-water mark", async () => {
  const history = await historyWithTwo();
  const offline = await offlineSave("off-1", "state", 7, T0 + 30 * MINUTE);
  const [result] = await rebaseOfflineCommits(
    [offline],
    history.partition,
    history.lookups(),
    { encodeMetadata },
  );
  if (result.kind !== "rebased") throw new Error(result.kind);
  assertEquals(result.renumbered, [{ name: "state", from: 7, to: 7 }]);
  await history.land(result, iso(T0 + 31 * MINUTE));
  assertEquals(history.partition.latest("state"), 7);
});

Deno.test("rebaseOfflineCommits: inside the window the current latest is restated above the rebased version", async () => {
  const history = await historyWithTwo();
  // Observed 3 minutes after version 2 was committed: not clearly later.
  const offline = await offlineSave("off-1", "state", 2, T0 + 3 * MINUTE);
  const [result] = await rebaseOfflineCommits(
    [offline],
    history.partition,
    history.lookups(),
    { encodeMetadata },
  );
  if (result.kind !== "rebased") throw new Error(result.kind);
  assertEquals(result.latest, [
    { name: "state", kind: "restated", version: 4, restates: 2 },
  ]);
  await history.land(result, iso(T0 + 31 * MINUTE));
  assertEquals(history.partition.versions("state"), [1, 2, 3, 4]);
  assertEquals(history.partition.latest("state"), 4);
  const restated = history.lookups().content("state", 4);
  const original = history.lookups().content("state", 2);
  assertEquals(restated?.raw, original?.raw);
  assertEquals(restated?.metadata.tags[RESTATES_TAG], "2");
});

Deno.test("rebaseOfflineCommits: a write observed clearly earlier does not become latest", async () => {
  const history = await historyWithTwo();
  const offline = await offlineSave("off-1", "state", 2, T0 - 60 * MINUTE);
  const [result] = await rebaseOfflineCommits(
    [offline],
    history.partition,
    history.lookups(),
    { encodeMetadata },
  );
  if (result.kind !== "rebased") throw new Error(result.kind);
  assertEquals(result.latest[0].kind, "restated");
});

Deno.test("rebaseOfflineCommits: the clock offset decides an otherwise ambiguous write", async () => {
  const history = await historyWithTwo();
  // By its own clock 3 minutes later; serve's clock ran 10 minutes ahead.
  const offline = await offlineSave(
    "off-1",
    "state",
    2,
    T0 + 3 * MINUTE,
    10 * MINUTE,
  );
  const [result] = await rebaseOfflineCommits(
    [offline],
    history.partition,
    history.lookups(),
    { encodeMetadata },
  );
  if (result.kind !== "rebased") throw new Error(result.kind);
  assertEquals(result.latest, [{ name: "state", kind: "rebased", version: 3 }]);
});

Deno.test("rebaseOfflineCommits: a restatement is judged by its source's time, not its own commit", async () => {
  const history = await historyWithTwo();
  // A first flush, two hours later, restates version 2 as version 4.
  const first = await offlineSave("off-1", "state", 2, T0 + 1 * MINUTE);
  const [restating] = await rebaseOfflineCommits(
    [first],
    history.partition,
    history.lookups(),
    { encodeMetadata },
  );
  await history.land(restating, iso(T0 + 120 * MINUTE));
  // Observed 30 minutes after version 2: newer, though older than the
  // restatement's commit.
  const second = await offlineSave("off-2", "state", 3, T0 + 30 * MINUTE);
  const [result] = await rebaseOfflineCommits(
    [second],
    history.partition,
    history.lookups(),
    { encodeMetadata },
  );
  if (result.kind !== "rebased") throw new Error(result.kind);
  assertEquals(result.latest, [{ name: "state", kind: "rebased", version: 5 }]);
});

Deno.test("rebaseOfflineCommits: a compacted source falls back to its createdAt", async () => {
  const history = new FixtureHistory();
  history.append(fixtureCommit({
    seq: 1,
    txnId: "online-1",
    at: iso(T0),
    // The writer's clock ran 30 minutes ahead of serve's.
    ops: await saveOps({
      name: "state",
      version: 1,
      createdAt: iso(T0 + 30 * MINUTE),
    }),
  }));
  const offline = await offlineSave("off-1", "state", 1, T0 + 10 * MINUTE);
  // Judged by its commit time, T0, the offline write is clearly later.
  const [kept] = await rebaseOfflineCommits(
    [offline],
    history.partition,
    history.lookups(),
    { encodeMetadata },
  );
  if (kept.kind !== "rebased") throw new Error(kept.kind);
  assertEquals(kept.latest[0].kind, "rebased");
  history.compacted.add("state@1");
  const [compacted] = await rebaseOfflineCommits(
    [offline],
    history.partition,
    history.lookups(),
    { encodeMetadata },
  );
  if (compacted.kind !== "rebased") throw new Error(compacted.kind);
  // With the commit gone, only createdAt is left: the write is earlier.
  assertEquals(compacted.latest[0].kind, "restated");
});

Deno.test("rebaseOfflineCommits: a forged future createdAt cannot make a version look newer than its commit", async () => {
  const history = new FixtureHistory();
  history.append(fixtureCommit({
    seq: 1,
    txnId: "online-1",
    at: iso(T0),
    ops: await saveOps({
      name: "state",
      version: 1,
      createdAt: iso(T0 + 1000 * MINUTE),
    }),
  }));
  const offline = await offlineSave("off-1", "state", 1, T0 + 10 * MINUTE);
  const [result] = await rebaseOfflineCommits(
    [offline],
    history.partition,
    history.lookups(),
    { encodeMetadata },
  );
  if (result.kind !== "rebased") throw new Error(result.kind);
  assertEquals(result.latest[0].kind, "rebased");
});

Deno.test("rebaseOfflineCommits: a landed offline version keeps its corrected time as createdAt", async () => {
  const history = await historyWithTwo();
  const offline = await offlineSave(
    "off-1",
    "state",
    2,
    T0 + 30 * MINUTE,
    2 * MINUTE,
  );
  const [result] = await rebaseOfflineCommits(
    [offline],
    history.partition,
    history.lookups(),
    { encodeMetadata },
  );
  await history.land(result, iso(T0 + 300 * MINUTE));
  assertEquals(
    history.lookups().content("state", 3)?.metadata.createdAt,
    iso(T0 + 32 * MINUTE),
  );
});

Deno.test("rebaseOfflineCommits: a forged restates tag names a version, never a time", async () => {
  const history = new FixtureHistory();
  history.append(fixtureCommit({
    seq: 1,
    txnId: "online-1",
    at: iso(T0),
    ops: await saveOps({ name: "state", version: 1, createdAt: iso(T0) }),
  }));
  // Version 2 claims to restate version 1 but was committed later.
  history.append(fixtureCommit({
    seq: 2,
    txnId: "online-2",
    at: iso(T0 + 60 * MINUTE),
    ops: await saveOps({
      name: "state",
      version: 2,
      tags: { [RESTATES_TAG]: "1" },
      createdAt: iso(T0 + 60 * MINUTE),
    }),
  }));
  const offline = await offlineSave("off-1", "state", 2, T0 + 10 * MINUTE);
  const [result] = await rebaseOfflineCommits(
    [offline],
    history.partition,
    history.lookups(),
    { encodeMetadata },
  );
  if (result.kind !== "rebased") throw new Error(result.kind);
  // Judged against version 1's own commit time, T0: 10 minutes later wins.
  assertEquals(result.latest[0].kind, "rebased");
});

Deno.test("rebaseOfflineCommits: restating is skipped when disabled, unknown or renamed", async () => {
  const history = await historyWithTwo();
  const offline = await offlineSave("off-1", "state", 2, T0 + 1 * MINUTE);
  const [disabled] = await rebaseOfflineCommits(
    [offline],
    history.partition,
    history.lookups(),
    { encodeMetadata, restate: false },
  );
  if (disabled.kind !== "rebased") throw new Error(disabled.kind);
  assertEquals(disabled.latest, [{
    name: "state",
    kind: "rebased",
    version: 3,
    restateSkipped: "disabled",
  }]);
  const [unknown] = await rebaseOfflineCommits(
    [offline],
    history.partition,
    { ...history.lookups(), content: () => undefined },
    { encodeMetadata },
  );
  if (unknown.kind !== "rebased") throw new Error(unknown.kind);
  assertEquals(unknown.latest[0], {
    name: "state",
    kind: "rebased",
    version: 3,
    restateSkipped: "content-unknown",
  });
  const lookups = history.lookups();
  const [renamed] = await rebaseOfflineCommits(
    [offline],
    history.partition,
    {
      ...lookups,
      content: (name, version) => {
        const found = lookups.content(name, version);
        return found === undefined
          ? undefined
          : { ...found, metadata: { ...found.metadata, renamedTo: "other" } };
      },
    },
    { encodeMetadata },
  );
  if (renamed.kind !== "rebased") throw new Error(renamed.kind);
  assertEquals(renamed.latest[0].kind, "rebased");
});

Deno.test("rebaseOfflineCommits: commits rebased together never share a version, and an append follows its version", async () => {
  const history = await historyWithTwo();
  const first = await offlineSave("off-1", "state", 3, T0 + 30 * MINUTE);
  // A later offline commit appends to the version the first one wrote.
  const changes = fixtureChanges();
  const appendMeta = metadata("state", 3);
  const appended = await toOps(changes.writeVersion({ kind: "data.append" }, {
    name: "state",
    version: 3,
    metadata: appendMeta,
    metadataBytes: encodeMetadata(appendMeta),
    raw: new TextEncoder().encode("more"),
  }));
  const second = fixtureCommit({
    seq: 2,
    txnId: "off-2",
    executedAt: iso(T0 + 31 * MINUTE),
    ops: appended,
  });
  // Meanwhile serve took version 3.
  history.append(fixtureCommit({
    seq: history.nextSeq,
    txnId: "online-3",
    at: iso(T0 + 5 * MINUTE),
    ops: await saveOps({ name: "state", version: 3 }),
  }));
  const results = await rebaseOfflineCommits(
    [first, second],
    history.partition,
    history.lookups(),
    { encodeMetadata },
  );
  const servesThree = history.partition.record(
    fixtureChanges().dataKey("state", 3, "raw"),
  );
  for (const result of results) {
    await history.land(result, iso(T0 + 40 * MINUTE));
  }
  assertEquals(history.partition.versions("state"), [1, 2, 3, 4]);
  const [, appendResult] = results;
  if (appendResult.kind !== "rebased") throw new Error(appendResult.kind);
  const appendedVersions = (await toOps(appendResult.changes))
    .filter((op) => op.kind === "data-version")
    .map((op) => op.kind === "data-version" ? op.metadata.version : 0);
  assertEquals(appendedVersions, [4]);
  // Serve's version 3 was not touched by the append.
  assertEquals(
    history.partition.record(fixtureChanges().dataKey("state", 3, "raw")),
    servesThree,
  );
});

Deno.test("rebaseOfflineCommits: a removal whose target is gone rejects the whole commit", async () => {
  const history = await historyWithTwo();
  const removal = fixtureCommit({
    seq: 1,
    txnId: "off-del",
    executedAt: iso(T0 + 10 * MINUTE),
    ops: await toOps(fixtureChanges().removeVersion("data.delete", "state", 1)),
  });
  // Another checkout removed version 1 meanwhile.
  history.append(fixtureCommit({
    seq: history.nextSeq,
    txnId: "online-del",
    ops: await toOps(fixtureChanges().removeVersion("data.delete", "state", 1)),
  }));
  const [result] = await rebaseOfflineCommits(
    [removal],
    history.partition,
    history.lookups(),
    { encodeMetadata },
  );
  assertEquals(result.kind, "rejected");
});

Deno.test("rebaseOfflineCommits: a removal whose record changed is rejected", async () => {
  const history = await historyWithTwo();
  const key = fixtureChanges().dataKey("state", 1, "raw");
  const removal = fixtureCommit({
    seq: 1,
    txnId: "off-del",
    ops: [tombstoneOp({
      intent: modelIntent({ kind: "data.delete", name: "state", version: 1 }),
      key,
      expect: { sha256: "0".repeat(64) },
    })],
  });
  const [result] = await rebaseOfflineCommits(
    [removal],
    history.partition,
    history.lookups(),
    { encodeMetadata },
  );
  assertEquals(result.kind, "rejected");
  const current = history.partition.record(key)!.sha256;
  const matching = fixtureCommit({
    seq: 1,
    txnId: "off-del-2",
    ops: [tombstoneOp({
      intent: modelIntent({ kind: "data.delete", name: "state", version: 1 }),
      key,
      expect: { sha256: current },
    })],
  });
  const [kept] = await rebaseOfflineCommits(
    [matching],
    history.partition,
    history.lookups(),
    { encodeMetadata },
  );
  assertEquals(kept.kind, "rebased");
});

Deno.test("rebaseOfflineCommits: a commit with nothing to rebase is unchanged", async () => {
  const history = await historyWithTwo();
  const output = fixtureCommit({
    seq: 1,
    txnId: "off-out",
    ops: await toOps([
      fixtureChanges().writeOutput(
        "out-1",
        "apply",
        "out-1.yaml",
        new TextEncoder().encode("x"),
      ),
    ]),
  });
  const [result] = await rebaseOfflineCommits(
    [output],
    history.partition,
    history.lookups(),
    { encodeMetadata },
  );
  assertEquals(result.kind, "unchanged");
});

Deno.test("rebaseOfflineCommits: refuses a commit for another partition", async () => {
  const offline = await offlineSave("off-1", "state", 1, T0);
  const other = Partition.empty(
    partitionOf({
      kind: "model",
      type: MODEL_TYPE,
      id: "11111111-2222-4333-8444-555555555555",
    }),
  );
  await assertRejects(
    () =>
      rebaseOfflineCommits([offline], other, {
        observation: () => undefined,
        content: () => undefined,
      }, { encodeMetadata }),
    Error,
    "is for",
  );
});
