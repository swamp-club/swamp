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
 * The scan behind `swamp doctor datastores`'s unreadable_versions check
 * (swamp-club#3955): every published data version of a v2 filesystem
 * datastore whose stored content cannot be read.
 *
 * @module
 */

import { ModelType } from "../../domain/models/model_type.ts";
import type { Namespace } from "../../domain/data/namespace.ts";
import type { UnreadableDataVersion } from "../../domain/data/unreadable_data_version.ts";
import type { CatalogStore, CatalogVersionKey } from "./catalog_store.ts";
import type {
  DataNameKey,
  FileSystemUnifiedDataRepository,
} from "./unified_data_repository.ts";

/** What the scan knows of one published version before reading it. */
interface PublishedVersion {
  latest: boolean;
  modelName: string;
}

/**
 * Every published version of the datastore that cannot be read, and every
 * data name whose latest marker names no version, ordered by model type,
 * model id, data name and version.
 *
 * Walks every data name on disk together with every catalog row of
 * `namespace` that is not pending; rows of other namespaces describe data
 * that is not in this layout and are never read. Only published versions
 * are checked (see `src/domain/data/unreadable_data_version.ts`), so a write
 * in flight is never reported. Read-only: neither the files nor the catalog
 * are changed, and no data query runs, so no catalog backfill hides what
 * the scan measures. The one state it touches is the process's record of
 * read warnings: each version it reports is noted, so a read later in the
 * same process does not warn about it again.
 *
 * For a repository whose files are all local (the filesystem datastore):
 * with lazy hydration a missing file is not damage.
 */
export async function scanUnreadableVersions(
  dataRepo: FileSystemUnifiedDataRepository,
  catalogStore: CatalogStore,
  namespace: Namespace,
): Promise<UnreadableDataVersion[]> {
  const keyOf = (type: string, modelId: string, dataName: string) =>
    `${type}\0${modelId}\0${dataName}`;

  const names = new Map<string, DataNameKey>();
  for await (const name of dataRepo.iterateDataNames()) {
    names.set(keyOf(name.type.normalized, name.modelId, name.dataName), name);
  }
  const rowsByName = new Map<string, CatalogVersionKey[]>();
  for (const row of catalogStore.versionKeys(namespace)) {
    const key = keyOf(row.type_normalized, row.model_id, row.data_name);
    const rows = rowsByName.get(key);
    if (rows) rows.push(row);
    else rowsByName.set(key, [row]);
    if (names.has(key)) continue;
    try {
      names.set(key, {
        type: ModelType.create(row.type_normalized),
        modelId: row.model_id,
        dataName: row.data_name,
      });
    } catch {
      // A row whose type is not a valid model type names no layout path.
    }
  }

  const findings: UnreadableDataVersion[] = [];
  for (const [key, { type, modelId, dataName }] of names) {
    const published = new Map<number, PublishedVersion>();
    for (const row of rowsByName.get(key) ?? []) {
      published.set(row.version, {
        latest: row.is_latest === 1,
        modelName: row.model_name,
      });
    }
    const marker = await dataRepo.latestMarkerState(type, modelId, dataName);
    if (marker.kind === "version" && marker.version > 0) {
      const known = published.get(marker.version);
      published.set(marker.version, {
        latest: true,
        modelName: known?.modelName ?? "",
      });
    }

    let modelName = "";
    const found: Array<
      Omit<UnreadableDataVersion, "modelName" | "readableVersion">
    > = [];
    if (marker.kind === "unreadable") {
      found.push({
        modelType: type.normalized,
        modelId,
        dataName,
        version: null,
        reason: "marker_unreadable",
        latest: true,
      });
    }
    for (const version of [...published.keys()].sort((a, b) => a - b)) {
      const { latest, modelName: rowModelName } = published.get(version)!;
      if (modelName === "") modelName = rowModelName;
      const inspection = await dataRepo.inspectVersion(
        type,
        modelId,
        dataName,
        version,
      );
      if (modelName === "" && inspection.modelName !== undefined) {
        modelName = inspection.modelName;
      }
      if (inspection.reason === undefined) continue;
      // Reported here, so a read later in this process does not repeat it.
      dataRepo.noteUnreadableVersionReported(type, modelId, dataName, version);
      found.push({
        modelType: type.normalized,
        modelId,
        dataName,
        version,
        reason: inspection.reason,
        latest,
      });
    }
    if (found.length === 0) continue;

    const readableVersion = await dataRepo.highestReadableVersion(
      type,
      modelId,
      dataName,
    );
    for (const finding of found) {
      findings.push({ ...finding, modelName, readableVersion });
    }
  }

  return findings.sort((a, b) =>
    compare(a.modelType, b.modelType) ||
    compare(a.modelId, b.modelId) ||
    compare(a.dataName, b.dataName) ||
    (a.version ?? 0) - (b.version ?? 0)
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
