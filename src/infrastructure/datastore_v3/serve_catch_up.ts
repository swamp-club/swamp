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
 * the copy is a follower of serve's commit log, never replicated; serve's
 * replies are untrusted, so a foreign-namespace commit refuses the page
 * unapplied and a diverging head or anchor is refused
 */

import { join } from "@std/path";
import { resolveLockTimeoutMs } from "../../domain/datastore/datastore_config.ts";
import { Commit } from "../../domain/datastore_v3/commit.ts";
import type { HeadIdentity } from "../../domain/datastore_v3/commit_outbox.ts";
import { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";
import { getSwampLogger } from "../logging/logger.ts";
import type {
  AnchorVerdict,
  CatchUpRequest,
  DeliveredCatchUp,
  ServeDatastoreClient,
} from "./serve_datastore_client.ts";
import {
  ServeCommitsCompactedError,
  type ServeDivergedCommit,
  type ServeDivergence,
  ServeReplyTooLargeError,
  ServeUpstreamDivergedError,
  ServeUpstreamError,
  ServeUpstreamUpgradeRequiredError,
} from "./serve_upstream_errors.ts";
import {
  ACCESS_RESET_COOLDOWN_MS,
  accessResetDue,
  type ServeCopyAccess,
  type ServeFeedAnchor,
  type ServeUpstreamState,
} from "./serve_upstream_state.ts";
import {
  ObservedBaseStaging,
  type SqliteCommitStore,
} from "./sqlite_commit_store.ts";
import { withSpan } from "../tracing/tracer.ts";
import { acquireV3WriterLock } from "./v3_writer_lock.ts";

const logger = getSwampLogger(["datastore", "v3", "serve"]);

/**
 * records the first log id serve names and refuses a reply naming another or
 * none; the anchor and head checks still guard a copy made before log ids and a
 * serve rolled back within one log
 */
export function serveLogCheck(
  state: Pick<ServeUpstreamState, "recordServeLogId">,
  serveUrl: string,
  copyDir: string,
): (logId: string | undefined) => void {
  return (logId) => {
    if (logId === undefined) {
      throw new ServeUpstreamUpgradeRequiredError(serveUrl);
    }
    const recorded = state.recordServeLogId(logId);
    if (recorded !== logId) {
      throw new ServeUpstreamDivergedError(serveUrl, copyDir, undefined, {
        kind: "other-log",
        copyLogId: recorded,
        serveLogId: logId,
      });
    }
  };
}

const ACCESS_FINGERPRINT = /^[0-9a-z]{1,128}$/;

/**
 * a first-seen fingerprint is recorded and a new mismatch warns once that a
 * later command rebuilds the copy; this command goes on. Never throws: a
 * malformed value is ignored, a failed record only delays rebuild
 */
export function serveAccessCheck(
  state: Pick<ServeUpstreamState, "access" | "recordAccessSeen">,
  serveUrl: string,
  now: () => number = Date.now,
): (fingerprint: string) => void {
  let last: string | undefined;
  let warned = false;
  return (fingerprint) => {
    if (fingerprint === last || !ACCESS_FINGERPRINT.test(fingerprint)) {
      return;
    }
    let before: ServeCopyAccess;
    let after: ServeCopyAccess;
    try {
      before = state.access();
      after = state.recordAccessSeen(fingerprint);
    } catch (error) {
      logger.debug`Could not record the read access serve sent: ${error}`;
      return;
    }
    last = fingerprint;
    const mismatched = (access: ServeCopyAccess) =>
      access.built !== undefined && access.seen !== undefined &&
      access.seen !== access.built;
    if (warned || mismatched(before) || !mismatched(after)) return;
    warned = true;
    if (accessResetDue(after, now()) === "cooling") {
      logger
        .warn`Your access to the datastore at serve ${serveUrl} changed again within ${
        ACCESS_RESET_COOLDOWN_MS / 60_000
      } minutes of this checkout's copy being rebuilt for the last change. This command reads it under your new access; serve's replicas may disagree on it, so the copy is rebuilt by a command after that if your access still differs.`;
    } else {
      logger
        .warn`Your access to the datastore at serve ${serveUrl} changed. This command reads it under your new access; the next command rebuilds this checkout's copy of it to match, or says why it waits.`;
    }
  };
}

/**
 * the most commits one page asks serve for; a reply too large to read is asked
 * again at half the limit, down to one commit
 */
export const SERVE_PARTITION_PAGE = 1000;

export const SERVE_BASE_PAGE = 1000;

export const BASE_LOAD_ATTEMPTS = 3;

export const OBSERVED_BASE_STAGING_PREFIX = "base_staging";

const loadsInProcess = new Map<string, Promise<void>>();

export interface ServeCatchUpOptions {
  readonly client: Pick<
    ServeDatastoreClient,
    "baseUrl" | "changes" | "partitionCommits" | "compactedBase"
  >;
  readonly commitStore: Pick<
    SqliteCommitStore,
    "append" | "head" | "headIdentity" | "installObservedBase"
  >;
  readonly state: Pick<
    ServeUpstreamState,
    | "feedCursor"
    | "advanceFeedCursor"
    | "feedAnchor"
    | "serveHead"
    | "recordServeHead"
    | "recordBaseLoaded"
    | "basePoint"
  >;
  readonly copyDir: string;
  /**
   * The namespace the copy's commits are in: the v3 datastore's, empty for
   * a solo one. Not the client's storage namespace, which reads
   * `_default` for an empty one.
   */
  readonly namespace: string;
  /**
   * Takes the copy's writer lease for a base load; the root's v3 writer
   * lock by default, which a writing command of this process already holds
   * and joins.
   */
  readonly lockCopy?: () => Promise<() => Promise<void>>;
}

export interface ServeCatchUpReport {
  readonly applied: number;
}

export class ServeCatchUp {
  readonly #client: ServeCatchUpOptions["client"];
  readonly #commitStore: ServeCatchUpOptions["commitStore"];
  readonly #state: ServeCatchUpOptions["state"];
  readonly #copyDir: string;
  readonly #namespace: string;
  readonly #lockCopy: () => Promise<() => Promise<void>>;
  #feed: Promise<ServeCatchUpReport> | undefined;

  constructor(options: ServeCatchUpOptions) {
    this.#client = options.client;
    this.#commitStore = options.commitStore;
    this.#state = options.state;
    this.#copyDir = options.copyDir;
    this.#namespace = options.namespace;
    this.#lockCopy = options.lockCopy ??
      (() =>
        acquireV3WriterLock(options.copyDir, {
          maxWaitMs: resolveLockTimeoutMs(),
        }));
  }

  /**
   * Applies every commit of serve's changes feed after the copy's cursor.
   * The cursor moves only once a page's commits are in the copy: a crash
   * between the two reads the page again, and its commits are duplicates.
   */
  /** where the copy's feed stands, for serve to answer with what it lacks */
  request(): CatchUpRequest {
    const anchor = this.#state.feedAnchor();
    return {
      cursor: this.#state.feedCursor(),
      ...(anchor === undefined ? {} : { anchor }),
    };
  }

  /**
   * `delivered` is a first page serve sent with another reply; it is used only
   * while the copy still stands where it was asked from
   */
  catchUp(
    signal: AbortSignal,
    delivered?: DeliveredCatchUp,
  ): Promise<ServeCatchUpReport> {
    this.#feed ??= withSpan(
      "swamp.datastore.v3.serve.catchup",
      {},
      async (span) => {
        const report = await this.#catchUpFeed(signal, delivered);
        span.setAttribute("swamp.datastore.v3.commits", report.applied);
        return report;
      },
    ).finally(() => {
      this.#feed = undefined;
    });
    return this.#feed;
  }

  async #catchUpFeed(
    signal: AbortSignal,
    delivered: DeliveredCatchUp | undefined,
  ): Promise<ServeCatchUpReport> {
    const anchor = this.#state.feedAnchor();
    let first = delivered !== undefined &&
        sameRequest(delivered.requested, this.request())
      ? delivered
      : undefined;
    // The anchor is checked before any page is applied: by serve with the
    // first page where it can, by a read of its own otherwise.
    let anchorChecked = anchor === undefined;
    let applied = 0;
    let limit = SERVE_PARTITION_PAGE;
    let loads = 0;
    for (;;) {
      signal.throwIfAborted();
      const cursor = this.#state.feedCursor();
      const basePoint = this.#state.basePoint();
      let read;
      try {
        const given = first;
        first = undefined;
        if (given?.refused !== undefined) throw given.refused;
        read = given?.page !== undefined
          ? { page: given.page, limit }
          : await pageAtMost(
            "changes",
            cursor,
            limit,
            (at) =>
              this.#client.changes(
                cursor,
                signal,
                at,
                anchorChecked ? undefined : anchor,
              ),
          );
      } catch (error) {
        // Serve compacted past the cursor: load its base, then read on.
        if (
          !(error instanceof ServeCommitsCompactedError) ||
          ++loads > BASE_LOAD_ATTEMPTS
        ) {
          throw error;
        }
        if (!anchorChecked) {
          await this.#checkAnchor(signal);
          anchorChecked = true;
        }
        await this.#loadBase(error, signal);
        continue;
      }
      if (!anchorChecked) {
        if (read.page.anchor !== undefined) {
          this.#applyVerdict(anchor!, read.page.anchor);
        } else {
          await this.#checkAnchor(signal);
        }
        anchorChecked = true;
      }
      limit = read.limit;
      const page = read.page;
      // Every commit is checked before any is applied: a page holding one
      // from another namespace is refused whole.
      const commits: Commit[] = [];
      for (const change of page.changes) {
        const commit = await Commit.fromJSON(change.commit);
        if (commit.namespace !== this.#namespace) {
          throw foreignCommit("the changes feed", commit);
        }
        commits.push(commit);
      }
      let last: Commit | undefined;
      try {
        for (const commit of commits) {
          applied += await this.#applyInOrder(commit, signal);
          last = commit;
        }
      } catch (error) {
        if (
          !(error instanceof ServeCommitsCompactedError) ||
          ++loads > BASE_LOAD_ATTEMPTS
        ) {
          throw error;
        }
        await this.#loadBase(error, signal);
        continue;
      }
      // Another process may have loaded a base meanwhile, replacing what
      // this page applied: the cursor is then the base's, read on from it.
      if (
        !this.#state.advanceFeedCursor(
          page.cursor,
          last === undefined ? undefined : anchorOf(last),
          basePoint,
        )
      ) {
        continue;
      }
      if (!page.more) return { applied };
    }
  }

  async #loadBase(
    compacted: ServeCommitsCompactedError,
    signal: AbortSignal,
  ): Promise<void> {
    // One load of a copy at a time: in this process by the chain, and
    // across processes by the copy's writer lease, which a process joins.
    const key = this.#copyDir;
    const previous = loadsInProcess.get(key);
    let finished!: () => void;
    const mine = new Promise<void>((resolve) => finished = resolve);
    const chained = (previous ?? Promise.resolve()).then(() => mine);
    loadsInProcess.set(key, chained);
    try {
      await previous;
      const release = await this.#lockCopy();
      try {
        // Another command loaded a base covering serve's point meanwhile.
        if (this.#state.basePoint() >= compacted.point) return;
        await this.#loadBaseLocked(compacted, signal);
      } finally {
        await release();
      }
    } finally {
      finished();
      if (loadsInProcess.get(key) === chained) loadsInProcess.delete(key);
    }
  }

  async #loadBaseLocked(
    compacted: ServeCommitsCompactedError,
    signal: AbortSignal,
  ): Promise<void> {
    removeStagingFiles(this.#copyDir);
    for (let attempt = 1;; attempt++) {
      const path = join(
        this.#copyDir,
        `${OBSERVED_BASE_STAGING_PREFIX}-${crypto.randomUUID()}.db`,
      );
      const staging = ObservedBaseStaging.create(path, this.#namespace);
      try {
        const loaded = await this.#stageBase(staging, compacted, signal);
        if (loaded !== undefined) {
          await this.#commitStore.installObservedBase(staging, loaded.point);
          this.#state.recordBaseLoaded(loaded.point, loaded.heads);
          logger
            .debug`Loaded serve's compacted base at point ${loaded.point} into ${this.#copyDir}`;
          return;
        }
      } finally {
        staging.close();
        ObservedBaseStaging.remove(path);
      }
      if (attempt >= BASE_LOAD_ATTEMPTS) {
        throw new ServeUpstreamError(
          503,
          "commits_compacted",
          `Serve at ${this.#client.baseUrl} compacted its log again while ` +
            "this checkout read its compacted base; run the command again",
        );
      }
    }
  }

  /**
   * Pages serve's base into `staging`. Undefined when serve's point moved
   * between pages: they are parts of two bases.
   */
  async #stageBase(
    staging: ObservedBaseStaging,
    compacted: ServeCommitsCompactedError,
    signal: AbortSignal,
  ): Promise<
    | {
      readonly point: number;
      readonly heads: { namespace: string; partition: string; seq: number }[];
    }
    | undefined
  > {
    let point: number | undefined;
    const heads: { namespace: string; partition: string; seq: number }[] = [];
    let after: string | undefined;
    let limit = SERVE_BASE_PAGE;
    do {
      signal.throwIfAborted();
      const at = after;
      let read;
      try {
        read = await pageAtMost(
          "base",
          at,
          limit,
          (size) =>
            this.#client.compactedBase(at, this.#namespace, signal, size),
        );
      } catch (error) {
        // A serve too old to send its base.
        if (
          error instanceof ServeUpstreamError && error.status === 404 &&
          point === undefined
        ) {
          throw compacted;
        }
        throw error;
      }
      limit = read.limit;
      const page = read.page;
      if (point !== undefined && page.point !== point) return undefined;
      point = page.point;
      staging.add(page.entries);
      for (const entry of page.entries) {
        if (entry.kind === "partition") {
          heads.push({
            namespace: entry.namespace,
            partition: entry.partition,
            seq: entry.seq,
          });
        }
      }
      after = page.next;
    } while (after !== undefined);
    // Serve refused the feed as compacted, so it has a base to send.
    if (point === undefined || point === 0) throw compacted;
    return { point, heads };
  }

  /**
   * Refuses a serve that no longer holds the feed anchor: the cursor is a
   * position in the log the anchor is from, and means nothing in another.
   */
  async #checkAnchor(signal: AbortSignal): Promise<void> {
    const anchor = this.#state.feedAnchor();
    if (anchor === undefined) return;
    let page;
    try {
      page = (await pageAtMost(
        `partition ${anchor.partition}`,
        anchor.seq - 1,
        1,
        (at) =>
          this.#client.partitionCommits(
            PartitionKey.parse(anchor.partition),
            anchor.seq - 1,
            signal,
            at,
            anchor.seq,
          ),
      )).page;
    } catch (error) {
      // Serve compacted the partition through the anchor, or this caller
      // may no longer read the partition: the anchor cannot be checked,
      // and the next page applied records another.
      if (
        error instanceof ServeCommitsCompactedError ||
        (error instanceof ServeUpstreamError && error.status === 404)
      ) {
        return;
      }
      throw error;
    }
    if (page.head < anchor.seq) {
      throw this.#diverged(anchor, { kind: "behind", serveHead: page.head });
    }
    const [raw] = page.commits;
    if (raw === undefined) return;
    const commit = await Commit.fromJSON(raw);
    // Another seq is the next commit this caller may read: the anchor is
    // withheld from it now.
    if (commit.seq !== anchor.seq) return;
    if (
      commit.txnId !== anchor.txnId || commit.namespace !== anchor.namespace
    ) {
      throw this.#diverged(anchor, {
        kind: "other-commit",
        serveTxnId: commit.txnId,
      });
    }
  }

  /** serve's check of the anchor, refused as #checkAnchor refuses it */
  #applyVerdict(anchor: ServeFeedAnchor, verdict: AnchorVerdict): void {
    if (verdict.verdict === "behind") {
      throw this.#diverged(anchor, {
        kind: "behind",
        serveHead: verdict.serveHead,
      });
    }
    if (verdict.verdict === "other-commit") {
      throw this.#diverged(anchor, {
        kind: "other-commit",
        serveTxnId: verdict.serveTxnId,
      });
    }
  }

  catchUpPartition(
    namespace: string,
    partition: PartitionKey,
    signal: AbortSignal,
  ): Promise<number> {
    return withSpan(
      "swamp.datastore.v3.serve.catchup_partition",
      {},
      () => this.#catchUpPartitionLoading(namespace, partition, signal),
    );
  }

  async #catchUpPartitionLoading(
    namespace: string,
    partition: PartitionKey,
    signal: AbortSignal,
  ): Promise<number> {
    for (let loads = 0;; loads++) {
      try {
        return await this.#catchUpPartitionOnce(namespace, partition, signal);
      } catch (error) {
        // Serve compacted the partition past the copy's head and the base
        // the copy holds: load the base, then read on after it.
        if (
          !(error instanceof ServeCommitsCompactedError) ||
          loads >= BASE_LOAD_ATTEMPTS
        ) {
          throw error;
        }
        await this.#loadBase(error, signal);
      }
    }
  }

  async #catchUpPartitionOnce(
    namespace: string,
    partition: PartitionKey,
    signal: AbortSignal,
  ): Promise<number> {
    const local = await this.#commitStore.headIdentity(namespace, partition);
    if (local.seq === 0) {
      return await this.#readPartitionPastBase(namespace, partition, 0, signal);
    }
    try {
      return await this.#readPartition(
        namespace,
        partition,
        local.seq - 1,
        signal,
        undefined,
        local,
      );
    } catch (error) {
      if (!(error instanceof ServeCommitsCompactedError)) throw error;
      // Compacted through exactly the copy's head: read on from it,
      // unchecked.
      if ((error.compactedSeq ?? local.seq) <= local.seq) {
        return await this.#readPartition(
          namespace,
          partition,
          local.seq,
          signal,
        );
      }
      return await this.#readPartitionPastBase(
        namespace,
        partition,
        local.seq,
        signal,
      );
    }
  }

  /**
   * takes the commit serve's reply stamped, only on the copy's head and with
   * that head as serve's parent; false when it cannot tell
   * @throws ServeUpstreamDivergedError when serve's parent is another commit
   */
  async applyStamped(
    namespace: string,
    partition: PartitionKey,
    raw: unknown,
    parentTxnId: string | undefined,
  ): Promise<boolean> {
    const commit = await Commit.fromJSON(raw);
    if (
      commit.namespace !== namespace || !commit.partition.equals(partition)
    ) {
      return false;
    }
    const local = await this.#commitStore.headIdentity(namespace, partition);
    // already held only if it is the copy's own head; a read checks the rest
    if (commit.seq <= local.seq) {
      return commit.seq === local.seq && commit.txnId === local.txnId;
    }
    if (commit.seq !== local.seq + 1) return false;
    if (local.seq > 0) {
      if (parentTxnId === undefined || local.txnId === undefined) return false;
      if (parentTxnId !== local.txnId) {
        throw this.#diverged({
          namespace,
          partition: partition.toString(),
          seq: local.seq,
          txnId: local.txnId,
        }, { kind: "other-commit", serveTxnId: parentTxnId });
      }
    }
    await this.#append(commit);
    this.#state.recordServeHead(namespace, partition.toString(), commit.seq);
    return true;
  }

  async headOf(namespace: string, partition: PartitionKey): Promise<number> {
    const local = (await this.#commitStore.head(namespace, partition)).seq;
    return Math.max(
      local,
      this.#state.serveHead(namespace, partition.toString()),
    );
  }

  recordServeHead(namespace: string, partition: PartitionKey, seq: number) {
    this.#state.recordServeHead(namespace, partition.toString(), seq);
  }

  async #applyInOrder(commit: Commit, signal: AbortSignal): Promise<number> {
    const local =
      (await this.#commitStore.head(commit.namespace, commit.partition))
        .seq;
    if (commit.seq <= local) return 0;
    let applied = 0;
    if (commit.seq > local + 1) {
      // Commits this caller could not read when the feed passed them (a
      // grant changed since), or that serve filters: read the partition
      // up to this commit.
      await this.#readPartitionPastBase(
        commit.namespace,
        commit.partition,
        local,
        signal,
        commit.seq - 1,
      );
    }
    if (await this.#append(commit)) applied++;
    return applied;
  }

  async #readPartitionPastBase(
    namespace: string,
    partition: PartitionKey,
    after: number,
    signal: AbortSignal,
    through?: number,
  ): Promise<number> {
    try {
      return await this.#readPartition(
        namespace,
        partition,
        after,
        signal,
        through,
      );
    } catch (error) {
      if (
        !(error instanceof ServeCommitsCompactedError) ||
        error.compactedSeq === undefined || error.compactedSeq <= after ||
        this.#state.basePoint() < error.point
      ) {
        throw error;
      }
      return await this.#readPartition(
        namespace,
        partition,
        error.compactedSeq,
        signal,
        through,
      );
    }
  }

  /**
   * serve's own log has no holes, so a page filtered to nothing still moves the
   * read on by the page's size; with `expect`, the first page is checked
   * against the copy's head commit
   */
  async #readPartition(
    namespace: string,
    partition: PartitionKey,
    after: number,
    signal: AbortSignal,
    through?: number,
    expect?: HeadIdentity,
  ): Promise<number> {
    let cursor = after;
    let head = after;
    let limit = SERVE_PARTITION_PAGE;
    for (;;) {
      signal.throwIfAborted();
      const at = cursor;
      const held = (await this.#commitStore.head(namespace, partition)).seq;
      const read = await pageAtMost(
        `partition ${partition}`,
        at,
        limit,
        (size) =>
          this.#client.partitionCommits(partition, at, signal, size, held),
      );
      limit = read.limit;
      const page = read.page;
      head = page.head;
      if (expect !== undefined) {
        await this.#checkHead(namespace, partition, expect, page);
        expect = undefined;
      }
      this.#state.recordServeHead(namespace, partition.toString(), head);
      let last = cursor;
      for (const raw of page.commits) {
        const commit = await Commit.fromJSON(raw);
        if (
          commit.namespace !== namespace || !commit.partition.equals(partition)
        ) {
          throw foreignCommit(`a read of partition ${partition}`, commit);
        }
        if (through !== undefined && commit.seq > through) break;
        await this.#append(commit);
        last = Math.max(last, commit.seq);
      }
      const end = through === undefined ? head : Math.min(head, through);
      // A filtered page moves the read on by the limit it was read at,
      // which a retry may have halved.
      const next = Math.max(last, Math.min(cursor + limit, end));
      if (next >= end || next <= cursor) return head;
      cursor = next;
    }
  }

  /**
   * Refuses a page that shows serve does not hold the copy's head commit:
   * a lower head, or another txnId at its seq. A head whose txnId the copy
   * compacted, or a commit withheld from this caller, checks the head only.
   */
  async #checkHead(
    namespace: string,
    partition: PartitionKey,
    expect: HeadIdentity,
    page: { readonly head: number; readonly commits: readonly unknown[] },
  ): Promise<void> {
    const local: ServeDivergedCommit = {
      namespace,
      partition: partition.toString(),
      seq: expect.seq,
      txnId: expect.txnId,
    };
    if (page.head < expect.seq) {
      throw this.#diverged(local, { kind: "behind", serveHead: page.head });
    }
    if (expect.txnId === undefined) return;
    for (const raw of page.commits) {
      const commit = await Commit.fromJSON(raw);
      if (commit.seq < expect.seq) continue;
      if (commit.seq === expect.seq && commit.txnId !== expect.txnId) {
        throw this.#diverged(local, {
          kind: "other-commit",
          serveTxnId: commit.txnId,
        });
      }
      return;
    }
  }

  #diverged(
    commit: ServeDivergedCommit,
    divergence: ServeDivergence,
  ): ServeUpstreamDivergedError {
    return new ServeUpstreamDivergedError(
      this.#client.baseUrl,
      this.#copyDir,
      commit,
      divergence,
    );
  }

  async #append(commit: Commit): Promise<boolean> {
    const local =
      (await this.#commitStore.head(commit.namespace, commit.partition))
        .seq;
    if (commit.seq <= local) return false;
    const result = await this.#commitStore.append(commit);
    return result.kind === "appended";
  }
}

