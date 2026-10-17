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
 * Test helpers that leave a v3 datastore's writer lease as another process
 * would (swamp-club#3359).
 *
 * @module
 */

import { resolve } from "@std/path";
import {
  fenceKey,
  readWriterLeaseRecords,
  releasedKey,
} from "../../domain/datastore_v3/writer_lease.ts";
import type { ProcessIdentity } from "../../domain/datastore_v3/process_liveness.ts";
import { FileSystemControlPlaneStore } from "../persistence/fs_control_plane_store.ts";
import { localProcess } from "./process_identity.ts";

/** Who the planted holder is. */
export interface PlantedV3WriterLease {
  /** The holder's pid: a live process for a holder that is alive. */
  readonly pid: number;
  /** This host's name by default. */
  readonly hostname?: string;
  /** When it took or last renewed the lease; now by default. */
  readonly acquiredAt?: Date;
  readonly ttlMs?: number;
  /**
   * The identity the record names its process by (swamp-club#3564). By
   * default, for a holder on this host, this kernel's with no start time,
   * so the pid is judged by presence; for another host, that host's. Null
   * leaves it out, as a swamp from before identities would.
   */
  readonly process?: ProcessIdentity | null;
}

/**
 * The identity a holder on `hostname` names itself by: on this host, this
 * kernel's with no start time (a pid judged by presence), else that host's.
 */
export async function plantedIdentity(
  hostname: string,
): Promise<ProcessIdentity> {
  return hostname === Deno.hostname()
    ? await thisKernelIdentity()
    : { host: hostname };
}

/** This kernel's identity with no start time: a pid judged by presence. */
export async function thisKernelIdentity(): Promise<ProcessIdentity> {
  const { startTime: _, ...kernel } = (await localProcess()).identity;
  return kernel;
}

/** A planted holder of the lease. */
export interface V3WriterLeaseHolder {
  readonly fence: number;
  readonly nonce: string;
  /** Releases the lease as its holder would. */
  release(): Promise<void>;
}

/**
 * Takes the next fence of the v3 datastore at `datastorePath`'s writer lease
 * for the holder `holder` names, as that process would.
 */
export async function plantV3WriterLease(
  datastorePath: string,
  holder: PlantedV3WriterLease,
): Promise<V3WriterLeaseHolder> {
  const store = new FileSystemControlPlaneStore(resolve(datastorePath));
  const fence = ((await readWriterLeaseRecords(store)).fence ?? 0) + 1;
  const hostname = holder.hostname ?? Deno.hostname();
  const nonce = crypto.randomUUID();
  const process = holder.process === undefined
    ? await plantedIdentity(hostname)
    : holder.process;
  const created = await store.putIfAbsent(
    fenceKey(fence),
    new TextEncoder().encode(JSON.stringify({
      fence,
      holder: `test@${hostname}`,
      hostname,
      pid: holder.pid,
      ...(process !== null ? { process } : {}),
      nonce,
      ttlMs: holder.ttlMs ?? 60_000,
      acquiredAt: (holder.acquiredAt ?? new Date()).toISOString(),
    })),
  );
  if (!created) throw new Error(`fence ${fence} was taken meanwhile`);
  return {
    fence,
    nonce,
    async release() {
      await store.putIfAbsent(
        releasedKey(fence),
        new TextEncoder().encode(JSON.stringify({ fence, by: "holder" })),
      );
    },
  };
}
