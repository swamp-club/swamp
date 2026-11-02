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
 * creates use putIfAbsent so only one writer claims or confirms a lineage; a
 * read takes the highest writer's head so heads never go backwards; a kept
 * record makes every collection keep the lineage
 */

import type { WritableDatastoreControlPlaneStore } from "../../../domain/datastore/control_plane_store.ts";
import { parseReplicaPathFence } from "../../../domain/datastore/replica_path_store.ts";
import {
  type LineageConfirmed,
  type LineageHead,
  type LineageStarted,
  parseLineageConfirmed,
  parseLineageHead,
  parseLineageStarted,
  type PublishedLineage,
  serializeLineageRecord,
} from "../../../domain/datastore_v3/published_lineage.ts";
import { padFence } from "../../../domain/datastore_v3/writer_lease.ts";
import type { ReplicaRoot } from "../../../domain/datastore_v3/replica_root.ts";
import { withSpan } from "../../tracing/tracer.ts";

export const LINEAGE_PREFIX = "lineage/";

type RecordName = "started" | "confirmed" | "kept";

const KEY_PATTERN =
  /^lineage\/(\d{12})\/(started|confirmed|head-(\d{12}))\.json$/;

function keyOf(fence: number, name: RecordName): string {
  return `${LINEAGE_PREFIX}${padFence(fence)}/${name}.json`;
}

/**
 * each writer has its own head key, so a fenced writer's late head never
 * overwrites the head of the writer that continued the lineage
 */
function headKeyOf(fence: number, writerFence: number): string {
  return `${LINEAGE_PREFIX}${padFence(fence)}/head-${
    padFence(writerFence)
  }.json`;
}

interface Listed {
  started: boolean;
  confirmed: boolean;
  heads: number[];
}

export class LineageRegistry {
  constructor(private readonly store: WritableDatastoreControlPlaneStore) {}