function removeStagingFiles(copyDir: string): void {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(copyDir)];
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isFile && entry.name.startsWith(OBSERVED_BASE_STAGING_PREFIX)) {
      Deno.removeSync(join(copyDir, entry.name));
    }
  }
}

function sameRequest(a: CatchUpRequest, b: CatchUpRequest): boolean {
  return a.cursor === b.cursor &&
    a.anchor?.namespace === b.anchor?.namespace &&
    a.anchor?.partition === b.anchor?.partition &&
    a.anchor?.seq === b.anchor?.seq &&
    a.anchor?.txnId === b.anchor?.txnId;
}

function anchorOf(commit: Commit): ServeFeedAnchor {
  return {
    namespace: commit.namespace,
    partition: commit.partition.toString(),
    seq: commit.seq,
    txnId: commit.txnId,
  };
}

async function pageAtMost<T>(
  route: string,
  cursor: number | string | undefined,
  limit: number,
  read: (limit: number) => Promise<T>,
): Promise<{ readonly page: T; readonly limit: number }> {
  for (;;) {
    try {
      return { page: await read(limit), limit };
    } catch (error) {
      if (!(error instanceof ServeReplyTooLargeError) || limit <= 1) {
        throw error;
      }
      const next = Math.ceil(limit / 2);
      logger
        .debug`Serve's reply to ${route} after ${cursor} passed ${error.maxBytes} bytes at limit ${limit}; asking for ${next}`;
      limit = next;
    }
  }
}

function foreignCommit(read: string, commit: Commit): Error {
  return new Error(
    `Serve answered ${read} with a commit of ${commit.partition} in ` +
      `namespace ${commit.namespace}`,
  );
}
