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
 * A copy whose cursor serve has compacted past (a fresh checkout of a
 * compacted datastore, or one left behind) loads serve's compacted base
 * instead (swamp-club#4006): under the copy's writer lease, paged into a
 * staging file of its own beside the copy, installed in one transaction,
 * and only then recorded in the serve-mode state, so a load cut off leaves
 * the copy as it was or reads as behind the point again and loads once
 * more. The feed then reads on from the point. A partition read that meets
 * a partition compacted past the copy's head reads on from its compacted
 * seq when the base the copy loaded covers serve's point, and loads the
 * base first otherwise: commits compacted away are read only from a base.
 *
 * Serve's replies are untrusted (swamp-club#4062): its address can come
 * from a committed `.swamp.yaml`. A commit outside the copy's namespace,
 * in a feed page or a partition read, refuses the page before any of it
 * is applied, and a page too large for the client to read is asked again
 * at half the limit, down to one commit.
 *
 * @module
 */

import { join } from "@std/path";
import { resolveLockTimeoutMs } from "../../domain/datastore/datastore_config.ts";
import { Commit } from "../../domain/datastore_v3/commit.ts";
import type { HeadIdentity } from "../../domain/datastore_v3/commit_outbox.ts";
import { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";
import { getSwampLogger } from "../logging/logger.ts";
import type { ServeDatastoreClient } from "./serve_datastore_client.ts";
import {
  ServeCommitsCompactedError,
  type ServeDivergedCommit,
  type ServeDivergence,
  ServeReplyTooLargeError,
  ServeUpstreamDivergedError,
  ServeUpstreamError,
  ServeUpstreamUpgradeRequiredError,
} from "./serve_upstream_errors.ts";
import type {
  ServeFeedAnchor,
  ServeUpstreamState,
} from "./serve_upstream_state.ts";
import {
  ObservedBaseStaging,
  type SqliteCommitStore,
} from "./sqlite_commit_store.ts";
import { acquireV3WriterLock } from "./v3_writer_lock.ts";

const logger = getSwampLogger(["datastore", "v3", "serve"]);

/**
 * The check a copy's serve client runs on every reply
 * (`ServeDatastoreClient.checkLog`): the first log id serve names is
 * recorded as the log the copy follows, and a reply naming another is
 * refused, as is a success naming none (a serve too old to send it). The
 * anchor and head checks below still guard the first contact of a copy
 * made before log ids, and a serve rolled back within the same log.
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

/** The shape of a read-access fingerprint serve sends: a short token. */
const ACCESS_FINGERPRINT = /^[0-9a-z]{1,128}$/;

/**
 * The check a copy's serve client runs on every reply that names the
 * caller's read access (`ServeDatastoreClient.checkAccess`,
 * swamp-club#4089). A fingerprint it has not seen in this process is
 * recorded as the one serve last sent; the first a copy sees is also the
 * one it was built under. When it differs from that, a warning says once
 * that the next command rebuilds the copy: this command goes on, since
 * serve filters its replies under the new access. It never throws: a
 * value not shaped like a fingerprint is ignored, and a failure to record
 * one only delays the rebuild.
 */
export function serveAccessCheck(
  state: Pick<ServeUpstreamState, "recordAccessSeen">,
  serveUrl: string,
): (fingerprint: string) => void {
  let last: string | undefined;
  let warned = false;
  return (fingerprint) => {
    if (fingerprint === last || !ACCESS_FINGERPRINT.test(fingerprint)) {
      return;
    }
    let built: string | undefined;
    try {
      built = state.recordAccessSeen(fingerprint).built;
    } catch (error) {
      logger.debug`Could not record the read access serve sent: ${error}`;
      return;
    }
    last = fingerprint;
    if (built !== undefined && built !== fingerprint && !warned) {
      warned = true;
      logger
        .warn`Your access to the datastore at serve ${serveUrl} changed. This command reads it under your new access; the next command rebuilds this checkout's copy of it to match, or says why it waits.`;
    }
  };
}

/**
 * The most commits one page of a partition read or the changes feed asks
 * serve for. A reply too large to read is asked again at half the limit,
 * down to one commit (swamp-club#4062).
 */
export const SERVE_PARTITION_PAGE = 1000;

/** The most compacted base entries one page asks serve for. */
export const SERVE_BASE_PAGE = 1000;

/**
 * How many times a base load starts again when serve's compaction point
 * moves between its pages, before it gives up for this command.
 */
export const BASE_LOAD_ATTEMPTS = 3;

/**
 * The name every staging file a base load writes in the copy's directory
 * starts with: `base_staging-{uuid}.db`, one per load.
 */
export const OBSERVED_BASE_STAGING_PREFIX = "base_staging";

/** Base loads in progress in this process, by copy directory. */
const loadsInProcess = new Map<string, Promise<void>>();

/** What {@link ServeCatchUp} reads from and writes to. */
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
  /** The copy's directory, which a refused divergence names. */
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
  readonly #namespace: string;
  readonly #lockCopy: () => Promise<() => Promise<void>>;
  /** One feed catch-up at a time per handle; later callers share it. */
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
  catchUp(signal: AbortSignal): Promise<ServeCatchUpReport> {
    this.#feed ??= this.#catchUpFeed(signal).finally(() => {
      this.#feed = undefined;
    });
    return this.#feed;
  }

  async #catchUpFeed(signal: AbortSignal): Promise<ServeCatchUpReport> {
    await this.#checkAnchor(signal);
    let applied = 0;
    let limit = SERVE_PARTITION_PAGE;
    let loads = 0;
    for (;;) {
      signal.throwIfAborted();
      const cursor = this.#state.feedCursor();
      const basePoint = this.#state.basePoint();
      let read;
      try {
        read = await pageAtMost(
          "changes",
          cursor,
          limit,
          (at) => this.#client.changes(cursor, signal, at),
        );
      } catch (error) {
        // Serve compacted past the cursor: load its base, then read on.
        if (
          !(error instanceof ServeCommitsCompactedError) ||
          ++loads > BASE_LOAD_ATTEMPTS
        ) {
          throw error;
        }
        await this.#loadBase(error, signal);
        continue;
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
        // A gap in a partition serve compacted past the copy's base: load
        // the base, which the feed then reads on from.
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

  /**
   * Loads serve's compacted base into the copy: see the module doc. A serve
   * with no base route keeps the refusal `compacted` is. The load starts
   * again when serve's point moves between pages, at most
   * {@link BASE_LOAD_ATTEMPTS} times.
   */
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

  /**
   * {@link #readPartition} from `after`, or from the partition's compacted
   * seq when serve compacted past `after` and the base the copy loaded
   * covers serve's point: the base held what was compacted, so the copy
   * reads on after it. Otherwise serve's refusal is thrown, for the caller
   * to load the base.
   */
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
    let limit = SERVE_PARTITION_PAGE;
    for (;;) {
      signal.throwIfAborted();
      const at = cursor;
      const read = await pageAtMost(
        `partition ${partition}`,
        at,
        limit,
        (size) => this.#client.partitionCommits(partition, at, signal, size),
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

/** Removes the staging files a cut-off base load left in `copyDir`. */
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

function anchorOf(commit: Commit): ServeFeedAnchor {
  return {
    namespace: commit.namespace,
    partition: commit.partition.toString(),
    seq: commit.seq,
    txnId: commit.txnId,
  };
}

/**
 * Reads a page of at most `limit` commits, asking again at half the limit
 * while serve's reply is too large to read, down to one commit, where the
 * refusal stands. Resolves with the limit the page was read at.
 */
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

/** The refusal of a commit outside the read that asked for it. */
function foreignCommit(read: string, commit: Commit): Error {
  return new Error(
    `Serve answered ${read} with a commit of ${commit.partition} in ` +
      `namespace ${commit.namespace}`,
  );
}
