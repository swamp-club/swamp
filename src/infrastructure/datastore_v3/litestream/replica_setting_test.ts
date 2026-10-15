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
import { withMockedEnv } from "../../persistence/path_test_helpers.ts";
import { UserError } from "../../../domain/errors.ts";
import {
  parseV3ReplicaSetting,
  replicaRootOf,
  V3_REPLICA_ENV,
  v3ReplicaSetting,
} from "./replica_setting.ts";

Deno.test("v3ReplicaSetting: unset means no replication", () => {
  withMockedEnv({ [V3_REPLICA_ENV]: undefined }, () => {
    assertEquals(v3ReplicaSetting(), undefined);
  });
  withMockedEnv({ [V3_REPLICA_ENV]: "" }, () => {
    assertEquals(v3ReplicaSetting(), undefined);
  });
});

Deno.test("v3ReplicaSetting: reads a file or an s3 replica", () => {
  withMockedEnv(
    { [V3_REPLICA_ENV]: JSON.stringify({ type: "file", path: "/r" }) },
    () => assertEquals(v3ReplicaSetting(), { type: "file", path: "/r" }),
  );
  assertEquals(
    parseV3ReplicaSetting(
      JSON.stringify({
        type: "s3",
        bucket: "b",
        path: "p",
        endpoint: "http://127.0.0.1:9000",
      }),
    ),
    { type: "s3", bucket: "b", path: "p", endpoint: "http://127.0.0.1:9000" },
  );
});

Deno.test("parseV3ReplicaSetting: refuses anything that is not a replica", () => {
  for (
    const raw of [
      "not json",
      "1",
      JSON.stringify({ type: "gcs", path: "p" }),
      JSON.stringify({ type: "file" }),
      JSON.stringify({ type: "s3", path: "p" }),
      JSON.stringify({ type: "s3", bucket: "b", path: "p", region: 1 }),
    ]
  ) {
    assertThrows(() => parseV3ReplicaSetting(raw), UserError, V3_REPLICA_ENV);
  }
});

Deno.test("replicaRootOf: distinguishes every replica", () => {
  const roots = new Set([
    replicaRootOf({ type: "file", path: "/a" }),
    replicaRootOf({ type: "file", path: "/b" }),
    replicaRootOf({ type: "s3", bucket: "b", path: "/a" }),
    replicaRootOf({ type: "s3", bucket: "c", path: "/a" }),
    replicaRootOf({
      type: "s3",
      bucket: "b",
      path: "/a",
      endpoint: "http://e",
    }),
    replicaRootOf({ type: "gcs", bucket: "b", path: "/a" }),
    replicaRootOf({ type: "gcs", bucket: "c", path: "/a" }),
  ]);
  assertEquals(roots.size, 7);
});

// A lineage continues only under the root it recorded, so these strings
// must not change (swamp-club#3507): a changed root restarts every lineage.
Deno.test("replicaRootOf: file and s3 roots keep their recorded form", () => {
  assertEquals(replicaRootOf({ type: "file", path: "/a" }), "file:/a");
  assertEquals(
    replicaRootOf({ type: "s3", bucket: "b", path: "p" }),
    "s3::b:p",
  );
  assertEquals(
    replicaRootOf({
      type: "s3",
      bucket: "b",
      path: "p",
      endpoint: "http://e",
      region: "r",
    }),
    "s3:http://e:b:p",
  );
  assertEquals(
    replicaRootOf({
      type: "s3",
      bucket: "b",
      path: "p",
      endpoint: "http://e",
      forcePathStyle: false,
    }),
    "s3:http://e:b:p",
  );
  assertEquals(
    replicaRootOf({ type: "gcs", bucket: "g", path: "p" }),
    "gcs:g:p",
  );
});
