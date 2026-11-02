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
 * the verifiers' throwaway conditional-write probe keys inside _control/:
 * setup's own health check, never a record
 */
export const VERIFIER_PROBE_KEY_PREFIX = "conditional-write-probe-";

export const V2_ROOT_INDEX_KEYS: readonly string[] = [
  ".datastore-index.json",
  "_index/_meta.json",
];

const DEFAULT_CHUNK_NAMESPACE = "_default";

export const V3_BUCKET_PROBE_TIMEOUT_MS = 60_000;

export type V3BucketTargetState =
  | { readonly kind: "new" }
  /**
   * a setup that stopped after writing the marker; the datastore is empty, so
   * any repo may complete it
   */
  | { readonly kind: "resumable" }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * with a format-3 marker present v2 root data is not probed: a compliant swamp
 * never writes it beside one and the sync services refuse such reads; v2 data
 * that lost both root index keys is not seen
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

    if (marked) return { kind: "resumable" };
    if (await holdsV2RootData(provider, repoDir, signal)) {
      return refused("it holds v2 data");
    }
    return { kind: "new" };
  } catch (error) {
    // The extension's refusal of a format-3 prefix tells the user to
    // upgrade swamp, which is wrong here, so its text is never shown.
    if (
      error instanceof Error &&
      (error as { code?: unknown }).code === DATASTORE_FORMAT_UNSUPPORTED_CODE
    ) {
      return refused(
        await markerNowPresent(provider, datastoreType, options.timeoutMs)
          ? "a format marker was written to it while it was being " +
            "inspected, which another setup may have done; run the command " +
            "again"
          : "its extension refused to read it, so swamp cannot tell " +
            "whether it holds v2 data",
      );
    }
    return refused(
      `it could not be inspected (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
}

async function markerNowPresent(
  provider: DatastoreProvider,
  datastoreType: string,
  timeoutMs: number | undefined,
): Promise<boolean> {
  try {
    const bytes = await datastoreWriterLeaseStore(provider, datastoreType)
      .get(DATASTORE_FORMAT_MARKER_KEY, {
        signal: AbortSignal.timeout(timeoutMs ?? V3_BUCKET_PROBE_TIMEOUT_MS),
      });
    return bytes !== null;
  } catch {
    return false;
  }
}

/**
 * read through a sync service on a scratch cache: fetchContent writes nothing
 * locally, and the scratch directory is removed either way
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
