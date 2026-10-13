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
    datastoreWideLease: true,
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

Deno.test("datastoreWriterLeaseStore: refuses a writable datastore-wide store without the datastoreWideLease declaration", () => {
  // The store has every method the lease uses, but nothing says a
  // namespaced push leaves _control/writer/ at the root (swamp-club#3414).
  const remote = createInMemoryRemote({ controlPlane: true });
  assertThrows(
    () =>
      datastoreWriterLeaseStore({
        datastoreControlPlaneStore: () => remote.datastoreControlPlaneStore!(),
      }, "@swamp/s3-datastore"),
    UserError,
    "The @swamp/s3-datastore datastore does not declare datastoreWideLease",
  );
});

Deno.test("datastoreWriterLeaseStore: only a literal true declares datastoreWideLease", () => {
  const remote = createInMemoryRemote({ controlPlane: true });
  for (const declared of [false, undefined, "true", 1]) {
    assertThrows(
      () =>
        datastoreWriterLeaseStore({
          datastoreWideLease: declared as boolean | undefined,
          datastoreControlPlaneStore: () =>
            remote.datastoreControlPlaneStore!(),
        }, "@test/remote"),
      UserError,
      "does not declare datastoreWideLease",
    );
  }
});

Deno.test("datastoreWriterLeaseStore: refuses a provider without a datastore-wide store", () => {
  assertThrows(
    () =>
      datastoreWriterLeaseStore(
        { datastoreWideLease: true },
        "@swamp/s3-datastore",
      ),
    UserError,
    "The @swamp/s3-datastore datastore cannot hold a v3 writer lease",
  );
});

Deno.test("datastoreWriterLeaseStore: refuses a read-only datastore-wide store", () => {
  assertThrows(
    () =>
      datastoreWriterLeaseStore({
        datastoreWideLease: true,
        datastoreControlPlaneStore: () => ({
          get: () => Promise.resolve(null),
        }),
      }, "@swamp/gcs-datastore"),
    UserError,
    "offers no writable datastore-wide control plane",
  );
});
