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
 * a bucket datastore has no local directory, so its local root holds the copy
 * of commits.db and its binding is registered there. Nothing here runs for a
 * filesystem datastore
 */

import { createHash } from "node:crypto";
import { resolve } from "@std/path";
import type { CustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import type { DatastoreProvider } from "../../domain/datastore/datastore_provider.ts";
import type { DatastoreStorage } from "../../domain/datastore/datastore_storage.ts";
import type {
  ControlPlaneReadOptions,
  WritableDatastoreControlPlaneStore,
} from "../../domain/datastore/control_plane_store.ts";
import {
  DATASTORE_FORMAT_MARKER_KEY,
  DATASTORE_FORMAT_MARKER_MAX_BYTES,
  DatastoreFormatMismatchError,
  InvalidDatastoreFormatMarkerError,
  parseDatastoreFormatMarker,
  UnreachableDatastoreFormatMarkerError,
  V3_DATASTORE_FORMAT,
} from "../../domain/datastore/datastore_format.ts";
import {
  assertV3Hosting,
  V3HostingUnsupportedError,
} from "../../domain/datastore/v3_hosting.ts";
import { litestreamAvailability } from "../../domain/datastore_v3/litestream_release.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import { FileSystemControlPlaneStore } from "../persistence/fs_control_plane_store.ts";
import {
  resetV3BucketLockRootsForTesting,
  setV3BucketLockRoot,
} from "../persistence/datastore_lock_target.ts";
import { swampPath } from "../persistence/paths.ts";
import { datastoreWriterLeaseStore } from "./datastore_writer_lease_store.ts";
import { serveUpstreamAt } from "./serve_upstream_registry.ts";
import { LITESTREAM_PIN } from "./litestream/litestream_pin.ts";
import {
  replicaRootOf,
  type V3ReplicaSetting,
  v3ReplicaSetting,
} from "./litestream/replica_setting.ts";
import {
  resolveV3ProviderReplica,
  resolveV3ReplicaPaths,
  resolveV3ReplicaSetting,
  type V3ReplicaPaths,
} from "./litestream/replica_target_resolver.ts";

/** a bucket datastore's subdirectory is also its local root */
export const V3_LOCAL_COPIES_DIR = "_datastore_v3_copies";

/**
 * a filesystem datastore keeps these under <path>/<namespace>/_control/; the
 * lease, lineages and format marker sit at the root beside it
 */
export const V3_BUCKET_NAMESPACED_PREFIX = "ns";

/** a namespace slug starts with a letter or digit, so it can never be this */
export const V3_BUCKET_SOLO_SEGMENT = "_";

/** How long the marker confirmation may take: no tight deadline. */
export const V3_MARKER_CONFIRM_TIMEOUT_MS = 60_000;

export interface V3BucketBinding {
  readonly type: string;
  readonly root: string;
  readonly ownRoot: string;
  readonly storage: DatastoreStorage;
  readonly controlPlane: WritableDatastoreControlPlaneStore;
  readonly replica: V3ReplicaSetting;
  readonly replicaPaths: V3ReplicaPaths | undefined;
  /**
   * runs before this process takes the writer lease or makes its copy current,
   * so a datastore whose marker the format guard could not read is touched only
   * once known to be v3
   */
  confirmMarker(): Promise<void>;
}

const bindings = new Map<string, V3BucketBinding>();

let locations = new WeakMap<CustomDatastoreConfig, V3DatastoreLocation>();

export function v3BucketBindingAt(
  datastorePath: string,
): V3BucketBinding | undefined {
  return bindings.get(resolve(datastorePath));
}

/**
 * a bucket datastore's always; a filesystem datastore's only while the internal
 * replica setting names one
 */
export function v3ReplicaFor(
  datastorePath: string,
): V3ReplicaSetting | undefined {
  // a copy of serve's log is never replicated: serve's own is
  if (serveUpstreamAt(datastorePath) !== undefined) return undefined;
  return v3BucketBindingAt(datastorePath)?.replica ?? v3ReplicaSetting();
}

export function v3ReplicatesAt(datastorePath: string): boolean {
  return v3ReplicaFor(datastorePath) !== undefined;
}

export function v3ControlPlaneAt(
  datastorePath: string,
): WritableDatastoreControlPlaneStore {
  return v3BucketBindingAt(datastorePath)?.controlPlane ??
    new FileSystemControlPlaneStore(resolve(datastorePath));
}

export function v3BucketNamespacedStore(
  binding: V3BucketBinding,
  namespace: string | undefined,
): WritableDatastoreControlPlaneStore {
  return v3NamespacedStore(binding.controlPlane, namespace);
}

/**
 * serve's own control plane lives there in team mode, so every serve node of
 * the datastore sees it
 */
export function v3NamespacedStore(
  store: WritableDatastoreControlPlaneStore,
  namespace: string | undefined,
): WritableDatastoreControlPlaneStore {
  const segment = namespace === undefined || namespace === ""
    ? V3_BUCKET_SOLO_SEGMENT
    : namespace;
  return prefixedStore(store, `${V3_BUCKET_NAMESPACED_PREFIX}/${segment}/`);
}

function prefixedStore(
  store: WritableDatastoreControlPlaneStore,
  prefix: string,
): WritableDatastoreControlPlaneStore {
  return {
    get: (key: string, options?: ControlPlaneReadOptions) =>
      store.get(prefix + key, options),
    put: (key: string, data: Uint8Array) => store.put(prefix + key, data),
    putIfAbsent: (key: string, data: Uint8Array) =>
      store.putIfAbsent(prefix + key, data),
    delete: (key: string) => store.delete(prefix + key),
    list: async (listPrefix: string) =>
      (await store.list(prefix + listPrefix))
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length)),
  };
}

