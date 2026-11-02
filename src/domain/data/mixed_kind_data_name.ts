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

import type { DataKind } from "./data_kind.ts";

export interface DataVersionKind {
  version: number;
  kind: DataKind;
  specName: string;
}

/** a data name whose live versions hold both kinds, so one kind is hidden */
export interface MixedKindDataName {
  modelType: string;
  modelId: string;
  modelName: string;
  dataName: string;
  versions: DataVersionKind[];
}

export interface DataVersionKindRow {
  modelType: string;
  modelId: string;
  modelName: string;
  dataName: string;
  version: number;
  dataType: string;
  /** the writer-stamped kind tag, empty on versions written before it */
  recordKind: string;
  specName: string;
  lifecycle: string;
}

function kindOf(row: DataVersionKindRow): DataKind | undefined {
  for (const value of [row.recordKind, row.dataType]) {
    if (value === "file" || value === "resource") return value;
  }
  return undefined;
}

/**
 * rows must be ordered by name, then version; a delete or rename marker ends a
 * history, and a version of no known kind is skipped, as the write check does
 */
export function findMixedKindNames(
  rows: Iterable<DataVersionKindRow>,
): MixedKindDataName[] {
  const found: MixedKindDataName[] = [];
  let current: MixedKindDataName | undefined;
  let history: DataVersionKind[] = [];
  const close = () => {
    if (
      current !== undefined && history.some((v) => v.kind === "file") &&
      history.some((v) => v.kind === "resource")
    ) {
      for (const version of history) current.versions.push(version);
    }
    history = [];
  };
  const flush = () => {
    close();
    if (current !== undefined && current.versions.length > 0) {
      found.push(current);
    }
  };

  for (const row of rows) {
    if (
      current === undefined || current.modelType !== row.modelType ||
      current.modelId !== row.modelId || current.dataName !== row.dataName
    ) {
      flush();
      current = {
        modelType: row.modelType,
        modelId: row.modelId,
        modelName: row.modelName,
        dataName: row.dataName,
        versions: [],
      };
    }
    if (current.modelName === "") current.modelName = row.modelName;
    if (row.lifecycle === "deleted") {
      close();
      continue;
    }
    const kind = kindOf(row);
    if (kind !== undefined) {
      history.push({ version: row.version, kind, specName: row.specName });
    }
  }
  flush();
  return found;
}
