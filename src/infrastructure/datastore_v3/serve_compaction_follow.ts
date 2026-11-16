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

import type { BaseIndexEntry } from "../../domain/datastore_v3/commit_store.ts";
import { getSwampLogger } from "../logging/logger.ts";
import { withSpan } from "../tracing/tracer.ts";
import type {
  PartitionInstallOutcome,
  SqliteCommitStore,
} from "./sqlite_commit_store.ts";
import type { ServeDatastoreClient } from "./serve_datastore_client.ts";
import { acquireV3WriterLock, V3WriterBusyError } from "./v3_writer_lock.ts";

const logger = getSwampLogger(["datastore", "v3", "follow"]);

/** a copy holding fewer foldable commits than serve keeps has nothing worth doing */
export const FOLLOW_COMPACTION_THRESHOLD = 2_500;

/** above it a partition is installed by difference, never whole at a command's tail */
export const WHOLE_INSTALL_MAX_ROWS = 1_000;

/** until this run has measured one, a partition is assumed to cost this much */
const FIRST_PARTITION_MS = 25;
const FIRST_ROW_MS = 0.05;
/** a staged swap is set-based SQL; padded for slower disks than a laptop's */
const SWAP_MS_PER_ROW = 0.003;
/** a staged page is small enough that one fits any budget worth starting */
export const STAGE_PAGE_ENTRIES = 5_000;
const FIRST_PAGE_MS = 150;

export interface ServeCompactionFollowerOptions {
  readonly client: Pick<
    ServeDatastoreClient,
    | "baseIndex"
    | "basePartition"
    | "basePartitionPage"
    | "takesBaseDifference"
  >;
  readonly commitStore: Pick<
    SqliteCommitStore,
    | "basePositions"
    | "foldableCommits"
    | "installPartitionBase"
    | "stagedPartition"
    | "stagePartitionPage"
    | "clearStagedPartition"
    | "installStagedPartition"
  >;
  readonly copyDir: string;
  readonly namespace: string;
  /** takes the copy's writer lock without waiting; throws V3WriterBusyError when held */
  readonly tryLockCopy?: () => Promise<() => Promise<void>>;
  readonly clock?: () => number;
}

export interface FollowCompactionReport {
  readonly outcome:
    | "no-feature"
    | "below-threshold"
    | "busy"
    | "followed";
  readonly installed: number;
  readonly deferred: number;
  readonly skipped: number;
  readonly refused: number;
  readonly rows: number;
  /** pages of a hot partition's whole base staged this command */
  readonly staged: number;
  /** hot partitions swapped in from their staging this command */
  readonly bootstrapped: number;
  readonly budgetUsedMs: number;
}

interface Candidate {
  readonly entry: BaseIndexEntry;
  readonly mode: "whole" | "difference";
  readonly since?: number;
}

/**
 * Keeps a caught-up copy bounded by installing serve's base for the partitions
 * serve has compacted past it: one partition per transaction, stopping only
 * between partitions, never starting one the budget cannot finish.
 */
export class ServeCompactionFollower {
  readonly #client: ServeCompactionFollowerOptions["client"];
  readonly #commitStore: ServeCompactionFollowerOptions["commitStore"];
  readonly #namespace: string;
  readonly #tryLockCopy: () => Promise<() => Promise<void>>;
  readonly #clock: () => number;

  constructor(options: ServeCompactionFollowerOptions) {
    this.#client = options.client;
    this.#commitStore = options.commitStore;
    this.#namespace = options.namespace;
    this.#tryLockCopy = options.tryLockCopy ??
      (() => acquireV3WriterLock(options.copyDir, { maxWaitMs: 0 }));
    this.#clock = options.clock ?? (() => performance.now());
  }

  follow(
    budgetMs: number,
    readModelCursor: () => number,
  ): Promise<FollowCompactionReport> {
    return withSpan(
      "swamp.datastore.v3.follow_compaction",
      {},
      async (span) => {
        const report = await this.#follow(budgetMs, readModelCursor);
        span.setAttribute("swamp.datastore.v3.follow.outcome", report.outcome);
        span.setAttribute(
          "swamp.datastore.v3.follow.installed",
          report.installed,
        );
        span.setAttribute(
          "swamp.datastore.v3.follow.deferred",
          report.deferred,
        );
        span.setAttribute("swamp.datastore.v3.follow.refused", report.refused);
        span.setAttribute("swamp.datastore.v3.follow.rows", report.rows);
        span.setAttribute("swamp.datastore.v3.follow.staged", report.staged);
        span.setAttribute(
          "swamp.datastore.v3.follow.bootstrapped",
          report.bootstrapped,
        );
        span.setAttribute(
          "swamp.datastore.v3.follow.budget_used_ms",
          Math.round(report.budgetUsedMs),
        );
        return report;
      },
    );
  }

