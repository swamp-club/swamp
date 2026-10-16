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
 * Where a v3 datastore lives and whether it replicates (swamp-club#3534,
 * Phase 4E): one binding per datastore, which every v3 helper reads instead
 * of deriving the location from a filesystem path and replication from the
 * internal replica setting.
 *
 * Every v3 helper is keyed by a local datastore path. A filesystem v3
 * datastore's is its own directory, which holds its marker, `commits.db`,
 * `_blobs/` and `_control/`, and needs no binding. A v3 datastore on a
 * bucket has no local directory of its own, so it gets one: its **local
 * root**, the checkout's directory for its copy of `commits.db`
 * (`.swamp/_datastore_v3_copies/<key>/`). Its bucket binding is registered
 * under that root, and the helpers find it there:
 *
 * - chunks go through the provider's `storage()`;
 * - the writer lease and the replication lineages go through its writable
 *   datastore-wide control plane (`datastoreWriterLeaseStore`);
 * - it always replicates, to the provider's replica target
 *   (`resolveV3ReplicaSetting`; the internal replica setting still wins in
 *   tests), and lineage paths are collected through `replicaPaths()`;
 * - there is no shared `commits.db`: each checkout keeps its own copy;
 * - signal waits and retention watermarks live in the same control plane,
 *   under the reserved `ns/<namespace>/` prefix (`ns/_/` for a solo
 *   datastore), which no namespace slug can reach.
 *
 * Nothing here runs for a filesystem datastore: its helpers behave exactly
 * as before.
 *
 * @module
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

/**
 * The checkout directory that holds its own copies of replicated v3
 * datastores' `commits.db` (swamp-club#3482), one subdirectory per
 * datastore. A bucket datastore's subdirectory is also its local root.
 */
export const V3_LOCAL_COPIES_DIR = "_datastore_v3_copies";

/**
 * The control-plane prefix a bucket datastore's namespaced records live
 * under: signal waits and retention watermarks, which a filesystem datastore
 * keeps under `<path>/<namespace>/_control/`. The lease (`writer/`), the
 * lineages (`lineage/`) and the format marker sit at the root beside it.
 */
export const V3_BUCKET_NAMESPACED_PREFIX = "ns";

/**
 * The segment under {@link V3_BUCKET_NAMESPACED_PREFIX} for a datastore with
 * no namespace. A namespace slug starts with a letter or digit, so it can
 * never be this.
 */
export const V3_BUCKET_SOLO_SEGMENT = "_";

/** How long the marker confirmation may take: no tight deadline. */
export const V3_MARKER_CONFIRM_TIMEOUT_MS = 60_000;

/** A v3 datastore on a bucket, as the v3 helpers see it. */
export interface V3BucketBinding {
  /** The datastore's type, for messages. */
  readonly type: string;
  /** The local root the helpers key on (resolved). */
  readonly root: string;
  /** The provider's own replica root, which keys the local root. */
  readonly ownRoot: string;
  /** The provider's `storage/1` chunk storage. */
  readonly storage: DatastoreStorage;
  /** The writable datastore-wide control plane: lease and lineages. */
  readonly controlPlane: WritableDatastoreControlPlaneStore;
  /** Where every writer replicates its copy. */
  readonly replica: V3ReplicaSetting;
  /** The provider's replica paths, bound to its own replica target. */
  readonly replicaPaths: V3ReplicaPaths | undefined;
  /**
   * Confirms, once per process, that the datastore's format marker is
   * present and says format 3 (swamp-club#3534). Runs before this process
   * takes the writer lease or makes its copy current, so a datastore whose
   * marker the format guard could not read is touched only once it is
   * known to be v3.
   *
   * @throws DatastoreFormatMismatchError when the marker is missing or says
   *   another format
   */
  confirmMarker(): Promise<void>;
}

/** The bucket bindings of this process, by local root. */
const bindings = new Map<string, V3BucketBinding>();

/** The locations bound per config object, so a config binds once. */
let locations = new WeakMap<CustomDatastoreConfig, V3DatastoreLocation>();

/** The bucket binding whose local root is `datastorePath`, if any. */
export function v3BucketBindingAt(
  datastorePath: string,
): V3BucketBinding | undefined {
  return bindings.get(resolve(datastorePath));
}

/**
 * The replica the v3 datastore at `datastorePath` replicates to, or
 * undefined when it does not replicate: a bucket datastore's always; a
 * filesystem datastore's only while the internal replica setting names one.
 */
