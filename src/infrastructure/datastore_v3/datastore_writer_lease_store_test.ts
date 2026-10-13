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

import { assertEquals, assertThrows } from "@std/assert";
import { createInMemoryRemote } from "@swamp-club/swamp-testing";
import { UserError } from "../../domain/errors.ts";
import { datastoreWriterLeaseStore } from "./datastore_writer_lease_store.ts";

Deno.test("datastoreWriterLeaseStore: returns the provider's writable datastore-wide store", async () => {
  const remote = createInMemoryRemote({ controlPlane: true });
  const store = datastoreWriterLeaseStore({
    datastoreControlPlaneStore: () => remote.datastoreControlPlaneStore!(),
  }, "@test/remote");

  assertEquals(
    await store.putIfAbsent("writer/fence-000000000001", new Uint8Array([1])),
    true,
  );
  assertEquals([...remote.controlPlaneRecords().keys()], [
    "_control/writer/fence-000000000001",
  ]);
});

Deno.test("datastoreWriterLeaseStore: refuses a provider without a datastore-wide store", () => {
  assertThrows(
    () => datastoreWriterLeaseStore({}, "@swamp/s3-datastore"),
    UserError,
    "The @swamp/s3-datastore datastore cannot hold a v3 writer lease",
  );
});

Deno.test("datastoreWriterLeaseStore: refuses a read-only datastore-wide store", () => {
  assertThrows(
    () =>
      datastoreWriterLeaseStore({
        datastoreControlPlaneStore: () => ({
          get: () => Promise.resolve(null),
        }),
      }, "@swamp/gcs-datastore"),
    UserError,
    "offers no writable datastore-wide control plane",
  );
});
