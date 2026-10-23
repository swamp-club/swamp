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
 * The published replication lineages of a v3 datastore (swamp-club#3482,
 * Phase 4 D2), in its datastore-wide control plane beside the writer lease:
 *
 * - `lineage/<fence>/started.json`, created once;
 * - `lineage/<fence>/confirmed.json`, created once;
 * - `lineage/<fence>/head-<writer fence>.json`, rewritten by that writer;
 *   a read takes the highest writer's, so a head never goes backwards.
 *
 * Creates use `putIfAbsent`, so of two writers only one can claim a
 * lineage or confirm it. A read lists `lineage/` once and fetches only the
 * records the rules need: the current lineage's start, confirmation and
 * head, and the newest start. A copy that is current costs that, and no download.
 *
 * @module
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

/** The control-plane prefix every lineage record is under. */
export const LINEAGE_PREFIX = "lineage/";

type RecordName = "started" | "confirmed";

const KEY_PATTERN =
  /^lineage\/(\d{12})\/(started|confirmed|head-(\d{12}))\.json$/;

function keyOf(fence: number, name: RecordName): string {
  return `${LINEAGE_PREFIX}${padFence(fence)}/${name}.json`;
}

/**
 * Where the writer at `writerFence` publishes lineage `fence`'s head. Each
 * writer has its own key, so a fenced writer's late head never overwrites
 * the head of the writer that continued the lineage after it: a read takes
 * the highest writer's.
 */
function headKeyOf(fence: number, writerFence: number): string {
  return `${LINEAGE_PREFIX}${padFence(fence)}/head-${
    padFence(writerFence)
  }.json`;
}

/** What one lineage's listed keys hold. */
interface Listed {
  started: boolean;
  confirmed: boolean;
  /** The writer fences that published a head, highest first. */
  heads: number[];
}

/** Reads and writes a datastore's published lineages. */
export class LineageRegistry {
  constructor(private readonly store: WritableDatastoreControlPlaneStore) {}

  async #list(): Promise<Map<number, Listed>> {
    const listed = new Map<number, Listed>();
    for (const key of await this.store.list(LINEAGE_PREFIX)) {
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

  /**
   * The lineages the rules need, newest first: every fence with a record,
   * with the start, confirmation and head fetched for the current lineage
   * under `replicaRoot`, and the start of the newest one started. A
   * lineage's head is its highest writer's that parses.
   */
  async read(
    replicaRoot: ReplicaRoot,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<PublishedLineage[]> {
    const listed = await this.#list();
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
          await this.#get(keyOf(fence, "started"), options.signal),
        );
        if (record !== undefined && record.fence === fence) {
          entry.started = record;
        }
      }
      return entry;
    };
    // The newest start under this root.
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
    // The current lineage: the newest started and confirmed under this root.
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
        await this.#get(keyOf(fence, "confirmed"), options.signal),
      );
      if (confirmed === undefined || confirmed.fence !== fence) continue;
      entry.confirmed = confirmed;
      for (const writer of has.heads) {
        const head = parseLineageHead(
          await this.#get(headKeyOf(fence, writer), options.signal),
        );
        if (head?.fence === fence && head.writerFence === writer) {
          entry.head = head;
          break;
        }
      }
      if (entry.head === undefined) continue;
      break;
    }
    return fences.map((fence) => ({ fence, ...(found.get(fence) ?? {}) }));
  }

  /**
   * Whether any lineage, under any replica root, was ever confirmed
   * (swamp-club#3491): until one is, no copy holds a published state, and
   * a writer may still seed its copy from the datastore's shared
   * `commits.db`. A confirmed lineage's records stay until a newer
   * confirmed one replaces it, so this never goes back to false.
   */
  async everConfirmed(): Promise<boolean> {
    for (const entry of (await this.#list()).values()) {
      if (entry.confirmed) return true;
    }
    return false;
  }

  /**
   * The start of the lineage at `fence`: undefined when it has none,
   * "unreadable" when its record does not parse.
   */
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

  /** Claims the lineage at `record.fence`; false when it was claimed before. */
  async start(record: LineageStarted): Promise<boolean> {
    return await this.store.putIfAbsent(
      keyOf(record.fence, "started"),
      encode(serializeLineageRecord(record)),
    );
  }

  /** Records a lineage's first confirmed sync; false when one was recorded. */
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
   * Every fence with any key under `lineage/<fence>/`, whether or not the
   * key is a record this registry reads. Lineage collection leaves the
   * replica path of each alone (swamp-club#3531).
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
    for (const name of ["confirmed", "started"] as const) {
      await this.store.delete(keyOf(fence, name));
    }
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

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
