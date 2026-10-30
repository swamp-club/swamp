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
 * How durable v2 data writes are synced (swamp-club#4032). A full sync is
 * `FsFile.sync()` and {@link syncDirectoryStrict}: on macOS a drive-cache
 * flush (`F_FULLFSYNC`) per file and directory. Where the catalog and the
 * latest marker that publish a version share its device and nothing
 * replicates it, ordering is enough: the version's files and directory
 * entries need only reach the disk no later than the marker and the catalog
 * row written after them. On macOS that is the ordering barrier
 * ({@link barrierSync}), as v3 chunk storage uses it (swamp-club#3737).
 *
 * @module
 */

import { dirname, resolve } from "@std/path";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import { resolverEngine } from "../../domain/datastore/datastore_path_resolver.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import type { AtomicWriteSync } from "./atomic_write.ts";
import { barrierSync, type BarrierSyncResult } from "./barrier_sync.ts";
import { SWAMP_SUBDIRS } from "./paths.ts";
import { syncDirectoryStrict } from "./sync_directory.ts";

/** Every file and directory synced in full: the atomic write's defaults. */
export const fullWriteSync: AtomicWriteSync = Object.freeze({});

/**
 * The devices whose volume refused the ordering barrier for a v2 write in
 * this process, so their syncs go straight to the full sync.
 */
const REFUSED_DEVICES = new Set<number>();

/** Options for {@link orderedWriteSync}; the defaults are for production. */
export interface OrderedWriteSyncOptions {
  /**
   * The catalog database whose rows publish the versions. A path is synced
   * with the barrier only when it is on this file's device.
   */
  readonly orderedBefore: string;
  /** How the ordering barrier runs; {@link barrierSync} by default. */
  readonly barrierSync?: (path: string) => Promise<BarrierSyncResult>;
  /** The device a path is on; `Deno.stat`'s `dev` by default. */
  readonly deviceOf?: (path: string) => Promise<number>;
  /** The platform; `Deno.build.os` by default. */
  readonly platform?: typeof Deno.build.os;
  /**
   * The devices that refused the barrier; one shared by the whole process
   * by default.
   */
  readonly refusedDevices?: Set<number>;
}

/**
 * Sync hooks that order a v2 write before what publishes it: on macOS a
 * file or directory on the catalog's device is synced with the ordering
 * barrier, and anything else in full. A volume that refuses the barrier is
 * remembered and synced in full from then on; nothing falls back to no
 * sync. Elsewhere this is {@link fullWriteSync}.
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

  /**
   * Runs the barrier on `path` when it may run there, answering whether it
   * did. A path on another device (a symlinked directory on another
   * volume) or one that cannot be looked up is synced in full.
   */
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
 * The sync policy of the v2 data repository a repository context builds
 * (swamp-club#4032), decided from the datastore resolver. The ordering
 * barrier is safe only where the catalog (`catalogPath`) and the latest
 * markers share the content's tree and nothing replicates it: the built-in
 * filesystem datastore on the v2 engine whose data directory is the repo's
 * own `.swamp/data`, or a repository with no resolver. Everything else is
 * synced in full: a custom-path or namespaced filesystem datastore (its
 * catalog stays in `.swamp/data`, possibly on another drive), an extension
 * datastore's cache (a push could ship a version before the barrier puts
 * it on disk), v3, and a repository given its own catalog store.
 */
export function selectDurableWriteSync(
  datastoreResolver: DatastorePathResolver | undefined,
  catalogPath: string,
  options: {
    readonly catalogStoreInjected?: boolean;
    /** The platform; `Deno.build.os` by default. */
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
