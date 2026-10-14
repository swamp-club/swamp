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
 * - `lineage/<fence>/head.json`, rewritten by the lineage's writer.
 *
 * Creates use `putIfAbsent`, so of two writers only one can claim a
 * lineage or confirm it. A read lists `lineage/` once and fetches only the
 * records the rules need: the current lineage's start, confirmation and
 * head, and the newest start. A copy that is current costs that, and no download.
 *
 * @module
 */

import type { WritableDatastoreControlPlaneStore } from "../../../domain/datastore/control_plane_store.ts";
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

/** The control-plane prefix every lineage record is under. */
export const LINEAGE_PREFIX = "lineage/";

type RecordName = "started" | "confirmed" | "head";

const KEY_PATTERN = /^lineage\/(\d{12})\/(started|confirmed|head)\.json$/;

function keyOf(fence: number, name: RecordName): string {
  return `${LINEAGE_PREFIX}${padFence(fence)}/${name}.json`;
}

/** Reads and writes a datastore's published lineages. */
export class LineageRegistry {
  constructor(private readonly store: WritableDatastoreControlPlaneStore) {}

  /**
   * The lineages the rules need, newest first: every fence with a record,
   * with the start, confirmation and head fetched for the current lineage
   * under `replicaRoot`, and the start of the newest one started.
   */
  async read(
    replicaRoot: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<PublishedLineage[]> {
    const names = new Map<number, Set<RecordName>>();
    for (const key of await this.store.list(LINEAGE_PREFIX)) {
      const match = KEY_PATTERN.exec(key);
      if (match === null) continue;
      const fence = Number(match[1]);
      try {
        padFence(fence);
      } catch {
        continue;
      }
      const set = names.get(fence) ?? new Set<RecordName>();
      set.add(match[2] as RecordName);
      names.set(fence, set);
    }
    const fences = [...names.keys()].sort((a, b) => b - a);
    const found = new Map<number, {
      started?: LineageStarted;
      confirmed?: LineageConfirmed;
      head?: LineageHead;
    }>();
    const started = async (fence: number) => {
      const entry = found.get(fence) ?? {};
      found.set(fence, entry);
      if (entry.started === undefined && names.get(fence)!.has("started")) {
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
      if (!names.get(fence)!.has("started")) continue;
      const entry = await started(fence);
      if (entry.started?.replicaRoot === replicaRoot) break;
    }
    // The current lineage: the newest started and confirmed under this root.
    for (const fence of fences) {
      const has = names.get(fence)!;
      if (
        !has.has("started") || !has.has("confirmed") || !has.has("head")
      ) {
        continue;
      }
      const entry = await started(fence);
      if (entry.started?.replicaRoot !== replicaRoot) continue;
      const confirmed = parseLineageConfirmed(
        await this.#get(keyOf(fence, "confirmed"), options.signal),
      );
      if (confirmed === undefined || confirmed.fence !== fence) continue;
      entry.confirmed = confirmed;
      const head = parseLineageHead(
        await this.#get(keyOf(fence, "head"), options.signal),
      );
      if (head === undefined || head.fence !== fence) continue;
      entry.head = head;
      break;
    }
    return fences.map((fence) => ({ fence, ...(found.get(fence) ?? {}) }));
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

  /** Publishes a lineage's head; only the lineage's writer calls it. */
  async publishHead(record: LineageHead): Promise<void> {
    await this.store.put(
      keyOf(record.fence, "head"),
      encode(serializeLineageRecord(record)),
    );
  }

  /**
   * Removes a collected lineage's records, its start last, so a lineage is
   * never left confirmed without a start.
   */
  async remove(fence: number): Promise<void> {
    for (const name of ["head", "confirmed", "started"] as const) {
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
