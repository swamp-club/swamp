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

import { assert, assertEquals, assertRejects } from "@std/assert";
import type { Commit } from "../../domain/datastore_v3/commit.ts";
import {
  COMPACTED_TXN_RETENTION_MS,
  type OutboxEntry,
  type OutboxEntryState,
} from "../../domain/datastore_v3/commit_outbox.ts";
import type { DataMetadata } from "../../domain/data/data_metadata.ts";
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
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
import type { Op } from "../../domain/datastore_v3/op.ts";
import { initializeLogging } from "../logging/logger.ts";
import {
  flushOfflineEntries,
  latestAtEndOf,
  type OfflineFlushPort,
} from "./offline_flush.ts";
import {
  ChunkNotCachedError,
  ServeAuthFailedError,
  ServeCommitMayLandError,
  ServeCommitRefusedError,
  ServeUnreachableError,
  ServeUpstreamError,
} from "./serve_upstream_errors.ts";
import {
  resetServeOfflineForTesting,
  type ServeOfflineNotice,
  setServeOfflineNoticeWriter,
} from "./serve_offline.ts";

await initializeLogging({});

const WRITER = { host: "host-b", pid: 7, instance: "cli-flush" };

/** What one send does: land, or fail with an error. */
type Answer = "land" | Error;

/** A serve over a {@link FixtureHistory}, answering sends in turn. */
class FakePort implements OfflineFlushPort {
  readonly history = new FixtureHistory();
  readonly commits: Commit[] = [];
  readonly sends: string[] = [];
  readonly marks: string[] = [];
  readonly settled: string[] = [];
  readonly quarantinedEntries: string[] = [];
  readonly sentMaybe: string[] = [];
  answers: Answer[] = [];
  /** Compacted versions the checkout's files hold, by `name@version`. */
  readonly compactedFiles = new Map<
    string,
    { readonly metadata: DataMetadata; readonly raw?: Uint8Array }
  >();
  compactedSeq = 0;
  /** Offline entries flushes landed, as the outbox records them. */
  readonly ownTxnIds = new Set<string>();

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
  send(commit: Commit, leaseId: string | undefined): Promise<unknown> {
    this.sends.push(`${commit.txnId} lease=${leaseId ?? "none"}`);
    const answer = this.answers.shift() ?? "land";
    if (answer instanceof Error) return Promise.reject(answer);
    this.history.append(commit);
    this.commits.push(commit);
    return Promise.resolve();
  }
  encodeMetadata = encodeMetadata;
  storeChunks(): never {
    throw new Error("the fixtures inline everything");
  }
  mark(
    keys: readonly { txnId: string }[],
    state: OutboxEntryState,
  ): Promise<void> {
    for (const key of keys) this.marks.push(`${key.txnId} ${state}`);
    return Promise.resolve();
  }
  settle(keys: readonly { txnId: string }[]): Promise<void> {
    for (const key of keys) this.settled.push(key.txnId);
    return Promise.resolve();
  }
  /** What landed offline entries left for later ones, as the outbox keeps it. */
  carry: OfflineRebaseCarry = EMPTY_REBASE_CARRY;
  recordOwnLanded(
    key: { txnId: string },
    _at: number,
    carry?: OfflineRebaseCarry,
  ): Promise<void> {
    this.ownTxnIds.add(key.txnId);
    if (carry !== undefined) this.carry = mergeRebaseCarry(this.carry, carry);
    return Promise.resolve();
  }
  landedCarry(): Promise<OfflineRebaseCarry> {
    return Promise.resolve(this.carry);
  }
  ownLanded(): Promise<ReadonlySet<string>> {
    return Promise.resolve(new Set(this.ownTxnIds));
  }
  quarantined(entry: OutboxEntry): Promise<void> {
    this.quarantinedEntries.push(entry.commit.txnId);
    return Promise.resolve();
  }
  markSentMaybe(key: { txnId: string }, at: number): Promise<void> {
    this.sentMaybe.push(`${key.txnId} ${new Date(at).toISOString()}`);
    return Promise.resolve();
  }
  compactedThrough(): Promise<number> {
    return Promise.resolve(this.compactedSeq);
  }
  compactedVersion(
    _namespace: string,
    _partition: unknown,
    name: string,
    version: number,
  ) {
    return Promise.resolve(this.compactedFiles.get(`${name}@${version}`));
  }