  async #follow(
    budgetMs: number,
    readModelCursor: () => number,
  ): Promise<FollowCompactionReport> {
    const started = this.#clock();
    const empty = (outcome: FollowCompactionReport["outcome"]) => ({
      outcome,
      installed: 0,
      deferred: 0,
      skipped: 0,
      refused: 0,
      rows: 0,
      staged: 0,
      bootstrapped: 0,
      budgetUsedMs: this.#clock() - started,
    });
    if (!this.#client.takesBaseDifference()) return empty("no-feature");
    if (
      await this.#commitStore.foldableCommits() < FOLLOW_COMPACTION_THRESHOLD
    ) {
      return empty("below-threshold");
    }
    let release: () => Promise<void>;
    try {
      release = await this.#tryLockCopy();
    } catch (error) {
      if (error instanceof V3WriterBusyError) return empty("busy");
      throw error;
    }
    try {
      return await this.#install(started, budgetMs, readModelCursor);
    } finally {
      await release();
    }
  }

  async #install(
    started: number,
    budgetMs: number,
    readModelCursor: () => number,
  ): Promise<FollowCompactionReport> {
    const signal = AbortSignal.timeout(Math.max(1, budgetMs));
    const index = await this.#client.baseIndex(signal);
    const positions = await this.#commitStore.basePositions(this.#namespace);
    const staging = await this.#commitStore.stagedPartition();
    const candidates: Candidate[] = [];
    const bootstrap: BaseIndexEntry[] = [];
    let deferred = 0;
    for (const entry of index.partitions) {
      const local = positions.get(entry.partition);
      if (entry.seq <= (local?.compacted ?? 0)) continue;
      if (entry.contested) {
        // none exist today; such a partition is left to the full base load
        deferred++;
        continue;
      }
      const hasSource = local?.source !== undefined &&
        local.source === local.compacted && local.source >= entry.horizon;
      if (
        staging?.namespace === this.#namespace &&
        staging.partition === entry.partition
      ) {
        // once staging, it stays staged: a difference it fell back from would not fit again
        bootstrap.push(entry);
      } else if (entry.rows <= WHOLE_INSTALL_MAX_ROWS) {
        candidates.push({ entry, mode: "whole" });
      } else if (hasSource) {
        candidates.push({ entry, mode: "difference", since: local!.source });
      } else {
        // staged a page at a time, swapped in once whole
        bootstrap.push(entry);
      }
    }
    const left = () => budgetMs - (this.#clock() - started);
    // a complete staging is the one swap that needs most of a budget: first
    const swapFirst = staging?.complete === true;
    const first = swapFirst
      ? await this.#bootstrap(bootstrap, left, signal, readModelCursor)
      : undefined;
    // small partitions first: most of them, cheapest each
    candidates.sort((a, b) => a.entry.rows - b.entry.rows);
    let msPerPartition = FIRST_PARTITION_MS;
    let msPerRow = FIRST_ROW_MS;
    let installed = 0;
    let skipped = 0;
    let refused = 0;
    let rows = 0;
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      if (
        left() <= 0 || signal.aborted || !this.#client.takesBaseDifference()
      ) {
        deferred += candidates.length - i;
        break;
      }
      if (
        candidate.mode === "whole" &&
        msPerPartition + candidate.entry.rows * msPerRow > left()
      ) {
        deferred++;
        continue;
      }
      const t0 = this.#clock();
      let outcome:
        | PartitionInstallOutcome
        | "deferred"
        | "refused"
        | "staged-instead";
      try {
        outcome = await this.#installOne(
          candidate,
          { left, budgetMs },
          msPerPartition,
          msPerRow,
          signal,
          readModelCursor,
        );
      } catch (error) {
        if (signal.aborted) {
          deferred += candidates.length - i;
          break;
        }
        logger
          .debug`Left partition ${candidate.entry.partition} of the copy as it was: ${error}`;
        outcome = "refused";
      }
      const spent = this.#clock() - t0;
      if (outcome === "deferred") {
        deferred++;
        continue;
      }
      if (outcome === "staged-instead") {
        bootstrap.push(candidate.entry);
        continue;
      }
      if (outcome === "refused") {
        refused++;
        continue;
      }
      if (outcome.kind === "skipped") {
        skipped++;
        continue;
      }
      installed++;
      rows += outcome.rows;
      msPerPartition = Math.max(
        msPerPartition,
        spent - outcome.rows * msPerRow,
      );
      if (outcome.rows > 0) {
        msPerRow = Math.max(msPerRow, spent / outcome.rows / 2);
      }
    }
    const boot = first ?? await this.#bootstrap(
      bootstrap,
      left,
      signal,
      readModelCursor,
    );
    return {
      outcome: "followed",
      installed: installed + boot.bootstrapped,
      deferred: deferred + boot.deferred,
      skipped,
      refused: refused + boot.refused,
      rows: rows + boot.rows,
      staged: boot.staged,
      bootstrapped: boot.bootstrapped,
      budgetUsedMs: this.#clock() - started,
    };
  }

  /**
   * One hot partition at a time: its whole base is staged a page per step,
   * resumed by later commands, and swapped in once staged and the swap fits.
   */
  async #bootstrap(
    needing: readonly BaseIndexEntry[],
    left: () => number,
    signal: AbortSignal,
    readModelCursor: () => number,
  ): Promise<
    {
      staged: number;
      bootstrapped: number;
      deferred: number;
      refused: number;
      rows: number;
    }
  > {
    const result = {
      staged: 0,
      bootstrapped: 0,
      deferred: 0,
      refused: 0,
      rows: 0,
    };
    if (needing.length === 0) return result;
    let staged = await this.#commitStore.stagedPartition();
    const wanted = new Set(needing.map((entry) => entry.partition));
    if (
      staged !== undefined &&
      (staged.namespace !== this.#namespace || !wanted.has(staged.partition))
    ) {
      await this.#commitStore.clearStagedPartition();
      staged = undefined;
    }
    const target = staged?.partition ?? needing[0].partition;
    result.deferred = needing.length - 1;
    let after = staged?.complete === false ? staged.next : undefined;
    let seq = staged?.seq;
    let pageMs = FIRST_PAGE_MS;
    try {
      while (staged?.complete !== true) {
        if (
          left() < pageMs || signal.aborted ||
          !this.#client.takesBaseDifference()
        ) {
          result.deferred++;
          return result;
        }
        const t0 = this.#clock();
        const page = await this.#client.basePartitionPage(
          target,
          after,
          this.#namespace,
          signal,
          STAGE_PAGE_ENTRIES,
        );
        if (seq !== undefined && page.seq !== seq && after !== undefined) {
          // serve moved on mid-staging: the token belongs to the old base
          await this.#commitStore.clearStagedPartition();
          after = undefined;
          seq = undefined;
          staged = undefined;
          continue;
        }
        await this.#commitStore.stagePartitionPage({
          namespace: this.#namespace,
          partition: target,
          seq: page.seq,
          entries: page.entries,
          next: page.next,
        });
        result.staged++;
        pageMs = Math.max(pageMs, this.#clock() - t0);
        seq = page.seq;
        after = page.next;
        staged = await this.#commitStore.stagedPartition();
      }
      if (staged.rows * SWAP_MS_PER_ROW > left()) {
        result.deferred++;
        return result;
      }
      let outcome;
      try {
        outcome = await this.#commitStore.installStagedPartition(
          readModelCursor(),
        );
      } catch (error) {
        // a swap refused once is refused again: start over rather than block the rest
        await this.#commitStore.clearStagedPartition();
        throw error;
      }
      if (outcome.kind === "installed") {
        result.bootstrapped++;
        result.rows += outcome.rows;
      } else if (outcome.reason === "not-newer") {
        await this.#commitStore.clearStagedPartition();
      } else {
        result.deferred++;
      }
    } catch (error) {
      if (signal.aborted) {
        result.deferred++;
        return result;
      }
      logger
        .debug`Staging partition ${target} of the copy stopped; the next command resumes: ${error}`;
      result.refused++;
    }
    return result;
  }

  async #installOne(
    candidate: Candidate,
    budget: { left: () => number; budgetMs: number },
    msPerPartition: number,
    msPerRow: number,
    signal: AbortSignal,
    readModelCursor: () => number,
  ): Promise<
    PartitionInstallOutcome | "deferred" | "refused" | "staged-instead"
  > {
    const read = await this.#client.basePartition(
      candidate.entry.partition,
      candidate.since,
      this.#namespace,
      signal,
    );
    const fits = (size: number, within: number) =>
      msPerPartition + size * msPerRow <= within;
    if (read === "gone" || read === "too-large") {
      return candidate.mode === "difference" ? "staged-instead" : "deferred";
    }
    const size = read.entries.length + read.removed.length;
    if (candidate.mode === "difference" && !fits(size, budget.budgetMs)) {
      // never fits one command's budget: staged, it does
      return "staged-instead";
    }
    if (!fits(size, budget.left())) return "deferred";
    return await this.#commitStore.installPartitionBase({
      namespace: this.#namespace,
      partition: candidate.entry.partition,
      seq: read.seq,
      entries: read.entries,
      removed: read.removed,
      mode: candidate.mode,
      readModelCursor: readModelCursor(),
    });
  }
}

export interface FollowingHandle {
  readonly datastorePath: string;
  followServeCompaction?(budgetMs: number): Promise<unknown>;
}

/**
 * Each serve-mode copy follows serve's compaction under one shared budget; a
 * failure leaves that copy for the next command and goes on to the others.
 */
export async function followEachWithin(
  handles: Iterable<FollowingHandle>,
  budgetMs: number,
  deps: {
    readonly followsServe: (datastorePath: string) => boolean;
    readonly offline: (datastorePath: string) => boolean;
    readonly clock?: () => number;
    readonly onError?: (datastorePath: string, error: unknown) => void;
  },
): Promise<void> {
  const clock = deps.clock ?? (() => performance.now());
  const started = clock();
  for (const handle of handles) {
    const left = budgetMs - (clock() - started);
    if (left <= 0) return;
    if (
      handle.followServeCompaction === undefined ||
      !deps.followsServe(handle.datastorePath) ||
      deps.offline(handle.datastorePath)
    ) {
      continue;
    }
    try {
      await handle.followServeCompaction(left);
    } catch (error) {
      deps.onError?.(handle.datastorePath, error);
    }
  }
}
