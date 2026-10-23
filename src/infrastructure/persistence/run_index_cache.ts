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

import type { RunIndexSnapshot } from "../../domain/workflows/run_index_snapshot.ts";
import { SharedIndexRead } from "./shared_index_read.ts";
import { type Span, withSpan } from "../tracing/mod.ts";
import {
  fingerprintMatches,
  type RecordFingerprint,
} from "./workflow_run_index.ts";

/** The most runs the cache holds across all workflows. */
export const RUN_INDEX_CACHE_MAX_RUNS = 250_000;

/**
 * How recent a file time may be before a cached snapshot built from it is
 * not trusted. A change landing within one tick of a coarse file clock, or
 * on a datastore whose clock runs ahead, could otherwise leave both stats
 * unchanged (the racy-git problem). It covers the index file's ctime too,
 * which Deno reports in whole seconds (swamp-club#3467): a ctime of second
 * S stands for a change anywhere in that second, so a stamp is trusted
 * only once S has passed, and any later change moves it to a later second.
 */
export const RUN_INDEX_RACY_WINDOW_MS = 2_000;

/**
 * What a cached snapshot was built from: the stat of the workflow's run
 * index file, and the mtime of its run records directory. Creating,
 * removing or renaming a record moves the directory's mtime, so an
 * unchanged one means an unchanged record count.
 */
export interface RunIndexStamp {
  /** The index file's stat, or null when there is no index file. */
  index: RecordFingerprint | null;
  /** The records directory's mtime, or null when it does not exist. */
  dirMtimeMs: number | null;
}

/** A loaded snapshot, and whether it was built from the index. */
export interface LoadedRunIndex {
  snapshot: RunIndexSnapshot;
  /**
   * Whether it was built from an index file that lists exactly the
   * workflow's run records. Any other snapshot — built from the records, or
   * from entries repaired in memory that could not be written back — is
   * never cached: nothing on disk would move when its records change.
   */
  fromIndex: boolean;
}

export interface RunIndexCacheOptions {
  /**
   * Stats the workflow's index file and records directory. Undefined when
   * the platform gives no mtime to compare by: nothing is cached then.
   */
  stamp(workflowId: string): Promise<RunIndexStamp | undefined>;
  maxRuns?: number;
  racyWindowMs?: number;
  now?: () => number;
}

interface CacheEntry {
  stamp: RunIndexStamp;
  snapshot: RunIndexSnapshot;
}

function sameStamp(a: RunIndexStamp, b: RunIndexStamp): boolean {
  if (a.dirMtimeMs !== b.dirMtimeMs) return false;
  if (a.index === null || b.index === null) return a.index === b.index;
  return fingerprintMatches(a.index, b.index);
}

/**
 * Run index snapshots kept in memory between reads (swamp-club#3443). A
 * snapshot is reused only while its stamp still matches a fresh stat, so
 * any writer — this process, another CLI process, a datastore pull — that
 * changes the index or adds or removes a record is seen on the next read.
 * Nothing needs to tell the cache about a write.
 *
 * Least recently used workflows are dropped once the cache holds more than
 * `maxRuns` runs.
 */
export class RunIndexCache {
  readonly #stamp: (workflowId: string) => Promise<RunIndexStamp | undefined>;
  readonly #maxRuns: number;
  readonly #racyWindowMs: number;
  readonly #now: () => number;
  /** In least-recently-used order: the first entry goes first. */
  readonly #entries = new Map<string, CacheEntry>();
  /**
   * Loads in flight, by workflow, with the stamp each started from and the
   * shared read that owns cancellation for all its callers.
   */
  readonly #loading = new Map<
    string,
    {
      stamp: RunIndexStamp;
      read: SharedIndexRead<RunIndexSnapshot>;
    }
  >();
  #runs = 0;

  constructor(options: RunIndexCacheOptions) {
    this.#stamp = options.stamp;
    this.#maxRuns = options.maxRuns ?? RUN_INDEX_CACHE_MAX_RUNS;
    this.#racyWindowMs = options.racyWindowMs ?? RUN_INDEX_RACY_WINDOW_MS;
    this.#now = options.now ?? Date.now;
  }

  /** Runs held across all cached snapshots. */
  get runs(): number {
    return this.#runs;
  }

