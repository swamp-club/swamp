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
 * the v3 writer lease lives in the provider's datastore-wide control plane,
 * never scoped to a namespace; the provider must declare `datastoreWideLease`,
 * since a writable store alone does not show that
 */

import {
  isWritableDatastoreControlPlaneStore,
  type WritableDatastoreControlPlaneStore,
} from "../../domain/datastore/control_plane_store.ts";
import type { DatastoreProvider } from "../../domain/datastore/datastore_provider.ts";
import { UserError } from "../../domain/errors.ts";

/**
 * throws when the provider does not declare `datastoreWideLease` or offers no
 * writable store: a sync service's control plane binds a namespace, so it can
 * never stand in
 */
export function datastoreWriterLeaseStore(
  provider: Pick<
    DatastoreProvider,
    "datastoreControlPlaneStore" | "datastoreWideLease"
  >,
  datastoreType: string,
): WritableDatastoreControlPlaneStore {
  if (provider.datastoreWideLease !== true) {
    throw new UserError(
      `The ${datastoreType} datastore does not declare datastoreWideLease, so it cannot hold a v3 writer lease: nothing says a namespaced push keeps _control/writer/ at the datastore root. Update the datastore extension to a version that declares it.`,
    );
  }
  const store = provider.datastoreControlPlaneStore?.();
  if (store !== undefined && isWritableDatastoreControlPlaneStore(store)) {
    return store;
  }
  throw new UserError(
    `The ${datastoreType} datastore cannot hold a v3 writer lease: it offers no writable datastore-wide control plane (datastoreControlPlaneStore). Update the datastore extension to a version that does.`,
  );
}
