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

import {
  assertEquals,
  assertInstanceOf,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  assertV3Hosting,
  missingV3Capabilities,
  V3_BUCKET_MIN_EXTENSION_VERSION,
  V3_HOSTING_UNSUPPORTED_CODE,
  type V3HostingCapabilities,
  V3HostingUnsupportedError,
} from "./v3_hosting.ts";
import { UserError } from "../errors.ts";

const CAPABLE: V3HostingCapabilities = {
  datastoreWideLease: true,
  datastoreControlPlaneStore: () => ({ get: () => Promise.resolve(null) }),
  storage: () => {
    throw new Error("not called");
  },
  replicaTarget: () => ({ type: "gcs", bucket: "b", prefix: "" }),
  replicaPaths: () => {
    throw new Error("not called");
  },
};

Deno.test("missingV3Capabilities: a provider with all five lacks nothing", () => {
  assertEquals(missingV3Capabilities(CAPABLE), []);
});

Deno.test("missingV3Capabilities: names each missing capability, in a fixed order", () => {
  assertEquals(missingV3Capabilities({}), [
    "datastoreWideLease",
    "datastoreControlPlaneStore()",
    "storage()",
    "replicaTarget()",
    "replicaPaths()",
  ]);
  const { replicaPaths: _, ...withoutPaths } = CAPABLE;
  assertEquals(missingV3Capabilities(withoutPaths), ["replicaPaths()"]);
});

Deno.test("missingV3Capabilities: only the literal true declares datastoreWideLease", () => {
  for (const value of [false, undefined, "true" as unknown as boolean]) {
    assertEquals(
      missingV3Capabilities({ ...CAPABLE, datastoreWideLease: value }),
      ["datastoreWideLease"],
    );
  }
});

Deno.test("assertV3Hosting: refuses with the missing capabilities and the minimum extension version", () => {
  const { storage: _, ...withoutStorage } = CAPABLE;
  const error = assertThrows(
    () => assertV3Hosting(withoutStorage, "@swamp/s3-datastore"),
    V3HostingUnsupportedError,
  );
  assertInstanceOf(error, UserError);
  assertEquals(error.code, V3_HOSTING_UNSUPPORTED_CODE);
  assertEquals(error.missing, ["storage()"]);
  assertStringIncludes(error.message, "@swamp/s3-datastore");
  assertStringIncludes(error.message, "storage()");
  assertStringIncludes(error.message, V3_BUCKET_MIN_EXTENSION_VERSION);
  assertStringIncludes(error.message, "swamp extension update");
});

Deno.test("assertV3Hosting: a capable provider passes", () => {
  assertV3Hosting(CAPABLE, "@swamp/gcs-datastore");
});