  /**
   * The workflow's snapshot: the cached one while its stamp still matches,
   * else whatever `load` builds, cached when it is safe to reuse. A read
   * that misses while a load of the same workflow from the same stamp is
   * in flight waits for that load rather than starting another, so many
   * readers after one write build the snapshot once. A load started from
   * an older stamp is not shared: it may predate the write. Nor is one
   * started from a stamp too recent to trust, which the cache would not
   * keep either. Cancelling a caller does not cancel the load while another
   * caller still needs it.
   *
   * `load` receives the shared read's signal and should stop when it aborts.
   * Each caller rejects with its own signal's reason as soon as it aborts.
   *
   * A miss is traced as a `swamp.workflow_runs.index.load` span; a hit
   * opens none. `run_index.joined_inflight` says whether the snapshot it
   * returned came from a load another read started, and
   * `workflow_runs.records` how many runs that snapshot holds.
   */
  async get(
    workflowId: string,
    load: (signal: AbortSignal) => Promise<LoadedRunIndex>,
    signal?: AbortSignal,
  ): Promise<RunIndexSnapshot> {
    signal?.throwIfAborted();
    const before = await this.#stamp(workflowId);
    signal?.throwIfAborted();
    const cached = this.#entries.get(workflowId);
    if (cached && before && sameStamp(cached.stamp, before)) {
      this.#entries.delete(workflowId);
      this.#entries.set(workflowId, cached);
      return cached.snapshot;
    }
    return await withSpan(
      "swamp.workflow_runs.index.load",
      { "workflow.id": workflowId },
      async (span) => {
        const snapshot = await this.#miss(
          workflowId,
          before,
          load,
          span,
          signal,
        );
        span.setAttribute("workflow_runs.records", snapshot.size);
        return snapshot;
      },
    );
  }

  /** {@link get} once the cache has missed. */
  async #miss(
    workflowId: string,
    before: RunIndexStamp | undefined,
    load: (signal: AbortSignal) => Promise<LoadedRunIndex>,
    span: Span,
    signal?: AbortSignal,
  ): Promise<RunIndexSnapshot> {
    span.setAttribute("run_index.joined_inflight", false);
    if (!before || this.#racy(before)) {
      return await new SharedIndexRead((sharedSignal) =>
        this.#load(workflowId, before, load, sharedSignal)
      ).get(signal);
    }

    const running = this.#loading.get(workflowId);
    if (
      running && !running.read.signal.aborted &&
      sameStamp(running.stamp, before)
    ) {
      span.setAttribute("run_index.joined_inflight", true);
      return await running.read.get(signal);
    }
    const read = new SharedIndexRead(
      (sharedSignal) => this.#load(workflowId, before, load, sharedSignal),
      () => {
        if (this.#loading.get(workflowId)?.read === read) {
          this.#loading.delete(workflowId);
        }
      },
    );
    this.#loading.set(workflowId, { stamp: before, read });
    return await read.get(signal);
  }

  /** Builds the workflow's snapshot, and keeps it when that is safe. */
  async #load(
    workflowId: string,
    before: RunIndexStamp | undefined,
    load: (signal: AbortSignal) => Promise<LoadedRunIndex>,
    signal: AbortSignal,
  ): Promise<RunIndexSnapshot> {
    this.delete(workflowId);
    const loaded = await load(signal);
    signal.throwIfAborted();
    if (!loaded.fromIndex || !before) return loaded.snapshot;
    // A write during the load may or may not be in the snapshot: keep it
    // only when nothing moved.
    const after = await this.#stamp(workflowId);
    signal.throwIfAborted();
    if (!after || !sameStamp(before, after) || this.#racy(after)) {
      return loaded.snapshot;
    }
    if (loaded.snapshot.size > this.#maxRuns) return loaded.snapshot;

    // Another read of the workflow may have kept its snapshot while this
    // one loaded: replace it, and its runs with it.
    this.delete(workflowId);
    this.#entries.set(workflowId, { stamp: after, snapshot: loaded.snapshot });
    this.#runs += loaded.snapshot.size;
    this.#evict();
    return loaded.snapshot;
  }

  /** Drops the workflow's snapshot. */
  delete(workflowId: string): void {
    const entry = this.#entries.get(workflowId);
    if (!entry) return;
    this.#entries.delete(workflowId);
    this.#runs -= entry.snapshot.size;
  }

  /**
   * Whether a stamp's times are too recent to rule out a change within the
   * same clock tick. A time in the future is never trusted. The index's
   * ctime counts as well as its mtime: a rewrite in place that sets the
   * mtime back moves only the ctime.
   */
  #racy(stamp: RunIndexStamp): boolean {
    const threshold = this.#now() - this.#racyWindowMs;
    if (stamp.dirMtimeMs !== null && stamp.dirMtimeMs > threshold) return true;
    if (stamp.index === null) return false;
    return stamp.index.mtimeMs > threshold ||
      (stamp.index.ctimeMs !== undefined && stamp.index.ctimeMs > threshold);
  }

  #evict(): void {
    for (const workflowId of this.#entries.keys()) {
      if (this.#runs <= this.#maxRuns) return;
      this.delete(workflowId);
    }
  }
}
