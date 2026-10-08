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

import { join } from "@std/path";
import {
  type CustomDatastoreConfig,
  type DatastoreConfig,
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import {
  DATASTORE_FORMAT_MARKER_FILE,
  DATASTORE_FORMAT_MARKER_KEY,
  DATASTORE_FORMAT_MARKER_MAX_BYTES,
  type DatastoreFormatMarkerRead,
} from "../../domain/datastore/datastore_format.ts";
import type { DatastoreControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import type { DatastoreProvider } from "../../domain/datastore/datastore_provider.ts";
import { resolveCustomProvider } from "./datastore_global_lock.ts";

/**
 * How long the control-plane read of the marker may take before the check
 * gives up and proceeds. The S3 and GCS extensions retry with backoff inside
 * `get`, so during an outage this bounds the wait the check adds before the
 * command meets the same outage itself. A remote slower than this is treated
 * like a failed read: the check is skipped, never blocking.
 */
export const DATASTORE_FORMAT_READ_TIMEOUT_MS = 5_000;

/** Options for {@link readDatastoreFormatMarker}. */
export interface ReadDatastoreFormatMarkerOptions {
  /** Overrides {@link DATASTORE_FORMAT_READ_TIMEOUT_MS} (tests). */
  readonly timeoutMs?: number;
  /** Overrides provider resolution (tests). */
  readonly resolveProvider?: (
    config: CustomDatastoreConfig,
  ) => Promise<DatastoreProvider>;
}

/**
 * Reads a datastore's format marker without writing anything.
 *
 * Filesystem datastores keep the marker at the datastore root,
 * `<path>/datastore-format.json`, outside every namespace subdirectory.
 *
 * Other datastores keep it as the control-plane record `datastore-format`
 * at the datastore-wide `_control/` root. A provider that offers
 * `datastoreControlPlaneStore` is read through it: one request, no sync
 * service. Otherwise the read goes through a sync service built for this
 * read alone: one that has never pulled or pushed has no namespace bound,
 * so the S3 and GCS extensions resolve the key to the datastore-wide root
 * from a namespaced repo too. A provider that hands out one shared sync
 * service would have its namespace bound by that read, breaking the
 * command's later namespaced pull, so such a provider is skipped.
 */
export async function readDatastoreFormatMarker(
  repoDir: string,
  config: DatastoreConfig,
  options: ReadDatastoreFormatMarkerOptions = {},
): Promise<DatastoreFormatMarkerRead> {
  if (!isCustomDatastoreConfig(config)) {
    return await readFilesystemMarker(
      join(config.path, DATASTORE_FORMAT_MARKER_FILE),
    );
  }

  if (!config.cachePath) {
    return { kind: "unsupported", reason: `${config.type} has no sync cache` };
  }
  // Names the datastore type too, so a user with several datastores (a
  // serve audit datastore, say) can tell which one was refused.
  const source = `_control/${DATASTORE_FORMAT_MARKER_KEY} on ${config.type}`;
  let store: DatastoreControlPlaneStore;
  try {
    const provider = await (options.resolveProvider ?? resolveCustomProvider)(
      config,
    );
    if (provider.datastoreControlPlaneStore) {
      store = provider.datastoreControlPlaneStore();
    } else if (!provider.createSyncService) {
      return {
        kind: "unsupported",
        reason: `${config.type} provides no sync service`,
      };
    } else {
      const service = provider.createSyncService(repoDir, config.cachePath);
      if (
        !service.capabilities?.().controlPlane || !service.controlPlaneStore
      ) {
        return {
          kind: "unsupported",
          reason: `${config.type} does not advertise controlPlane`,
        };
      }
      if (service === provider.createSyncService(repoDir, config.cachePath)) {
        return {
          kind: "unsupported",
          reason: `${config.type} shares one sync service instance`,
        };
      }
      store = service.controlPlaneStore();
    }
  } catch (error) {
    // The command resolves the provider again and reports the failure itself.
    return { kind: "unreadable", source, error };
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await withTimeout(
      store.get(DATASTORE_FORMAT_MARKER_KEY),
      options.timeoutMs ?? DATASTORE_FORMAT_READ_TIMEOUT_MS,
    );
  } catch (error) {
    return { kind: "unreadable", source, error };
  }
  if (bytes === null) return { kind: "absent" };
  if (bytes.byteLength > DATASTORE_FORMAT_MARKER_MAX_BYTES) {
    return {
      kind: "invalid",
      source,
      reason: `larger than ${DATASTORE_FORMAT_MARKER_MAX_BYTES} bytes`,
    };
  }
  return { kind: "present", source, bytes };
}

async function readFilesystemMarker(
  path: string,
): Promise<DatastoreFormatMarkerRead> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { kind: "absent" };
    // A datastore path that is a file, or missing a parent, has no marker
    // under it; the command reports the bad path itself.
    if (error instanceof Deno.errors.NotADirectory) return { kind: "absent" };
    return { kind: "unreadable", source: path, error };
  }
  if (!info.isFile) {
    return { kind: "invalid", source: path, reason: "not a regular file" };
  }
  if (info.size > DATASTORE_FORMAT_MARKER_MAX_BYTES) {
    return {
      kind: "invalid",
      source: path,
      reason: `larger than ${DATASTORE_FORMAT_MARKER_MAX_BYTES} bytes`,
    };
  }
  try {
    return { kind: "present", source: path, bytes: await Deno.readFile(path) };
  } catch (error) {
    return { kind: "unreadable", source: path, error };
  }
}

/** Rejects when `promise` has not settled within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
    // The losing read may still settle later; its outcome is not wanted.
    promise.catch(() => {});
  }
}
