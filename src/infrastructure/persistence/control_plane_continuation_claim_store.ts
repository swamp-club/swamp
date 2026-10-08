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

import type { ControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import {
  type ContinuationClaim,
  continuationClaimKey,
  type ContinuationClaimStore,
  continuationRunPrefix,
  continuationSuspensionPrefix,
  decodeContinuationClaim,
  encodeContinuationClaim,
  generationFromKey,
  type HolderLiveness,
  serveInstanceOf,
} from "../../domain/workflows/continuation_claim.ts";
import type { AtomicControlPlaneStore } from "./control_plane_signal_wait_store.ts";

/**
 * {@link ContinuationClaimStore} over a {@link ControlPlaneStore}: one record
 * per generation under `continuations/<runId>/<suspensionKey>/`, each created
 * with `putIfAbsent` so the first writer of a generation holds it.
 */
export class ControlPlaneContinuationClaimStore
  implements ContinuationClaimStore {
  readonly #store: AtomicControlPlaneStore;

  constructor(store: AtomicControlPlaneStore) {
    this.#store = store;
  }

  async find(
    runId: string,
    suspensionKey: string,
  ): Promise<ContinuationClaim | undefined> {
    const prefix = continuationSuspensionPrefix(runId, suspensionKey);
    const generations: number[] = [];
    for (const key of await this.#store.list(prefix)) {
      const generation = generationFromKey(key);
      if (generation !== undefined) generations.push(generation);
    }
    // Highest first. A generation that cannot be read is passed over, so a
    // damaged record never hides the claim below it.
    generations.sort((a, b) => b - a);
    for (const generation of generations) {
      const expected = { runId, suspensionKey, generation };
      const claim = decodeContinuationClaim(
        await this.#store.get(continuationClaimKey(expected)),
        expected,
      );
      if (claim !== undefined) return claim;
    }
    return undefined;
  }

  async create(claim: ContinuationClaim): Promise<boolean> {
    return await this.#store.putIfAbsent(
      continuationClaimKey(claim),
      encodeContinuationClaim(claim),
    );
  }

  async release(claim: ContinuationClaim): Promise<void> {
    await this.#store.delete(continuationClaimKey(claim));
  }

  async removeForRun(runId: string): Promise<void> {
    for (const key of await this.#store.list(continuationRunPrefix(runId))) {
      await this.#store.delete(key);
    }
  }
}

/**
 * How long after its last heartbeat a serve instance counts as dead, when
 * its heartbeat does not say.
 */
export const CONTINUATION_HOLDER_STALE_MS = 90_000;

/** The longest stale TTL a heartbeat is believed about: one day. */
const HOLDER_STALE_MAX_MS = 86_400_000;

/**
 * What the heartbeats in `store` say of a claim's holder. A serve instance
 * is alive while its heartbeat is recent and dead once it is stale or gone;
 * nothing is known of any other holder, which writes no heartbeat. Stale is
 * judged by the TTL the instance published in its heartbeat, so a local
 * command and a peer agree with the instance's own settings; `staleMs` is
 * for a heartbeat that names none.
 */
export function heartbeatLiveness(
  store: ControlPlaneStore,
  options: { staleMs?: number; now?: () => Date } = {},
): (holder: string) => Promise<HolderLiveness> {
  const staleMs = options.staleMs ?? CONTINUATION_HOLDER_STALE_MS;
  return async (holder) => {
    const instanceId = serveInstanceOf(holder);
    // A holder is read from a store other writers can reach, so its id
    // must not be able to name a key outside the heartbeats.
    if (instanceId === undefined || !/^[A-Za-z0-9_-]+$/.test(instanceId)) {
      return "unknown";
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await store.get(`heartbeats/${instanceId}`);
    } catch {
      return "unknown";
    }
    if (bytes === null) return "dead";
    try {
      const record = JSON.parse(new TextDecoder().decode(bytes));
      const at = new Date(record?.heartbeatAt).getTime();
      if (Number.isNaN(at)) return "dead";
      const published = record?.staleTtlMs;
      const ttl = typeof published === "number" && published > 0 &&
          published <= HOLDER_STALE_MAX_MS
        ? published
        : staleMs;
      const now = (options.now?.() ?? new Date()).getTime();
      return now - at > ttl ? "dead" : "alive";
    } catch {
      return "dead";
    }
  };
}
