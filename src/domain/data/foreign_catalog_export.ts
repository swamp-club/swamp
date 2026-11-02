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

import { UserError } from "../errors.ts";
import { type Namespace, restoreNamespace } from "./namespace.ts";
import type { CatalogExportRow } from "../datastore/datastore_sync_service.ts";

/**
 * reserved names are accepted, as a repo may have claimed one before it was
 * reserved; the reader's own namespace is refused, since pulling it would
 * replace its own catalog rows with the remote export
 */
export function parseForeignNamespaces(
  values: readonly string[],
  ownNamespace: Namespace,
): Namespace[] {
  const namespaces: Namespace[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (value.length === 0) continue;
    let namespace: Namespace;
    try {
      namespace = restoreNamespace(value);
    } catch {
      throw new UserError(
        `Cannot pull namespace ${
          JSON.stringify(value)
        }: a namespace is lowercase letters, digits and hyphens, starts and ` +
          "ends with a letter or digit, and is at most 64 characters.",
      );
    }
    if (namespace === ownNamespace) {
      throw new UserError(
        `Cannot pull namespace ${
          JSON.stringify(value)
        }: it is this repository's own namespace. Catalog pull reads other ` +
          "namespaces; this repository's own catalog comes from its own data.",
      );
    }
    if (!namespaces.includes(namespace)) namespaces.push(namespace);
  }
  return namespaces;
}

export interface AcceptedForeignExportRows {
  rows: CatalogExportRow[];
  rejected: number;
}

/**
 * an export speaks only for its namespace, so a row naming any other (the
 * reader's, the solo one, a third) is dropped rather than stored under the
 * namespace it claims
 */
export function acceptForeignExportRows(
  namespace: Namespace,
  rows: readonly CatalogExportRow[],
): AcceptedForeignExportRows {
  const accepted = rows.filter((row) => row.namespace === namespace);
  return { rows: accepted, rejected: rows.length - accepted.length };
}