  async #list(counts?: { listed: number }): Promise<Map<number, Listed>> {
    const listed = new Map<number, Listed>();
    const keys = await this.store.list(LINEAGE_PREFIX);
    if (counts !== undefined) counts.listed = keys.length;
    for (const key of keys) {
      const match = KEY_PATTERN.exec(key);
      if (match === null) continue;
      const fence = Number(match[1]);
      const writer = match[3] === undefined ? undefined : Number(match[3]);
      try {
        padFence(fence);
        if (writer !== undefined) padFence(writer);
      } catch {
        continue;
      }
      const entry = listed.get(fence) ??
        { started: false, confirmed: false, heads: [] };
      if (writer !== undefined) entry.heads.push(writer);
      else if (match[2] === "started") entry.started = true;
      else entry.confirmed = true;
      listed.set(fence, entry);
    }
    for (const entry of listed.values()) entry.heads.sort((a, b) => b - a);
    return listed;
  }

  read(
    replicaRoot: ReplicaRoot,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<PublishedLineage[]> {
    return withSpan("swamp.datastore.v3.lineage.read", {}, async (span) => {
      const counts = { listed: 0, gets: 0 };
      try {
        return await this.#read(replicaRoot, options, counts);
      } finally {
        span.setAttributes({
          "swamp.datastore.v3.keys_listed": counts.listed,
          "swamp.datastore.v3.gets": counts.gets,
        });
      }
    });
  }

  async #read(
    replicaRoot: ReplicaRoot,
    options: { readonly signal?: AbortSignal },
    counts: { listed: number; gets: number },
  ): Promise<PublishedLineage[]> {
    const get = (key: string) => {
      counts.gets++;
      return this.#get(key, options.signal);
    };
    const listed = await this.#list(counts);
    const fences = [...listed.keys()].sort((a, b) => b - a);
    const found = new Map<number, {
      started?: LineageStarted;
      confirmed?: LineageConfirmed;
      head?: LineageHead;
    }>();
    const started = async (fence: number) => {
      const entry = found.get(fence) ?? {};
      found.set(fence, entry);
      if (entry.started === undefined && listed.get(fence)!.started) {
        const record = parseLineageStarted(
          await get(keyOf(fence, "started")),
        );
        if (record !== undefined && record.fence === fence) {
          entry.started = record;
        }
      }
      return entry;
    };
    for (const fence of fences) {
      if (!listed.get(fence)!.started) continue;
      const entry = await started(fence);
      if (
        entry.started !== undefined &&
        replicaRoot.matches(entry.started.replicaRoot)
      ) {
        break;
      }
    }
    for (const fence of fences) {
      const has = listed.get(fence)!;
      if (!has.started || !has.confirmed || has.heads.length === 0) continue;
      const entry = await started(fence);
      if (
        entry.started === undefined ||
        !replicaRoot.matches(entry.started.replicaRoot)
      ) {
        continue;
      }
      const confirmed = parseLineageConfirmed(
        await get(keyOf(fence, "confirmed")),
      );
      if (confirmed === undefined || confirmed.fence !== fence) continue;
      entry.confirmed = confirmed;
      // a writer prunes the heads below its own: a listed head above the one
      // found that is now gone means a newer writer published and pruned, so
      // list again rather than read a lower head or none
      let heads = has.heads;
      for (let relist = 0;; relist++) {
        let missingAbove = false;
        let head: LineageHead | undefined;
        for (const writer of heads) {
          const data = await this.store.get(
            headKeyOf(fence, writer),
            options.signal ? { signal: options.signal } : undefined,
          );
          counts.gets++;
          if (data === null) {
            missingAbove = true;
            continue;
          }
          const parsed = parseLineageHead(decodeJson(data));
          if (parsed?.fence === fence && parsed.writerFence === writer) {
            head = parsed;
            break;
          }
        }
        if (!missingAbove || relist >= MAX_RELISTS) {
          if (head !== undefined) entry.head = head;
          break;
        }
        heads = await this.#headsOf(fence);
      }
      if (entry.head === undefined) continue;
      break;
    }
    return fences.map((fence) => ({ fence, ...(found.get(fence) ?? {}) }));
  }

  /**
   * until a lineage is confirmed, no copy holds a published state and a writer
   * may seed from the shared commits.db; a confirmed lineage stays until a
   * newer one replaces it, so this never goes back to false
   */
  async everConfirmed(): Promise<boolean> {
    for (const entry of (await this.#list()).values()) {
      if (entry.confirmed) return true;
    }
    return false;
  }

  async started(
    fence: number,
  ): Promise<LineageStarted | "unreadable" | undefined> {
    const data = await this.store.get(keyOf(fence, "started"));
    if (data === null) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(data));
    } catch {
      return "unreadable";
    }
    const record = parseLineageStarted(value);
    return record?.fence === fence ? record : "unreadable";
  }

  async start(record: LineageStarted): Promise<boolean> {
    return await this.store.putIfAbsent(
      keyOf(record.fence, "started"),
      encode(serializeLineageRecord(record)),
    );
  }

  async confirm(record: LineageConfirmed): Promise<boolean> {
    return await this.store.putIfAbsent(
      keyOf(record.fence, "confirmed"),
      encode(serializeLineageRecord(record)),
    );
  }

  /**
   * Publishes a lineage's head under its writer's fence: each writer only
   * ever overwrites its own, one sync at a time.
   */
  async publishHead(record: LineageHead): Promise<void> {
    await this.store.put(
      headKeyOf(record.fence, record.writerFence),
      encode(serializeLineageRecord(record)),
    );
  }

  /**
   * once kept, a lineage stays kept in every later collection, whatever the
   * chain then shows
   */
  async keep(fence: number): Promise<void> {
    await this.store.putIfAbsent(keyOf(fence, "kept"), encode("{}"));
  }

  async completeFences(): Promise<Set<number>> {
    const complete = new Set<number>();
    for (const [fence, entry] of await this.#list()) {
      if (entry.started && entry.confirmed && entry.heads.length > 0) {
        complete.add(fence);
      }
    }
    return complete;
  }

  async kept(): Promise<Set<number>> {
    const kept = new Set<number>();
    for (const key of await this.store.list(LINEAGE_PREFIX)) {
      const match = /^lineage\/(\d{12})\/kept\.json$/.exec(key);
      if (match !== null) kept.add(Number(match[1]));
    }
    return kept;
  }

  /**
   * lineage collection leaves the replica path of each fence alone, whether or
   * not its key is a record this registry reads
   */
  async fences(): Promise<Set<number>> {
    const fences = new Set<number>();
    for (const key of await this.store.list(LINEAGE_PREFIX)) {
      const name = key.slice(LINEAGE_PREFIX.length).split("/")[0];
      const fence = parseReplicaPathFence(name);
      if (fence !== undefined) fences.add(fence);
    }
    return fences;
  }

  /**
   * Removes a collected lineage's records, its start last, so a lineage is
   * never left confirmed without a start.
   */
  async remove(fence: number): Promise<void> {
    for (const writer of (await this.#list()).get(fence)?.heads ?? []) {
      await this.store.delete(headKeyOf(fence, writer));
    }
    // a kept lineage is removed only by hand, or by an older swamp; its record
    // goes with it
    for (const name of ["kept", "confirmed", "started"] as const) {
      await this.store.delete(keyOf(fence, name));
    }
  }

  async #headsOf(fence: number): Promise<number[]> {
    const heads: number[] = [];
    for (const key of await this.store.list(lineagePrefixOf(fence))) {
      const match = KEY_PATTERN.exec(key);
      if (match?.[3] !== undefined && Number(match[1]) === fence) {
        heads.push(Number(match[3]));
      }
    }
    return heads.sort((a, b) => b - a);
  }

  /**
   * a read takes the highest parsing head, so lower ones are pruned once
   * writerFence's own is there; the newest lower head stays, since an older
   * swamp may have listed heads just before it published
   */
  async pruneHeads(
    fence: number,
    writerFence: number,
    options: { readonly limit?: number; readonly deadlineMs?: number } = {},
  ): Promise<number> {
    const until = Date.now() + (options.deadlineMs ?? PRUNE_DEADLINE_MS);
    const heads = await withinDeadline(this.#headsOf(fence), until);
    if (!heads.includes(writerFence)) return 0;
    const lower = heads.filter((writer) => writer < writerFence).slice(1)
      .reverse().slice(0, options.limit ?? MAX_PRUNED_HEADS);
    let removed = 0;
    for (let start = 0; start < lower.length; start += PRUNE_BATCH) {
      const batch = lower.slice(start, start + PRUNE_BATCH);
      await withinDeadline(
        Promise.all(
          batch.map((writer) => this.store.delete(headKeyOf(fence, writer))),
        ),
        until,
      );
      removed += batch.length;
    }
    return removed;
  }

  async #get(key: string, signal?: AbortSignal): Promise<unknown> {
    const data = await this.store.get(key, signal ? { signal } : undefined);
    if (data === null) return undefined;
    try {
      return JSON.parse(new TextDecoder().decode(data));
    } catch {
      return undefined;
    }
  }
}

const MAX_RELISTS = 3;

/** Heads one prune removes, so a long backlog spreads over writers. */
const MAX_PRUNED_HEADS = 64;

/**
 * heads one prune deletes at once: a prune costs a writer about one list and
 * one round trip per batch
 */
const PRUNE_BATCH = 16;

const PRUNE_DEADLINE_MS = 5_000;

export class PruneDeadlineError extends Error {
  constructor() {
    super("Pruning the lineage heads ran out of time");
    this.name = "PruneDeadlineError";
  }
}

/**
 * the store's calls take no signal, so work still running past the deadline is
 * not cancelled and goes unread; harmless for a best-effort prune, since a
 * delete can be repeated
 */
function withinDeadline<T>(work: Promise<T>, until: number): Promise<T> {
  const left = until - Date.now();
  if (left <= 0) {
    work.catch(() => {});
    return Promise.reject(new PruneDeadlineError());
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PruneDeadlineError()), left);
  });
  work.catch(() => {});
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

function lineagePrefixOf(fence: number): string {
  return `${LINEAGE_PREFIX}${padFence(fence)}/`;
}

function decodeJson(data: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(data));
  } catch {
    return undefined;
  }
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
