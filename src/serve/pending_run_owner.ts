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

import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import {
  isProcessGone,
  processHostIdentity,
} from "../infrastructure/runtime/process.ts";
import type { PendingRunOwner } from "../infrastructure/persistence/run_tracker_store.ts";
import { InstanceHeartbeatService } from "./instance_heartbeat.ts";

export type PendingOwnerAlive = (owner: PendingRunOwner) => Promise<boolean>;

export interface PendingOwnerLivenessDeps {
  instanceId: string;
  controlPlaneStore?: ControlPlaneStore;
  staleTtlMs?: number;
  hostIdentity?: () => string;
  isGone?: (pid: number) => boolean;
}

/**
 * a peer's queued run is its own while that peer lives: on this kernel by its
 * process, elsewhere by a fresh heartbeat; a heartbeat that cannot be read
 * counts as gone, as a missing one does
 */
export function pendingOwnerLiveness(
  deps: PendingOwnerLivenessDeps,
): PendingOwnerAlive {
  const hostIdentity = deps.hostIdentity ?? processHostIdentity;
  const isGone = deps.isGone ?? isProcessGone;
  return async (owner) => {
    if (owner.instanceId === deps.instanceId) return true;
    if (owner.host !== undefined && owner.host === hostIdentity()) {
      return !isGone(owner.pid);
    }
    const store = deps.controlPlaneStore;
    if (!store) return false;
    try {
      const data = await store.get(`heartbeats/${owner.instanceId}`);
      if (!data) return false;
      const record = InstanceHeartbeatService.parseRecord(data);
      return record !== null &&
        !InstanceHeartbeatService.isStale(record, deps.staleTtlMs);
    } catch {
      return false;
    }
  };
}

export const DEFERRED_REPLAY_INTERVAL_MS = 5_000;

export interface DeferredReplayDeps {
  /** replays what it can of `ids`, returning the ids still deferred */
  replay: (ids: ReadonlySet<string>) => Promise<ReadonlySet<string>>;
  intervalMs?: number;
}

/** replays the runs boot left to a live peer once that peer has gone */
export class DeferredReplaySweep {
  readonly #deps: DeferredReplayDeps;
  #pending: ReadonlySet<string> = new Set();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight: Promise<void> | undefined;
  #stopped = false;

  constructor(deps: DeferredReplayDeps) {
    this.#deps = deps;
  }

  get pending(): ReadonlySet<string> {
    return this.#pending;
  }

  /** adds to what the sweep waits on; a later start keeps the earlier ids */
  start(ids: ReadonlySet<string>): void {
    this.#pending = new Set([...this.#pending, ...ids]);
    if (this.#timer === undefined && this.#inFlight === undefined) {
      this.#schedule();
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#inFlight;
  }

  #schedule(): void {
    if (this.#stopped || this.#pending.size === 0) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#inFlight = this.#tick().finally(() => {
        this.#inFlight = undefined;
      });
    }, this.#deps.intervalMs ?? DEFERRED_REPLAY_INTERVAL_MS);
  }

  async #tick(): Promise<void> {
    try {
      this.#pending = await this.#deps.replay(this.#pending);
    } catch {
      // a failed pass keeps the set for the next one
    }
    this.#schedule();
  }
}