  /** Lands `commit` as serve's own, as another writer's did meanwhile. */
  land(commit: Commit): void {
    this.history.append(commit);
    this.commits.push(commit);
  }
}

async function offlineEntry(
  sequence: number,
  txnId: string,
  version: number,
  options: {
    readonly leaseId?: string;
    readonly baseSeq?: number;
    readonly sentMaybeAt?: number;
    readonly executedAt?: string;
  } = {},
): Promise<OutboxEntry> {
  return {
    sequence,
    createdAt: 0,
    unitId: `unit-${sequence}`,
    base: { seq: options.baseSeq ?? 0, txnId: undefined },
    state: "offline",
    commit: fixtureCommit({
      seq: (options.baseSeq ?? 0) + 1,
      txnId,
      ops: await saveOps({ name: "out", version }),
      executedAt: options.executedAt ?? "2026-10-30T09:00:00.000Z",
    }),
    ...(options.leaseId !== undefined
      ? { lease: { leaseId: options.leaseId, fence: 3 } }
      : {}),
    ...(options.sentMaybeAt !== undefined
      ? { sentMaybeAt: options.sentMaybeAt }
      : {}),
  };
}

const NOW = Date.parse("2026-10-30T12:00:00.000Z");

function flush(port: FakePort, entries: readonly OutboxEntry[]) {
  return flushOfflineEntries(port, entries, {
    writer: WRITER,
    fence: 1,
    clock: () => new Date("2026-10-30T12:00:00.000Z"),
  });
}

Deno.test("flushOfflineEntries: lands entries in order, renumbered past a version that landed meanwhile, and settles them", async () => {
  const port = new FakePort();
  port.land(fixtureCommit({
    seq: 1,
    txnId: "theirs",
    ops: await saveOps({ name: "out", version: 1 }),
  }));
  const report = await flush(port, [
    await offlineEntry(1, "mine-1", 1),
    await offlineEntry(2, "mine-2", 2),
  ]);
  assertEquals(report.landed, 2);
  assertEquals(port.settled, ["mine-1", "mine-2"]);
  // The first never lands on 2, which the second still holds while queued:
  // a queued number never names two versions.
  assertEquals(port.history.partition.versions("out"), [1, 3, 4]);
  assertEquals(
    report.renumbered.map((version) => [version.from, version.to]),
    [[1, 3], [2, 4]],
  );
  // Each renumbered version names the behavior whose partition it is in.
  assertEquals(
    new Set(report.renumbered.map((version) => version.behavior)).size,
    1,
  );
  assert(report.renumbered[0].behavior.includes("/"));
});

Deno.test("latestAtEndOf: keeps each behavior's outcome for a name two behaviors share, the later entry's for one behavior", () => {
  const atEnd = latestAtEndOf([
    { behavior: "@e2e/note/a", name: "note", kind: "rebased", version: 2 },
    {
      behavior: "@e2e/note/b",
      name: "note",
      kind: "restated",
      version: 7,
      restates: 5,
    },
    { behavior: "@e2e/note/a", name: "note", kind: "rebased", version: 3 },
  ]);
  assertEquals(atEnd.length, 2);
  assertEquals(
    atEnd.map((outcome) => [outcome.behavior, outcome.version]),
    [["@e2e/note/a", 3], ["@e2e/note/b", 7]],
  );
});

Deno.test("flushOfflineEntries: an entry whose lease ended is sent again under none; one another holder's lease covers waits, with its partition's later entries", async () => {
  const port = new FakePort();
  port.answers = [
    new CommitRejectedError("lease-lost", "the lease ended"),
    "land",
    new CommitRejectedError("lease-lost", "the lease ended"),
    new CommitRejectedError("lease-lost", "another holder's lease"),
  ];
  const report = await flush(port, [
    await offlineEntry(1, "a", 1, { leaseId: "l-1" }),
    await offlineEntry(2, "b", 2, { leaseId: "l-1" }),
    await offlineEntry(3, "c", 3, { leaseId: "l-1" }),
  ]);
  assertEquals(port.sends, [
    "a lease=l-1",
    "a lease=none",
    "b lease=l-1",
    "b lease=none",
  ]);
  assertEquals(report.landed, 1);
  assertEquals(report.waiting, 2);
  assertEquals(port.settled, ["a"]);
  assertEquals(port.marks, []);
});

