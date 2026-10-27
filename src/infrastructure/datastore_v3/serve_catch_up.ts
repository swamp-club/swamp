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
 * @module
 */

import { Commit } from "../../domain/datastore_v3/commit.ts";
import type { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";
import type { ServeDatastoreClient } from "./serve_datastore_client.ts";
import type { ServeUpstreamState } from "./serve_upstream_state.ts";
import type { SqliteCommitStore } from "./sqlite_commit_store.ts";

/** The most commits one page of a partition read asks serve for. */
export const SERVE_PARTITION_PAGE = 1000;

/** What {@link ServeCatchUp} reads from and writes to. */
export interface ServeCatchUpOptions {
  readonly client: Pick<ServeDatastoreClient, "changes" | "partitionCommits">;
  readonly commitStore: Pick<SqliteCommitStore, "append" | "head">;
  readonly state: Pick<
    ServeUpstreamState,
    "feedCursor" | "advanceFeedCursor" | "serveHead" | "recordServeHead"
  >;
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
  /** One feed catch-up at a time per handle; later callers share it. */
  #feed: Promise<ServeCatchUpReport> | undefined;

  constructor(options: ServeCatchUpOptions) {
    this.#client = options.client;
    this.#commitStore = options.commitStore;
    this.#state = options.state;
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
    let applied = 0;
    for (;;) {
      signal.throwIfAborted();
      const page = await this.#client.changes(this.#state.feedCursor(), signal);
      for (const change of page.changes) {
        const commit = await Commit.fromJSON(change.commit);
        applied += await this.#applyInOrder(commit, signal);
      }
      this.#state.advanceFeedCursor(page.cursor);
      if (!page.more) return { applied };
    }
  }

  /**
   * Reads `partition` from serve after the copy's head and applies what it
   * returns, recording serve's head: before a write, and after a stale seq.
   * Resolves with serve's head.
   */
  async catchUpPartition(
    namespace: string,
    partition: PartitionKey,
    signal: AbortSignal,
  ): Promise<number> {
    const local = (await this.#commitStore.head(namespace, partition)).seq;
    return await this.#readPartition(namespace, partition, local, signal);
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
   * filtered to nothing still moves the read on by the page's size.
   */
  async #readPartition(
    namespace: string,
    partition: PartitionKey,
    after: number,
    signal: AbortSignal,
    through?: number,
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

  async #append(commit: Commit): Promise<boolean> {
    const local =
      (await this.#commitStore.head(commit.namespace, commit.partition))
        .seq;
    if (commit.seq <= local) return false;
    const result = await this.#commitStore.append(commit);
    return result.kind === "appended";
  }
}
