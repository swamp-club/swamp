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
import { withDeadline } from "../infrastructure/persistence/datastore_format_marker_reader.ts";
import { InstanceHeartbeatService } from "./instance_heartbeat.ts";

/** a control-plane call made for the sweep, which must never hold shutdown */
export const PENDING_REPLAY_STORE_TIMEOUT_MS = 5_000;

/** the same store with every call bounded, for work that must not stall */
export function withStoreDeadline(
  store: ControlPlaneStore,
  ms = PENDING_REPLAY_STORE_TIMEOUT_MS,
): ControlPlaneStore {
  return {
    put: (key, data) => withDeadline(() => store.put(key, data), ms),
    get: (key) => withDeadline((signal) => store.get(key, { signal }), ms),
    delete: (key) => withDeadline(() => store.delete(key), ms),
    list: (prefix) => withDeadline(() => store.list(prefix), ms),
    ...(store.putIfAbsent
      ? {
        putIfAbsent: (key: string, data: Uint8Array) =>
          withDeadline(() => store.putIfAbsent!(key, data), ms),
      }
      : {}),
  };
}

export type PendingOwnerAlive = (owner: PendingRunOwner) => Promise<boolean>;

export interface PendingOwnerLivenessDeps {
  instanceId: string;
  /** set only where serve instances write heartbeats */
  controlPlaneStore?: ControlPlaneStore;
  /**
   * how an owner on another host counts when no heartbeat can tell: boot
   * replays it as it always has, the sweep leaves it alone
   */
  unjudgedOwner?: "alive" | "gone";
  staleTtlMs?: number;
  hostIdentity?: () => string;
  isGone?: (pid: number) => boolean;
  ownPid?: number;
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
  const ownPid = deps.ownPid ?? Deno.pid;
  return async (owner) => {
    if (owner.instanceId === deps.instanceId) return true;
    if (owner.host !== undefined && owner.host === hostIdentity()) {
      // this pid is this process's, and the instance id says the owner was not
      return owner.pid !== ownPid && !isGone(owner.pid);
    }
    const store = deps.controlPlaneStore;
    if (!store) return deps.unjudgedOwner === "alive";
    try {
      const data = await withDeadline(
        () => store.get(`heartbeats/${owner.instanceId}`),
        PENDING_REPLAY_STORE_TIMEOUT_MS,
      );
      if (!data) return false;
      const record = InstanceHeartbeatService.parseRecord(data);
      return record !== null &&
        !InstanceHeartbeatService.isStale(record, deps.staleTtlMs);
    } catch {
      return false;
    }
  };
}

export const PENDING_REPLAY_INTERVAL_MS = 5_000;

export interface PendingReplaySweepDeps {
  /** one pass over the runs a gone peer left; a pass that throws is retried */
  replay: () => Promise<void>;
  intervalMs?: number;
  schedule?: (run: () => void, ms: number) => number;
  cancel?: (handle: number) => void;
}

/**
 * a peer sharing this repo can queue runs until it exits, so the sweep keeps
 * looking for as long as this process runs
 */
export class PendingReplaySweep {
  readonly #deps: PendingReplaySweepDeps;
  #handle: number | undefined;
  #inFlight: Promise<void> | undefined;
  #stopped = false;

  constructor(deps: PendingReplaySweepDeps) {
    this.#deps = deps;
  }

  start(): void {
    if (this.#stopped || this.#handle !== undefined || this.#inFlight) return;
    this.#schedule();
  }

  /** stops further passes at once; a pass already running finishes */
  halt(): void {
    this.#stopped = true;
    if (this.#handle !== undefined) {
      (this.#deps.cancel ?? clearTimeout)(this.#handle);
    }
    this.#handle = undefined;
  }

  async stop(): Promise<void> {
    this.halt();
    await this.#inFlight;
  }

  #schedule(): void {
    if (this.#stopped) return;
    const schedule = this.#deps.schedule ??
      ((run: () => void, ms: number) => Number(setTimeout(run, ms)));
    this.#handle = schedule(() => {
      this.#handle = undefined;
      this.#inFlight = this.#pass().finally(() => {
        this.#inFlight = undefined;
        this.#schedule();
      });
    }, this.#deps.intervalMs ?? PENDING_REPLAY_INTERVAL_MS);
  }

  async #pass(): Promise<void> {
    try {
      await this.#deps.replay();
    } catch {
      // the next pass reads the pending runs again
    }
  }
}
