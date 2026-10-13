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
 * Where the v3 writer lease lives on a datastore that is not a filesystem
 * one: its provider's writable datastore-wide control plane, at
 * `_control/writer/` at the datastore root (swamp-club#3364). There is one
 * `commits.db`, and so one writer, per datastore, so the lease is never
 * scoped to a namespace.
 *
 * Dormant: format 3 is refused on every datastore but a filesystem one, so
 * nothing calls it until the Phase 4 bucket opt-in binds the lease through
 * it.
 *
 * @module
 */

import {
  isWritableDatastoreControlPlaneStore,
  type WritableDatastoreControlPlaneStore,
} from "../../domain/datastore/control_plane_store.ts";
import type { DatastoreProvider } from "../../domain/datastore/datastore_provider.ts";
import { UserError } from "../../domain/errors.ts";

/**
 * The provider's writable datastore-wide control plane, for the v3 writer
 * lease. Throws when the provider offers none, or only a read-only one: a
 * sync service's control plane binds a namespace, so it can never stand in.
 */
export function datastoreWriterLeaseStore(
  provider: Pick<DatastoreProvider, "datastoreControlPlaneStore">,
  datastoreType: string,
): WritableDatastoreControlPlaneStore {
  const store = provider.datastoreControlPlaneStore?.();
  if (store !== undefined && isWritableDatastoreControlPlaneStore(store)) {
    return store;
  }
  throw new UserError(
    `The ${datastoreType} datastore cannot hold a v3 writer lease: it offers no writable datastore-wide control plane (datastoreControlPlaneStore). Update the datastore extension to a version that does.`,
  );
}
