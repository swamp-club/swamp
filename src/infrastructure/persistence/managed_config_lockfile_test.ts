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

import { assertEquals } from "@std/assert";
import {
  effectiveDatastoreType,
  isExtensionBackedDatastore,
} from "./managed_config_lockfile.ts";
import type { RepoMarkerData } from "./repo_marker_repository.ts";

function marker(
  datastore?: RepoMarkerData["datastore"],
): RepoMarkerData {
  return {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01",
    repoId: "test-repo",
    ...(datastore ? { datastore } : {}),
  };
}

const unset = () => undefined;

Deno.test("effectiveDatastoreType: defaults to filesystem", () => {
  assertEquals(effectiveDatastoreType(marker(), unset), "filesystem");
  assertEquals(effectiveDatastoreType(null, unset), "filesystem");
});

Deno.test("effectiveDatastoreType: uses the marker type", () => {
  assertEquals(
    effectiveDatastoreType(marker({ type: "@swamp/s3-datastore" }), unset),
    "@swamp/s3-datastore",
  );
});

Deno.test("effectiveDatastoreType: the SWAMP_DATASTORE prefix wins", () => {
  const m = marker({ type: "@swamp/s3-datastore" });
  assertEquals(
    effectiveDatastoreType(m, () => "filesystem:/tmp/ds"),
    "filesystem",
  );
  assertEquals(effectiveDatastoreType(m, () => "s3:bucket/prefix"), "s3");
  assertEquals(
    effectiveDatastoreType(m, () => '@acme/pg:{"a":1}'),
    "@acme/pg",
  );
});

Deno.test("isExtensionBackedDatastore: requires managedConfig", () => {
  assertEquals(
    isExtensionBackedDatastore(marker({ type: "@swamp/s3-datastore" }), unset),
    false,
  );
});

Deno.test("isExtensionBackedDatastore: true for a managed extension datastore", () => {
  assertEquals(
    isExtensionBackedDatastore(
      marker({ type: "@swamp/s3-datastore", managedConfig: true }),
      unset,
    ),
    true,
  );
  assertEquals(
    isExtensionBackedDatastore(
      marker({ type: "s3", managedConfig: true }),
      unset,
    ),
    true,
  );
});

Deno.test("isExtensionBackedDatastore: false for a managed filesystem datastore", () => {
  assertEquals(
    isExtensionBackedDatastore(
      marker({ type: "filesystem", path: "/tmp/ds", managedConfig: true }),
      unset,
    ),
    false,
  );
  assertEquals(
    isExtensionBackedDatastore(
      marker({ type: "@swamp/s3-datastore", managedConfig: true }),
      () => "filesystem:/tmp/ds",
    ),
    false,
  );
});