export function v3ReplicaFor(
  datastorePath: string,
): V3ReplicaSetting | undefined {
  return v3BucketBindingAt(datastorePath)?.replica ?? v3ReplicaSetting();
}

/** Whether the v3 datastore at `datastorePath` replicates. */
export function v3ReplicatesAt(datastorePath: string): boolean {
  return v3ReplicaFor(datastorePath) !== undefined;
}

/**
 * The datastore-wide control plane of the v3 datastore at `datastorePath`:
 * its provider's for a bucket datastore, its own `_control/` directory for a
 * filesystem one.
 */
export function v3ControlPlaneAt(
  datastorePath: string,
): WritableDatastoreControlPlaneStore {
  return v3BucketBindingAt(datastorePath)?.controlPlane ??
    new FileSystemControlPlaneStore(resolve(datastorePath));
}

/**
 * The control plane a bucket datastore's namespaced records live in: its
 * datastore-wide one, under `ns/<namespace>/` (`ns/_/` solo).
 */
export function v3BucketNamespacedStore(
  binding: V3BucketBinding,
  namespace: string | undefined,
): WritableDatastoreControlPlaneStore {
  const segment = namespace === undefined || namespace === ""
    ? V3_BUCKET_SOLO_SEGMENT
    : namespace;
  return prefixedStore(
    binding.controlPlane,
    `${V3_BUCKET_NAMESPACED_PREFIX}/${segment}/`,
  );
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

/**
 * Where the v3 helpers find a v3 datastore: its local datastore path and
 * the layout a checkout commits under. A filesystem datastore's config is
 * one; a bucket datastore's names its local root.
 */
export interface V3DatastoreLocation {
  readonly path: string;
  readonly namespace?: string;
  readonly directories?: string[];
  readonly exclude?: string[];
}

/**
 * The bucket datastore's local root in the checkout at `repoDir`: keyed by
 * the provider's own replica root, which names the bucket and prefix, so
 * the internal replica setting tests use never moves it.
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
 * Refuses a datastore that cannot host v3 here, in the order setup reports
 * (swamp-club#3534): a provider without every v3 capability, a platform
 * Litestream cannot replicate on (Windows below the pin), and a replica
 * target the provider refuses, as it refuses it. Resolves with the
 * provider's own replica, whatever the internal replica setting says.
 *
 * @throws V3HostingUnsupportedError
 * @throws UserError
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

/** What {@link bindV3BucketDatastore} takes besides the config. */
export interface BindV3BucketOptions {
  /** The operating system and architecture Litestream must run on. */
  readonly platform?: { readonly os: string; readonly arch: string };
}

/**
 * Binds the v3 datastore `config` names on a bucket for the checkout at
 * `repoDir`, once per config object, and returns its location. Refuses a
 * provider that cannot host v3, a platform Litestream cannot replicate on,
 * and a replica target the provider refuses.
 *
 * @throws V3HostingUnsupportedError
 * @throws UserError when replication is unavailable here, or the provider
 *   refuses its replica target
 */
export function bindV3BucketDatastore(
  repoDir: string,
  config: CustomDatastoreConfig,
  provider: DatastoreProvider,
  options: BindV3BucketOptions = {},
): V3DatastoreLocation {
  const known = locations.get(config);
  if (known !== undefined) return known;
  const ownRoot = replicaRootOf(
    assertV3BucketHost(provider, config.type, options.platform),
  );
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
  // Its locks are file locks under the same root (swamp-club#3534).
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

/**
 * The location {@link bindV3BucketDatastore} bound for `config`, or
 * undefined when it was not bound in this process.
 */
export function boundV3BucketLocation(
  config: CustomDatastoreConfig,
): V3DatastoreLocation | undefined {
  return locations.get(config);
}

/**
 * Reads the datastore's format marker through `store` with no tight
 * deadline and requires it to say format 3.
 *
 * @throws DatastoreFormatMismatchError when it is missing or says another
 *   format
 * @throws InvalidDatastoreFormatMarkerError when it is not a marker
 * @throws UnreachableDatastoreFormatMarkerError when it cannot be read
 */
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

/** Test seam: forgets every bucket binding of this process. */
export function resetV3BucketBindingsForTesting(): void {
  bindings.clear();
  locations = new WeakMap();
  resetV3BucketLockRootsForTesting();
}