export interface V3DatastoreLocation {
  readonly path: string;
  readonly namespace?: string;
  readonly directories?: string[];
  readonly exclude?: string[];
}

/**
 * keyed by the provider's own replica root, which names the bucket and prefix,
 * so the internal replica setting tests use never moves it
 */
export function v3BucketLocalRoot(
  repoDir: string,
  replicaRoot: string,
): string {
  const key = createHash("sha256").update(`bucket\0${replicaRoot}`)
    .digest("hex").slice(0, 16);
  return swampPath(canonicalDir(repoDir), V3_LOCAL_COPIES_DIR, key);
}

function canonicalDir(path: string): string {
  try {
    return Deno.realPathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * checks run in the order setup reports; resolves with the provider's own
 * replica, whatever the internal replica setting says
 */
export function assertV3BucketHost(
  provider: DatastoreProvider,
  datastoreType: string,
  platform: { readonly os: string; readonly arch: string } = {
    os: Deno.build.os,
    arch: Deno.build.arch,
  },
): V3ReplicaSetting {
  assertV3Hosting(provider, datastoreType);
  const availability = litestreamAvailability(
    LITESTREAM_PIN,
    platform.os,
    platform.arch,
  );
  if (!availability.available) {
    throw new UserError(
      `The ${datastoreType} datastore cannot host a v3 datastore here: v3 ` +
        `replicates through Litestream, and ${lowerFirst(availability.reason)}`,
    );
  }
  return resolveV3ProviderReplica(provider, datastoreType);
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0].toLowerCase() + text.slice(1);
}

export interface BindV3BucketOptions {
  readonly platform?: { readonly os: string; readonly arch: string };
}

export function bindV3BucketDatastore(
  repoDir: string,
  config: CustomDatastoreConfig,
  provider: DatastoreProvider,
  options: BindV3BucketOptions = {},
): V3DatastoreLocation {
  const known = locations.get(config);
  if (known !== undefined) return known;
  // the local root stays keyed on the root as written, so no existing copy
  // moves
  const ownRoot = replicaRootOf(
    assertV3BucketHost(provider, config.type, options.platform),
  ).value;
  const replica = resolveV3ReplicaSetting(provider, config.type);
  const root = resolve(v3BucketLocalRoot(repoDir, ownRoot));
  const existing = bindings.get(root);
  if (existing !== undefined) {
    // Another config object for the same datastore (re-resolved): it keeps
    // the first binding, and with it the marker already confirmed. Two
    // datastores on one root would be a bug in the key, not a replace.
    if (existing.type !== config.type || existing.ownRoot !== ownRoot) {
      throw markErrorPaths(
        new Error(
          `Internal error: the v3 datastores ${existing.type} and ` +
            `${config.type} share the local root ${root}`,
        ),
        [root],
      );
    }
    setV3BucketLockRoot(config, root);
    return rememberLocation(config, root);
  }
  Deno.mkdirSync(root, { recursive: true });
  const controlPlane = datastoreWriterLeaseStore(provider, config.type);
  // assertV3Hosting checked it is there.
  const storage = provider.storage?.();
  if (storage === undefined) {
    throw new V3HostingUnsupportedError(config.type, ["storage()"]);
  }
  let confirming: Promise<void> | undefined;
  const binding: V3BucketBinding = {
    type: config.type,
    root,
    ownRoot,
    storage,
    controlPlane,
    replica,
    replicaPaths: resolveV3ReplicaPaths(provider, config.type),
    confirmMarker() {
      confirming ??= confirmV3BucketMarker(controlPlane, config.type).catch(
        (error) => {
          // A failure is retried by the next caller.
          confirming = undefined;
          throw error;
        },
      );
      return confirming;
    },
  };
  bindings.set(root, binding);
  // its locks are file locks under the same root
  setV3BucketLockRoot(config, root);
  return rememberLocation(config, root);
}

function rememberLocation(
  config: CustomDatastoreConfig,
  root: string,
): V3DatastoreLocation {
  const location: V3DatastoreLocation = {
    path: root,
    ...(config.namespace !== undefined ? { namespace: config.namespace } : {}),
    ...(config.directories !== undefined
      ? { directories: config.directories }
      : {}),
    ...(config.exclude !== undefined ? { exclude: config.exclude } : {}),
  };
  locations.set(config, location);
  return location;
}

export function boundV3BucketLocation(
  config: CustomDatastoreConfig,
): V3DatastoreLocation | undefined {
  return locations.get(config);
}

export async function confirmV3BucketMarker(
  store: Pick<WritableDatastoreControlPlaneStore, "get">,
  datastoreType: string,
  timeoutMs: number = V3_MARKER_CONFIRM_TIMEOUT_MS,
): Promise<void> {
  const source = `_control/${DATASTORE_FORMAT_MARKER_KEY} on ${datastoreType}`;
  let bytes: Uint8Array | null;
  try {
    bytes = await store.get(DATASTORE_FORMAT_MARKER_KEY, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new UnreachableDatastoreFormatMarkerError(
      source,
      error instanceof Error ? error.message : String(error),
      V3_DATASTORE_FORMAT,
    );
  }
  if (bytes === null) {
    throw new DatastoreFormatMismatchError(V3_DATASTORE_FORMAT, undefined);
  }
  if (bytes.byteLength > DATASTORE_FORMAT_MARKER_MAX_BYTES) {
    throw new InvalidDatastoreFormatMarkerError(
      source,
      `larger than ${DATASTORE_FORMAT_MARKER_MAX_BYTES} bytes`,
    );
  }
  const marker = parseDatastoreFormatMarker(bytes, source);
  if (marker.format !== V3_DATASTORE_FORMAT) {
    throw new DatastoreFormatMismatchError(V3_DATASTORE_FORMAT, marker.format);
  }
}

export function resetV3BucketBindingsForTesting(): void {
  bindings.clear();
  locations = new WeakMap();
  resetV3BucketLockRootsForTesting();
}
