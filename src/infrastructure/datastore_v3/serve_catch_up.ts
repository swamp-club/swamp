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
 * Catch-up from serve for a checkout whose v3 datastore's upstream is serve
 * (swamp-club#3985). The checkout's `commits.db` is a follower copy of
 * serve's commit log: filled from serve's changes feed, never replicated,
 * and storing serve's commits as serve stamped them.
 *
 * Serve filters single commits a caller may not read, so a partition's seqs
 * in the copy can have holes; the follower store accepts them. When a
 * commit arrives past the copy's head + 1, the partition is read from serve
 * first: commits hidden by a grant since changed come back that way, and
 * serve's head for the partition is recorded, which the next commit is
 * built on.
 *
 * The copy follows one serve's log, whatever answers at its address
 * (swamp-club#4049). Each feed catch-up first asks serve for the anchor,
 * the last commit of the last page applied, and each partition catch-up
 * reads from the copy's head commit: serve answering a lower head, or
 * another commit at that seq, is refused with
 * {@link ServeUpstreamDivergedError}. A commit serve withholds from this
 * caller, a partition it may no longer read, and an anchor serve has
 * compacted cannot be checked, and are not refused.
 *
 * @module
 */

import { Commit } from "../../domain/datastore_v3/commit.ts";
import type { HeadIdentity } from "../../domain/datastore_v3/commit_outbox.ts";
import { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";
import type { ServeDatastoreClient } from "./serve_datastore_client.ts";
import {
  ServeCommitsCompactedError,
  type ServeDivergedCommit,
  type ServeDivergence,
  ServeUpstreamDivergedError,
  ServeUpstreamError,
} from "./serve_upstream_errors.ts";
import type {
  ServeFeedAnchor,
  ServeUpstreamState,
} from "./serve_upstream_state.ts";
import type { SqliteCommitStore } from "./sqlite_commit_store.ts";

/** The most commits one page of a partition read asks serve for. */
export const SERVE_PARTITION_PAGE = 1000;

/** What {@link ServeCatchUp} reads from and writes to. */
export interface ServeCatchUpOptions {
  readonly client: Pick<
    ServeDatastoreClient,
    "baseUrl" | "changes" | "partitionCommits"
  >;
  readonly commitStore: Pick<
    SqliteCommitStore,
    "append" | "head" | "headIdentity"
  >;
  readonly state: Pick<
    ServeUpstreamState,
    | "feedCursor"
    | "advanceFeedCursor"
    | "feedAnchor"
    | "serveHead"
    | "recordServeHead"
  >;
  /** The copy's directory, which a refused divergence names. */
  readonly copyDir: string;
}

/** What one catch-up applied. */
export interface ServeCatchUpReport {
  /** Commits appended to the copy. */
  readonly applied: number;
}

/** Fills a checkout's follower copy from serve: see the module doc. */
export class ServeCatchUp {
  readonly #client: ServeCatchUpOptions["client"];
  readonly #commitStore: ServeCatchUpOptions["commitStore"];
  readonly #state: ServeCatchUpOptions["state"];
  readonly #copyDir: string;
  /** One feed catch-up at a time per handle; later callers share it. */
  #feed: Promise<ServeCatchUpReport> | undefined;

  constructor(options: ServeCatchUpOptions) {
    this.#client = options.client;
    this.#commitStore = options.commitStore;
    this.#state = options.state;
    this.#copyDir = options.copyDir;
  }

  /**
   * Applies every commit of serve's changes feed after the copy's cursor.
   * The cursor moves only once a page's commits are in the copy: a crash
   * between the two reads the page again, and its commits are duplicates.
   */
  catchUp(signal: AbortSignal): Promise<ServeCatchUpReport> {
    this.#feed ??= this.#catchUpFeed(signal).finally(() => {
      this.#feed = undefined;
    });
    return this.#feed;
  }

  async #catchUpFeed(signal: AbortSignal): Promise<ServeCatchUpReport> {
    await this.#checkAnchor(signal);
    let applied = 0;
    for (;;) {
      signal.throwIfAborted();
      const page = await this.#client.changes(this.#state.feedCursor(), signal);
      let last: Commit | undefined;
      for (const change of page.changes) {
        const commit = await Commit.fromJSON(change.commit);
        applied += await this.#applyInOrder(commit, signal);
        last = commit;
      }
      this.#state.advanceFeedCursor(
        page.cursor,
        last === undefined ? undefined : anchorOf(last),
      );
      if (!page.more) return { applied };
    }
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
      page = await this.#client.partitionCommits(
        PartitionKey.parse(anchor.partition),
        anchor.seq - 1,
        signal,
        1,
      );
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

  /**
   * Reads `partition` from serve after the copy's head and applies what it
   * returns, recording serve's head: before a write, and after a stale seq.
   * The read starts at the copy's head commit, which serve must still hold.
   * Resolves with serve's head.
   */
  async catchUpPartition(
    namespace: string,
    partition: PartitionKey,
    signal: AbortSignal,
  ): Promise<number> {
    const local = await this.#commitStore.headIdentity(namespace, partition);
    if (local.seq === 0) {
      return await this.#readPartition(namespace, partition, 0, signal);
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
      // Compacted through exactly the copy's head: read on from it unchecked.
      if (!(error instanceof ServeCommitsCompactedError)) throw error;
      return await this.#readPartition(namespace, partition, local.seq, signal);
    }
  }

  /** The higher of the copy's head and serve's last reported head. */
  async headOf(namespace: string, partition: PartitionKey): Promise<number> {
    const local = (await this.#commitStore.head(namespace, partition)).seq;
    return Math.max(
      local,
      this.#state.serveHead(namespace, partition.toString()),
    );
  }

  /** Records a head serve reported, as a stale seq's reply carries. */
  recordServeHead(namespace: string, partition: PartitionKey, seq: number) {
    this.#state.recordServeHead(namespace, partition.toString(), seq);
  }

  /** Applies `commit`, reading its partition from serve first on a gap. */
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
      await this.#readPartition(
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

  /**
   * Pages `partition`'s commits after `after` until serve's head (or
   * `through`), applying each. Serve's own log has no holes, so a page
   * filtered to nothing still moves the read on by the page's size. With
   * `expect`, the copy's head commit, the first page is checked against it.
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
    for (;;) {
      signal.throwIfAborted();
      const page = await this.#client.partitionCommits(
        partition,
        cursor,
        signal,
        SERVE_PARTITION_PAGE,
      );
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
          throw new Error(
            `Serve answered a read of partition ${partition} with a commit ` +
              `of ${commit.partition} in namespace ${commit.namespace}`,
          );
        }
        if (through !== undefined && commit.seq > through) break;
        await this.#append(commit);
        last = Math.max(last, commit.seq);
      }
      const end = through === undefined ? head : Math.min(head, through);
      const next = Math.max(last, Math.min(cursor + SERVE_PARTITION_PAGE, end));
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

function anchorOf(commit: Commit): ServeFeedAnchor {
  return {
    namespace: commit.namespace,
    partition: commit.partition.toString(),
    seq: commit.seq,
    txnId: commit.txnId,
  };
}
