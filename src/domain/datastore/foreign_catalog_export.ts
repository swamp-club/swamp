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
import { type Namespace, restoreNamespace } from "../data/namespace.ts";
import type { CatalogExportRow } from "./datastore_sync_service.ts";

/**
 * Parses the namespaces a foreign catalog pull asks for. Values are trimmed,
 * empty ones dropped and duplicates removed. Each must have a namespace's
 * shape (reserved names are accepted, as a repo may have claimed one before it
 * was reserved), and none may be the reader's own namespace: pulling it would
 * replace the reader's own catalog rows with the remote export
 * (swamp-club#3636).
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
    } catch (error) {
      throw new UserError(
        `Cannot pull namespace ${JSON.stringify(value)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
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

/** The rows of one namespace's export a reader accepts, and how many it did not. */
export interface AcceptedForeignExportRows {
  rows: CatalogExportRow[];
  rejected: number;
}

/**
 * Keeps the rows of `namespace`'s catalog export that belong to `namespace`.
 * An export is written by its namespace and speaks only for it, so a row
 * naming any other namespace — the reader's, the empty solo namespace, or a
 * third one — is dropped rather than stored under the namespace it claims
 * (swamp-club#3636).
 */
export function acceptForeignExportRows(
  namespace: Namespace,
  rows: readonly CatalogExportRow[],
): AcceptedForeignExportRows {
  const accepted = rows.filter((row) => row.namespace === namespace);
  return { rows: accepted, rejected: rows.length - accepted.length };
}