Deno.test("flushOfflineEntries: a missing grant quarantines an entry, a refused content rejects it, and both are kept", async () => {
  const port = new FakePort();
  port.answers = [
    new ServeCommitRefusedError("forbidden", "forbidden", 0, "no grant"),
    new ServeCommitRefusedError(
      "forbidden",
      "content-refused",
      0,
      "content refused",
    ),
  ];
  const report = await flush(port, [
    await offlineEntry(1, "q", 1),
    await offlineEntry(2, "r", 1, {}),
  ]);
  assertEquals(report.quarantined, 1);
  // The rejected one's partition waited behind the quarantined one.
  assertEquals(port.marks, ["q quarantined"]);
  assertEquals(port.quarantinedEntries, ["q"]);
  assertEquals(port.settled, []);
});

Deno.test("flushOfflineEntries: a refusal other than a lease's rejects the entry, kept with its reason", async () => {
  const port = new FakePort();
  port.answers = [
    new ServeCommitRefusedError(
      "forbidden",
      "content-refused",
      0,
      "content refused",
    ),
  ];
  const report = await flush(port, [await offlineEntry(1, "r", 1)]);
  assertEquals(report.rejected, 1);
  assertEquals(port.marks, ["r rejected"]);
});

Deno.test("flushOfflineEntries: serve unreachable again stops the flush, leaving every entry queued", async () => {
  const port = new FakePort();
  port.answers = [
    "land",
    new ServeUnreachableError("https://serve.test", "never", new Error("x")),
  ];
  const report = await flush(port, [
    await offlineEntry(1, "a", 1),
    await offlineEntry(2, "b", 2),
    await offlineEntry(3, "c", 3),
  ]);
  assertEquals(report.landed, 1);
  assertEquals(report.waiting, 2);
  assertEquals(port.settled, ["a"]);
  assertEquals(port.marks, []);
});

Deno.test("flushOfflineEntries: a send that may have reached serve records when, and stops the flush", async () => {
  const port = new FakePort();
  port.answers = [
    new ServeUnreachableError("https://serve.test", "maybe", new Error("x")),
  ];
  const report = await flush(port, [await offlineEntry(1, "a", 1)]);
  assertEquals(report.waiting, 1);
  assertEquals(port.sentMaybe, ["a 2026-10-30T12:00:00.000Z"]);
  assertEquals(port.marks, []);

  const mayLand = new FakePort();
  mayLand.answers = [new ServeCommitMayLandError(4, undefined, "timeout")];
  await flush(mayLand, [await offlineEntry(1, "b", 1)]);
  assertEquals(mayLand.sentMaybe, ["b 2026-10-30T12:00:00.000Z"]);

  const never = new FakePort();
  never.answers = [
    new ServeUnreachableError("https://serve.test", "never", new Error("x")),
  ];
  await flush(never, [await offlineEntry(1, "c", 1)]);
  assertEquals(never.sentMaybe, []);
});

Deno.test("flushOfflineEntries: an entry sent without an answer longer ago than serve keeps txnIds is rejected as a possible duplicate, never sent again", async () => {
  const port = new FakePort();
  const report = await flush(port, [
    await offlineEntry(1, "old", 1, {
      sentMaybeAt: NOW - COMPACTED_TXN_RETENTION_MS - 1,
    }),
  ]);
  assertEquals(report.rejected, 1);
  assertEquals(port.sends, []);
  assertEquals(port.marks, ["old rejected"]);

  // Within the retention, it is sent again: serve would have answered
  // "landed" had it taken it.
  const recent = new FakePort();
  const sent = await flush(recent, [
    await offlineEntry(1, "recent", 1, {
      sentMaybeAt: NOW - COMPACTED_TXN_RETENTION_MS + 60_000,
    }),
  ]);
  assertEquals(sent.landed, 1);
});

Deno.test("flushOfflineEntries: an entry's own failure rejects it and the flush goes on; serve refusing the caller still fails the command", async () => {
  const port = new FakePort();
  port.answers = [new ChunkNotCachedError("abc", "model--a--b")];
  const report = await flush(port, [
    await offlineEntry(1, "broken", 1),
    await offlineEntry(2, "after", 2),
  ]);
  assertEquals(report.rejected, 1);
  // Its partition's later entry waits behind it, as after any rejection.
  assertEquals(report.waiting, 1);
  assertEquals(port.marks, ["broken rejected"]);

  const auth = new FakePort();
  auth.answers = [new ServeAuthFailedError("https://serve.test", "expired")];
  await assertRejects(
    () => flush(auth, [offlineEntrySync]),
    ServeAuthFailedError,
  );
  assertEquals(auth.marks, []);
});

