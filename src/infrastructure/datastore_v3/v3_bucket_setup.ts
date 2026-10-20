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
 * What `swamp datastore setup --format 3` does on a bucket (swamp-club#3534):
 * checks that the target is new and empty, then writes the format marker
 * through the provider's datastore-wide control plane. Nothing else is
 * written: the first writer's lease, lineage and replica follow from the
 * marker.
 *
 * @module
 */

import type { DatastoreProvider } from "../../domain/datastore/datastore_provider.ts";
import {
  DATASTORE_FORMAT_MARKER_KEY,
  DATASTORE_FORMAT_MARKER_MAX_BYTES,
  DATASTORE_FORMAT_UNSUPPORTED_CODE,
  parseDatastoreFormatMarker,
  V3_DATASTORE_FORMAT,
} from "../../domain/datastore/datastore_format.ts";
import { writeControlPlaneFormatMarker } from "../persistence/datastore_format_marker_writer.ts";
import { datastoreWriterLeaseStore } from "./datastore_writer_lease_store.ts";
import { confirmV3BucketMarker } from "./v3_datastore_binding.ts";

/**
 * The key prefix the S3 and GCS extensions' verifiers write a throwaway
 * conditional-write probe under, inside `_control/`: setup's own health
 * check, never a record.
 */
export const VERIFIER_PROBE_KEY_PREFIX = "conditional-write-probe-";

/** The keys a v2 solo datastore always holds at its root. */
export const V2_ROOT_INDEX_KEYS: readonly string[] = [
  ".datastore-index.json",
  "_index/_meta.json",
];

/** The chunk namespace of an unnamespaced datastore (`storage/1`). */
const DEFAULT_CHUNK_NAMESPACE = "_default";

/** How long the whole target check may take. */
export const V3_BUCKET_PROBE_TIMEOUT_MS = 60_000;

/** What a bucket holds, for a v3 setup. */
export type V3BucketTargetState =
  /** Nothing of swamp's: a new datastore. */
  | { readonly kind: "new" }
  /**
   * Only a format-3 marker: a setup that stopped after writing it, which a
   * re-run completes. The datastore it names is empty (no commits, chunks
   * or records), so any repo may complete it, as it may a new prefix.
   */
  | { readonly kind: "resumable" }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Whether a v3 datastore may be created on the bucket `provider` names, for
 * the checkout at `repoDir` (swamp-club#3534). It must be new and empty: no
 * format marker but a format-3 one, no control-plane record, no chunk, no
 * v2 namespace, and no v2 data at the root. A check that cannot be made
 * refuses rather than warns. Once a format-3 marker is there the v2 checks
 * are not made (swamp-club#3643): setup made them before it wrote the
 * marker, a compliant swamp never writes v2 data beside one, and the
 * extensions' sync services refuse to read a format-3 prefix at all. Known limits: v2 data that has lost both its
 * root index keys is not seen, and neither are Litestream objects left
 * under `<prefix>/_litestream/` by a datastore whose control plane and
 * chunks were deleted by hand.
 */
export async function inspectV3BucketTarget(
  provider: DatastoreProvider,
  datastoreType: string,
  repoDir: string,
  namespace: string | undefined,
  options: { readonly timeoutMs?: number } = {},
): Promise<V3BucketTargetState> {
  const signal = AbortSignal.timeout(
    options.timeoutMs ?? V3_BUCKET_PROBE_TIMEOUT_MS,
  );
  const refused = (reason: string): V3BucketTargetState => ({
    kind: "refused",
    reason,
  });
  try {
    const store = datastoreWriterLeaseStore(provider, datastoreType);
    let marked = false;
    const bytes = await store.get(DATASTORE_FORMAT_MARKER_KEY, { signal });
    if (bytes !== null) {
      if (bytes.byteLength > DATASTORE_FORMAT_MARKER_MAX_BYTES) {
        return refused("it holds a datastore format marker that is not one");
      }
      const marker = parseDatastoreFormatMarker(
        bytes,
        `_control/${DATASTORE_FORMAT_MARKER_KEY} on ${datastoreType}`,
      );
      if (marker.format !== V3_DATASTORE_FORMAT) {
        return refused(`it holds a format ${marker.format} datastore marker`);
      }
      marked = true;
    }

    const records = (await store.list("")).filter((key) =>
      key !== DATASTORE_FORMAT_MARKER_KEY &&
      !key.startsWith(VERIFIER_PROBE_KEY_PREFIX)
    );
    if (records.length > 0) {
      return refused(
        `its control plane already holds records (${
          records.slice(0, 3).join(", ")
        }${records.length > 3 ? ", …" : ""})`,
      );
    }

    const storage = provider.storage?.();
    if (storage === undefined) {
      return refused("its extension provides no chunk storage");
    }
    const chunkNamespaces = [
      DEFAULT_CHUNK_NAMESPACE,
      ...(namespace !== undefined && namespace !== "" ? [namespace] : []),
    ];
    for (const chunkNamespace of chunkNamespaces) {
      for await (const _ of storage.list(chunkNamespace, signal)) {
        return refused("it already holds v3 content chunks");
      }
    }

    if (marked) return { kind: "resumable" };

    if (provider.listNamespaces === undefined) {
      return refused(
        "its extension cannot list namespaces, so swamp cannot tell whether " +
          "it holds v2 data",
      );
    }
    const namespaces = await provider.listNamespaces(
      provider.resolveDatastorePath(repoDir),
    );
    if (namespaces.length > 0) {
      return refused(`it holds v2 namespaces (${namespaces.join(", ")})`);
    }

    if (await holdsV2RootData(provider, repoDir, signal)) {
      return refused("it holds v2 data");
    }
    return { kind: "new" };
  } catch (error) {
    // The extension's refusal of a format-3 prefix tells the user to
    // upgrade swamp, which is wrong here: the marker was written after it
    // was read, as a concurrent setup would, and a re-run sees it.
    if (
      error instanceof Error &&
      (error as { code?: unknown }).code === DATASTORE_FORMAT_UNSUPPORTED_CODE
    ) {
      return refused(
        "a format marker was written to it while it was being inspected, " +
          "which another setup may have done; run the command again",
      );
    }
    return refused(
      `it could not be inspected (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
}

/**
 * Whether the bucket holds a v2 solo datastore's root index, read through a
 * sync service built on a scratch cache: `fetchContent` writes nothing
 * locally, and the scratch directory is removed either way.
 *
 * @throws Error when the extension cannot read a single remote file
 */
async function holdsV2RootData(
  provider: DatastoreProvider,
  repoDir: string,
  signal: AbortSignal,
): Promise<boolean> {
  const scratch = await Deno.makeTempDir({ prefix: "swamp-v3-setup-" });
  try {
    const service = provider.createSyncService?.(repoDir, scratch);
    if (service?.fetchContent === undefined) {
      throw new Error(
        "its extension cannot read a remote file (fetchContent), so swamp " +
          "cannot tell whether it holds v2 data",
      );
    }
    for (const key of V2_ROOT_INDEX_KEYS) {
      if (await service.fetchContent(key, { signal }) !== null) return true;
    }
    return false;
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }
}

/**
 * Creates a v3 datastore on the bucket `provider` names: writes its format
 * marker through the datastore-wide control plane, only if none is there.
 * A marker another setup wrote first is accepted when it says format 3.
 *
 * @throws DatastoreFormatMismatchError when a marker naming another format
 *   is there
 */
export async function initializeV3BucketDatastore(
  provider: DatastoreProvider,
  datastoreType: string,
  writtenBy: string,
): Promise<void> {
  const store = datastoreWriterLeaseStore(provider, datastoreType);
  const created = await writeControlPlaneFormatMarker(store, {
    format: V3_DATASTORE_FORMAT,
    minReaderFormat: V3_DATASTORE_FORMAT,
    writtenBy,
  });
  if (!created) await confirmV3BucketMarker(store, datastoreType);
}
