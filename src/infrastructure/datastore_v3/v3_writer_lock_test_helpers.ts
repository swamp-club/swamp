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

import { resolve } from "@std/path";
import {
  fenceKey,
  readWriterLeaseRecords,
  releasedKey,
} from "../../domain/datastore_v3/writer_lease.ts";
import type { ProcessIdentity } from "../../domain/datastore_v3/process_liveness.ts";
import { FileSystemControlPlaneStore } from "../persistence/fs_control_plane_store.ts";
import { localProcess } from "./process_identity.ts";

export interface PlantedV3WriterLease {
  readonly pid: number;
  readonly hostname?: string;
  readonly acquiredAt?: Date;
  readonly ttlMs?: number;
  readonly process?: ProcessIdentity | null;
}

export async function plantedIdentity(
  hostname: string,
): Promise<ProcessIdentity> {
  return hostname === Deno.hostname()
    ? await thisKernelIdentity()
    : { host: hostname };
}

export async function thisKernelIdentity(): Promise<ProcessIdentity> {
  const { startTime: _, ...kernel } = (await localProcess()).identity;
  return kernel;
}

export interface V3WriterLeaseHolder {
  readonly fence: number;
  readonly nonce: string;
  release(): Promise<void>;
}

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
