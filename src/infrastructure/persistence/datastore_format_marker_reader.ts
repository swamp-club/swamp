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
 * past this the check proceeds and aborts the read's signal; a slower remote
 * counts as a failed read and the command meets the outage itself; sized with
 * headroom for a first request and credentials fetch
 */
export const DATASTORE_FORMAT_READ_TIMEOUT_MS = 3_000;

/**
 * the same cap for a provider without a datastore-wide store, read through a
 * fresh sync service; that path pays one more round trip (credentials
 * preflight), so it is given longer
 */
export const DATASTORE_FORMAT_FALLBACK_READ_TIMEOUT_MS = 4_000;

export interface ReadDatastoreFormatMarkerOptions {
  readonly timeoutMs?: number;
  readonly fallbackTimeoutMs?: number;
  readonly uncappedTimeoutMs?: number;
  readonly resolveProvider?: (
    config: CustomDatastoreConfig,
  ) => Promise<DatastoreProvider>;
  readonly resolveExtension?: (
    repoDir: string,
    type: string,
  ) => { readonly name: string; readonly version: string } | undefined;
}

/**
 * reads through datastoreControlPlaneStore when offered, else a fresh sync
 * service so no namespace is bound; a provider sharing one sync service is
 * skipped, since the read would bind its namespace
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
  let deadlineMs: number;
  try {
    const provider = await (options.resolveProvider ?? resolveCustomProvider)(
      config,
    );
    if (provider.datastoreControlPlaneStore) {
      store = provider.datastoreControlPlaneStore();
      deadlineMs = options.timeoutMs ?? DATASTORE_FORMAT_READ_TIMEOUT_MS;
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
      deadlineMs = options.fallbackTimeoutMs ?? options.timeoutMs ??
        DATASTORE_FORMAT_FALLBACK_READ_TIMEOUT_MS;
    }
  } catch (error) {
    // The command resolves the provider again and reports the failure itself.
    return { kind: "unreadable", source, error };
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await withDeadline(
      (signal) => store.get(DATASTORE_FORMAT_MARKER_KEY, { signal }),
      deadlineMs,
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

/**
 * Runs `read` and rejects when it has not settled within `ms`, aborting the
 * signal handed to it at that moment. A read that ignores the signal is
 * raced all the same.
 */
export async function withDeadline<T>(
  read: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`timed out after ${ms}ms`);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  let reading: Promise<T> | undefined;
  try {
    reading = read(controller.signal);
    return await Promise.race([reading, timeout]);
  } finally {
    clearTimeout(timer);
    // The losing read may still settle later; its outcome is not wanted.
    reading?.catch(() => {});
  }
}
