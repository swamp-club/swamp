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

export const RUN_INDEX_CACHE_MAX_RUNS = 250_000;

/**
 * snapshots stamped this recently are not trusted: a change within one clock
 * tick could leave both stats unchanged, and Deno reports ctime in whole
 * seconds
 */
export const RUN_INDEX_RACY_WINDOW_MS = 2_000;

/**
 * creating, removing or renaming a record moves the directory's mtime, so an
 * unchanged one means an unchanged record count
 */
export interface RunIndexStamp {
  index: RecordFingerprint | null;
  dirMtimeMs: number | null;
}

export interface LoadedRunIndex {
  snapshot: RunIndexSnapshot;
  /**
   * only a snapshot built from an index listing exactly the run records is
   * cached; any other would leave nothing on disk to move when its records
   * change
   */
  fromIndex: boolean;
}

export interface RunIndexCacheOptions {
  /**
   * undefined when the platform gives no mtime to compare by, in which case
   * nothing is cached
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
 * a snapshot is reused only while its stamp matches a fresh stat, so any writer
 * is seen on the next read and nothing needs to tell the cache about a write
 */
export class RunIndexCache {
  readonly #stamp: (workflowId: string) => Promise<RunIndexStamp | undefined>;
  readonly #maxRuns: number;
  readonly #racyWindowMs: number;
  readonly #now: () => number;
  /** In least-recently-used order: the first entry goes first. */
  readonly #entries = new Map<string, CacheEntry>();
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

  get runs(): number {
    return this.#runs;
  }

  /**
   * a miss joins an in-flight load from the same stamp; one from an older or
   * too recent stamp is not shared, as it may predate a write; a load is not
   * cancelled while another caller needs it
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

  delete(workflowId: string): void {
    const entry = this.#entries.get(workflowId);
    if (!entry) return;
    this.#entries.delete(workflowId);
    this.#runs -= entry.snapshot.size;
  }

  /**
   * a future time is never trusted; the index ctime counts too, since an
   * in-place rewrite that sets mtime back moves only ctime
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
