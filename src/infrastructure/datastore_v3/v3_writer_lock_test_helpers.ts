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
import { FileSystemControlPlaneStore } from "../persistence/fs_control_plane_store.ts";

/** Who the planted holder is. */
export interface PlantedV3WriterLease {
  /** The holder's pid: a live process for a holder that is alive. */
  readonly pid: number;
  /** This host's name by default. */
  readonly hostname?: string;
  /** When it took or last renewed the lease; now by default. */
  readonly acquiredAt?: Date;
  readonly ttlMs?: number;
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
  const created = await store.putIfAbsent(
    fenceKey(fence),
    new TextEncoder().encode(JSON.stringify({
      fence,
      holder: `test@${hostname}`,
      hostname,
      pid: holder.pid,
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