const offlineEntrySync = await offlineEntry(1, "auth", 1);

Deno.test("flushOfflineEntries: a latest whose commit was compacted is judged by its createdAt from the checkout's files", async () => {
  // The current latest landed after the offline work's base, then was
  // compacted: only the checkout's files still say when it was written.
  const latestOps = await saveOps({
    name: "out",
    version: 1,
    createdAt: "2026-10-30T09:02:00.000Z",
  });
  const compacted = fixtureCommit({ seq: 1, txnId: "theirs", ops: latestOps });
  const metadataOf = () => {
    const op = compacted.ops.find((op) => op.kind === "data-version");
    assert(op !== undefined && op.kind === "data-version");
    return op.metadata;
  };

  const withFiles = new FakePort();
  withFiles.history.append(compacted);
  withFiles.compactedSeq = 1;
  withFiles.compactedFiles.set("out@1", {
    metadata: metadataOf(),
    raw: new TextEncoder().encode("out@1"),
  });
  const kept = await flush(withFiles, [await offlineEntry(1, "mine", 1)]);
  // Written offline at 09:00, two minutes before the latest: it stays.
  assertEquals(kept.latest.map((outcome) => outcome.kind), ["restated"]);

  // Compacted no later than the entry's base: the offline writer saw it,
  // so its own later write takes latest, as online.
  const seen = new FakePort();
  seen.history.append(compacted);
  seen.compactedSeq = 1;
  seen.compactedFiles.set("out@1", { metadata: metadataOf() });
  const took = await flush(seen, [
    await offlineEntry(1, "mine", 1, { baseSeq: 1 }),
  ]);
  assertEquals(took.latest.map((outcome) => outcome.kind), ["rebased"]);
});

Deno.test("flushOfflineEntries: in json mode, says what the flush did as one notice", async () => {
  const notices: ServeOfflineNotice[] = [];
  setServeOfflineNoticeWriter((notice) => notices.push(notice));
  try {
    const port = new FakePort();
    port.answers = ["land", new ChunkNotCachedError("abc", "model--a--b")];
    await flush(port, [
      await offlineEntry(1, "a", 1),
      await offlineEntry(2, "b", 2),
    ]);
    assertEquals(notices.length, 1);
    const [notice] = notices;
    assertEquals(notice.notice, "datastore_offline_flush");
    if (notice.notice === "datastore_offline_flush") {
      assertEquals([notice.landed, notice.rejected], [1, 1]);
    }
  } finally {
    setServeOfflineNoticeWriter(undefined);
    resetServeOfflineForTesting();
  }
});

Deno.test("flushOfflineEntries: a local failure that may pass stops the flush and leaves the entry queued, never rejected", async () => {
  for (
    const failure of [
      new Deno.errors.PermissionDenied("permission denied"),
      new Error("No space left on device (os error 28)"),
      Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_IOERR" }),
    ]
  ) {
    const port = new FakePort();
    port.answers = [failure];
    const report = await flush(port, [
      await offlineEntry(1, "a", 1),
      await offlineEntry(2, "b", 2),
    ]);
    assertEquals(report.rejected, 0, failure.message);
    assertEquals(report.waiting, 2, failure.message);
    assertEquals(port.marks, [], failure.message);
    assertEquals(port.settled, [], failure.message);
  }
});

Deno.test("flushOfflineEntries: serve withholding the current latest's content sends the entry again without the restatement, so the rebased version becomes latest, and says so", async () => {
  const port = new FakePort();
  // Landed meanwhile and observed at 10:00, after the offline work ran at
  // 09:00: the offline version would leave it latest, restated.
  port.land(fixtureCommit({
    seq: 1,
    txnId: "theirs",
    at: "2026-10-30T10:00:00.000Z",
    ops: await saveOps({
      name: "out",
      version: 1,
      createdAt: "2026-10-30T10:00:00.000Z",
    }),
  }));
  port.answers = [
    new ServeUpstreamError(
      403,
      "chunk_not_provided",
      "The commit names chunk abc, which it neither carries nor may read",
    ),
    "land",
  ];
  const report = await flush(port, [await offlineEntry(1, "mine", 1)]);
  assertEquals(port.sends, ["mine lease=none", "mine lease=none"]);
  assertEquals(report.landed, 1);
  assertEquals(report.rejected, 0);
  assertEquals(port.settled, ["mine"]);
  assertEquals(report.latest.map((outcome) => outcome.kind), ["rebased"]);
  const [outcome] = report.latest;
  assert(outcome.kind === "rebased");
  assertEquals(outcome.restateSkipped, "content-not-provided");
  // Only the rebased version landed: no restatement above it.
  assertEquals(port.history.partition.latest("out"), 2);
});

