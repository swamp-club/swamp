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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { UserError } from "../errors.ts";
import { replicaTargetProblem as testingReplicaTargetProblem } from "../../../packages/testing/replica_target_conformance.ts";
import {
  parseV3ReplicaTarget,
  replicaTargetProblem,
} from "./replica_target.ts";

/**
 * Targets and whether they are accepted. Both the core check and the
 * testing package's copy run over this one list, so the two cannot drift.
 */
const REPLICA_TARGET_FIXTURES: readonly [unknown, boolean][] = [
  [{ type: "s3", bucket: "b", prefix: "" }, true],
  [{ type: "s3", bucket: "b", prefix: "team/root" }, true],
  [{
    type: "s3",
    bucket: "b",
    prefix: "p",
    region: "us-east-1",
    endpoint: "http://127.0.0.1:9000",
    forcePathStyle: true,
  }, true],
  [{
    type: "s3",
    bucket: "b",
    prefix: "p",
    endpoint: "https://s3.example:8443/base",
    forcePathStyle: false,
  }, true],
  [{ type: "gcs", bucket: "g", prefix: "" }, true],
  [{ type: "gcs", bucket: "g", prefix: "a/b" }, true],
  [null, false],
  [[], false],
  ["s3", false],
  [{ type: "file", path: "/r" }, false],
  [{ type: "azure", bucket: "b", prefix: "" }, false],
  [{ bucket: "b", prefix: "" }, false],
  [{ type: "s3", prefix: "" }, false],
  [{ type: "s3", bucket: "", prefix: "" }, false],
  [{ type: "s3", bucket: "a/b", prefix: "" }, false],
  [{ type: "s3", bucket: "b" }, false],
  [{ type: "s3", bucket: "b", prefix: "/p" }, false],
  [{ type: "s3", bucket: "b", prefix: "p/" }, false],
  [{ type: "s3", bucket: "b", prefix: "a//b" }, false],
  [{ type: "s3", bucket: "b", prefix: "a/../b" }, false],
  [{ type: "s3", bucket: "b", prefix: "." }, false],
  [{ type: "s3", bucket: "b", prefix: "", region: "" }, false],
  [{ type: "s3", bucket: "b", prefix: "", forcePathStyle: "yes" }, false],
  [{ type: "s3", bucket: "b", prefix: "", endpoint: "" }, false],
  [{ type: "s3", bucket: "b", prefix: "", endpoint: "not a url" }, false],
  [{ type: "s3", bucket: "b", prefix: "", endpoint: "ftp://e" }, false],
  [{
    type: "s3",
    bucket: "b",
    prefix: "",
    endpoint: "https://AKIA:secret@e",
  }, false],
  [{ type: "s3", bucket: "b", prefix: "", endpoint: "https://AKIA@e" }, false],
  [
    { type: "s3", bucket: "b", prefix: "", endpoint: "https://:secret@e" },
    false,
  ],
  [{ type: "s3", bucket: "b", prefix: "", endpoint: "https://e?k=v" }, false],
  [{ type: "s3", bucket: "b", prefix: "", endpoint: "https://e#f" }, false],
  [{ type: "s3", bucket: "b", prefix: "", accessKeyId: "AKIA" }, false],
  [{ type: "s3", bucket: "b", prefix: "", secretAccessKey: "s" }, false],
  [{ type: "s3", bucket: "b", prefix: "", sessionToken: "t" }, false],
  [{ type: "s3", bucket: "b", prefix: "", credentials: {} }, false],
  [{ type: "gcs", bucket: "g", prefix: "", credentials: {} }, false],
  [{ type: "gcs", bucket: "g", prefix: "", endpoint: "http://e" }, false],
  [{ type: "gcs", bucket: "g", prefix: "", apiEndpoint: "http://e" }, false],
  [{ type: "gcs", bucket: "g", prefix: "", region: "r" }, false],
];

Deno.test("replicaTargetProblem: accepts and refuses each fixture", () => {
  for (const [value, ok] of REPLICA_TARGET_FIXTURES) {
    assertEquals(
      replicaTargetProblem(value) === undefined,
      ok,
      JSON.stringify(value),
    );
  }
});

Deno.test("replicaTargetProblem: the testing package's copy gives the same answer", () => {
  for (const [value] of REPLICA_TARGET_FIXTURES) {
    assertEquals(
      testingReplicaTargetProblem(value),
      replicaTargetProblem(value),
      JSON.stringify(value),
    );
  }
});

Deno.test("parseV3ReplicaTarget: returns an accepted target as it is", () => {
  const target = { type: "gcs", bucket: "g", prefix: "root" };
  assertEquals(parseV3ReplicaTarget(target, "@test/ds"), target);
});

Deno.test("parseV3ReplicaTarget: names the datastore and the field, never its value", () => {
  const error = assertThrows(
    () =>
      parseV3ReplicaTarget(
        { type: "s3", bucket: "b", prefix: "", secretAccessKey: "hunter2" },
        "@swamp/s3-datastore",
      ),
    UserError,
  );
  assertStringIncludes(error.message, "@swamp/s3-datastore");
  assertStringIncludes(error.message, "secretAccessKey");
  assertEquals(error.message.includes("hunter2"), false);
});

Deno.test("parseV3ReplicaTarget: an endpoint's credentials are not echoed", () => {
  const error = assertThrows(
    () =>
      parseV3ReplicaTarget(
        {
          type: "s3",
          bucket: "b",
          prefix: "",
          endpoint: "https://AKIA:hunter2@e",
        },
        "@test/ds",
      ),
    UserError,
  );
  assertEquals(error.message.includes("hunter2"), false);
});
