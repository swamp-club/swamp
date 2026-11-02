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
 * when the catalog and latest marker share the version's device and nothing
 * replicates it, ordering suffices: files must reach disk no later than the
 * marker; otherwise sync in full
 */

import { dirname, resolve } from "@std/path";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import { resolverEngine } from "../../domain/datastore/datastore_path_resolver.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import type { AtomicWriteSync } from "./atomic_write.ts";
import { barrierSync, type BarrierSyncResult } from "./barrier_sync.ts";
import { SWAMP_SUBDIRS } from "./paths.ts";
import { syncDirectoryStrict } from "./sync_directory.ts";

export const fullWriteSync: AtomicWriteSync = Object.freeze({});

const REFUSED_DEVICES = new Set<number>();

export interface OrderedWriteSyncOptions {
  readonly orderedBefore: string;
  readonly barrierSync?: (path: string) => Promise<BarrierSyncResult>;
  readonly deviceOf?: (path: string) => Promise<number>;
  readonly platform?: typeof Deno.build.os;
  readonly refusedDevices?: Set<number>;
}

/**
 * on macOS, paths on the catalog's device use the ordering barrier and anything
 * else syncs in full; a volume that refuses the barrier is remembered; nothing
 * falls back to no sync
 */
export function orderedWriteSync(
  options: OrderedWriteSyncOptions,
): AtomicWriteSync {
  if ((options.platform ?? Deno.build.os) !== "darwin") return fullWriteSync;
  const runBarrier = options.barrierSync ?? ((path) => barrierSync(path));
  const deviceOf = options.deviceOf ??
    (async (path: string) => (await Deno.stat(path)).dev);
  const refused = options.refusedDevices ?? REFUSED_DEVICES;
  const catalogDir = dirname(options.orderedBefore);

  // Looked up once it succeeds; a failed lookup (the directory not made
  // yet) is retried by the next sync.
  let catalogDevice: Promise<number | undefined> | undefined;
  const orderedDevice = (): Promise<number | undefined> => {
    catalogDevice ??= deviceOf(catalogDir).catch(() => {
      catalogDevice = undefined;
      return undefined;
    });
    return catalogDevice;
  };

  const barrier = async (path: string): Promise<boolean> => {
    const device = await orderedDevice();
    if (device === undefined || refused.has(device)) return false;
    try {
      if ((await deviceOf(path)) !== device) return false;
    } catch {
      return false;
    }
    if ((await runBarrier(path)) === "synced") return true;
    refused.add(device);
    return false;
  };

  return {
    syncFile: async (file, paths) => {
      if (await barrier(paths.temp)) return;
      await file.sync();
    },
    syncDirectory: async (dir) => {
      if (await barrier(dir)) return;
      await syncDirectoryStrict(dir);
    },
  };
}

/**
 * the barrier is safe only when the catalog and markers share the content tree
 * and nothing replicates it; custom paths, extension caches, v3 and injected
 * catalogs sync in full
 */
export function selectDurableWriteSync(
  datastoreResolver: DatastorePathResolver | undefined,
  catalogPath: string,
  options: {
    readonly catalogStoreInjected?: boolean;
    readonly platform?: typeof Deno.build.os;
  } = {},
): AtomicWriteSync {
  if (options.catalogStoreInjected) return fullWriteSync;
  if (datastoreResolver !== undefined) {
    if (resolverEngine(datastoreResolver) !== "v2") return fullWriteSync;
    const config = datastoreResolver.config();
    if (isCustomDatastoreConfig(config) || config.namespace !== undefined) {
      return fullWriteSync;
    }
    const dataDir = resolve(datastoreResolver.resolvePath(SWAMP_SUBDIRS.data));
    if (dataDir !== resolve(datastoreResolver.localPath(SWAMP_SUBDIRS.data))) {
      return fullWriteSync;
    }
  }
  return orderedWriteSync({
    orderedBefore: catalogPath,
    platform: options.platform,
  });
}