Deno.test("flushOfflineEntries: chunk_not_provided for an entry that restates nothing rejects it, kept, and the flush goes on", async () => {
  const port = new FakePort();
  port.answers = [
    new ServeUpstreamError(403, "chunk_not_provided", "chunk abc"),
  ];
  const report = await flush(port, [await offlineEntry(1, "mine", 1)]);
  assertEquals(report.rejected, 1);
  assertEquals(port.marks, ["mine rejected"]);
});

/** The content of `out`'s latest version in `port`'s history, as JSON. */
function latestContent(port: FakePort): string | undefined {
  const version = port.history.partition.latest("out");
  if (version === undefined) return undefined;
  for (const commit of [...port.commits].reverse()) {
    for (const op of commit.ops) {
      if (
        op.kind === "data-version" && op.metadata.name === "out" &&
        op.metadata.version === version
      ) {
        const restates = op.metadata.tags["_swamp.restates"];
        return restates === undefined ? commit.txnId : `restates ${restates}`;
      }
    }
  }
  return undefined;
}

Deno.test("flushOfflineEntries: several offline entries observed before a version that landed meanwhile all leave it latest: each is judged against the restatement the one before landed", async () => {
  const port = new FakePort();
  // Bob's version, observed at 10:00, after every offline write below but
  // within the 5-minute window of each.
  port.land(fixtureCommit({
    seq: 1,
    txnId: "bob-1",
    at: "2026-10-30T10:00:00.000Z",
    ops: await saveOps({
      name: "out",
      version: 1,
      createdAt: "2026-10-30T10:00:00.000Z",
    }),
  }));
  const report = await flush(port, [
    await offlineEntry(1, "offline-1", 1, {
      executedAt: "2026-10-30T09:57:00.000Z",
    }),
    await offlineEntry(2, "offline-2", 2, {
      executedAt: "2026-10-30T09:58:00.000Z",
    }),
    await offlineEntry(3, "offline-3", 3, {
      executedAt: "2026-10-30T09:58:30.000Z",
    }),
  ]);
  assertEquals(report.landed, 3);
  assertEquals(
    report.latest.map((outcome) => outcome.kind),
    ["restated", "restated", "restated"],
  );
  // Bob's content holds latest at the end: a restatement of version 1,
  // which the report names.
  assertEquals(latestContent(port), "restates 1");
  assertEquals(report.latestAtEnd.length, 1);
  const [atEnd] = report.latestAtEnd;
  assert(atEnd.kind === "restated");
  assertEquals(atEnd.version, port.history.partition.latest("out"));
  assertEquals(atEnd.restates, 1);
});

Deno.test("flushOfflineEntries: a flush judges the checkout's own offline versions an earlier, cut-off flush landed as seen, so a later offline write takes latest", async () => {
  const port = new FakePort();
  const first = await flush(port, [
    await offlineEntry(1, "offline-1", 1, {
      executedAt: "2026-10-30T09:00:00.000Z",
    }),
  ]);
  assertEquals(first.latest.map((outcome) => outcome.kind), ["rebased"]);
  // The next command flushes the rest: written two minutes after the
  // first, which it saw.
  const second = await flush(port, [
    await offlineEntry(2, "offline-2", 2, {
      executedAt: "2026-10-30T09:02:00.000Z",
    }),
  ]);
  assertEquals(second.latest.map((outcome) => outcome.kind), ["rebased"]);
  assertEquals(latestContent(port), "offline-2");
});

/** An offline entry whose commit holds `ops`. */
function entryOf(
  sequence: number,
  txnId: string,
  ops: readonly Op[],
): OutboxEntry {
  return {
    sequence,
    createdAt: 0,
    unitId: `unit-${sequence}`,
    base: { seq: 0, txnId: undefined },
    state: "offline",
    commit: fixtureCommit({
      seq: 1,
      txnId,
      ops,
      executedAt: "2026-10-30T09:00:00.000Z",
    }),
  };
}

/** The digest of `out@version`'s raw record as serve holds it. */
function rawDigest(port: FakePort, version: number): string | undefined {
  return port.history.partition.record(
    fixtureChanges().dataKey("out", version, "raw"),
  )?.sha256;
}

/** Another writer's `out@3`, landed while the checkout was offline. */
async function theirsAtThree(port: FakePort): Promise<string> {
  port.land(fixtureCommit({
    seq: 1,
    txnId: "theirs-3",
    ops: await saveOps({ name: "out", version: 3, text: "theirs" }),
  }));
  const digest = rawDigest(port, 3);
  assert(digest !== undefined);
  return digest;
}

for (
  const removal of [
    { why: "data.delete", what: "an offline delete" },
    { why: "data.gc", what: "an offline garbage collection" },
  ] as const
) {
  Deno.test(`flushOfflineEntries: ${removal.what} of a version an earlier offline entry wrote removes that version as it landed, never another writer's that took its number`, async () => {
    const port = new FakePort();
    const theirs = await theirsAtThree(port);
    const report = await flush(port, [
      entryOf(1, "offline-save-3", await saveOps({ name: "out", version: 3 })),
      entryOf(
        2,
        "offline-remove-3",
        await toOps(fixtureChanges().removeVersion(removal.why, "out", 3)),
      ),
    ]);
    assertEquals(report.landed, 2);
    assertEquals(report.rejected, 0);
    // The other writer's version 3 survives; the checkout's own, landed
    // as 4, is the one removed.
    assertEquals(port.history.partition.versions("out"), [3]);
    assertEquals(rawDigest(port, 3), theirs);
  });
}

Deno.test("flushOfflineEntries: an offline append to a version an earlier offline entry wrote lands, following its rewritten metadata", async () => {
  const port = new FakePort();
  const saved = await saveOps({ name: "out", version: 3 });
  const savedMetadata = saved.find((op) =>
    op.kind === "put" && op.key.toString().endsWith("/metadata.yaml")
  );
  assert(savedMetadata !== undefined && savedMetadata.kind === "put");
  const appendMeta = metadata("out", 3);
  const appended = await toOps(
    fixtureChanges().writeVersion({ kind: "data.append" }, {
      name: "out",
      version: 3,
      metadata: appendMeta,
      metadataBytes: encodeMetadata(appendMeta),
      metadataExpect: { sha256: savedMetadata.sha256 },
      raw: new TextEncoder().encode("more"),
    }),
  );
  const report = await flush(port, [
    entryOf(1, "offline-save-3", saved),
    entryOf(2, "offline-append-3", appended),
  ]);
  assertEquals(report.rejected, 0);
  assertEquals(report.landed, 2);
  assertEquals(port.settled, ["offline-save-3", "offline-append-3"]);
});

Deno.test("flushOfflineEntries: a flush cut off between two offline entries remaps the second next time, from what the first left", async () => {
  const port = new FakePort();
  const theirs = await theirsAtThree(port);
  const save = entryOf(
    1,
    "offline-save-3",
    await saveOps({ name: "out", version: 3 }),
  );
  const remove = entryOf(
    2,
    "offline-remove-3",
    await toOps(fixtureChanges().removeVersion("data.delete", "out", 3)),
  );
  port.answers = [
    "land",
    new ServeUnreachableError("https://serve.test", "never", new Error("x")),
  ];
  const first = await flush(port, [save, remove]);
  assertEquals(first.landed, 1);
  assertEquals(first.waiting, 1);
  // The next command flushes what is left.
  const second = await flush(port, [remove]);
  assertEquals(second.landed, 1);
  assertEquals(port.history.partition.versions("out"), [3]);
  assertEquals(rawDigest(port, 3), theirs);
});

Deno.test("flushOfflineEntries: with no other writer meanwhile, queued versions keep their numbers", async () => {
  const port = new FakePort();
  const report = await flush(port, [
    await offlineEntry(1, "mine-1", 1),
    await offlineEntry(2, "mine-2", 2),
  ]);
  assertEquals(port.history.partition.versions("out"), [1, 2]);
  assertEquals(
    report.renumbered.map((version) => [version.from, version.to]),
    [[1, 1], [2, 2]],
  );
});
