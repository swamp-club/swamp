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

// deno-lint-ignore-file no-import-prefix
import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { assertReplicaTargetConformance } from "./replica_target_conformance.ts";
import {
  createInMemoryRemote,
  type InMemoryRemote,
} from "./in_memory_remote.ts";
import type {
  V3ReplicaTarget,
  WritableDatastoreControlPlaneStore,
} from "./datastore_types.ts";

const BUCKET = "in-memory";

function remoteWith(target: unknown): InMemoryRemote {
  return createInMemoryRemote({
    controlPlane: true,
    storage: true,
    replicaTarget: target as V3ReplicaTarget,
  });
}

function optionsFor(remote: InMemoryRemote, bucket = BUCKET) {
  return {
    replicaTarget: () => remote.replicaTarget!(),
    bucket,
    openStorage: () => remote.storage!(),
    openDatastoreStore: () =>
      remote
        .datastoreControlPlaneStore!() as WritableDatastoreControlPlaneStore,
    objectExists: (key: string) => remote.objectExists(key),
  };
}

Deno.test("assertReplicaTargetConformance: the in-memory remote conforms and is left without records or chunks", async () => {
  for (
    const target of [
      { type: "s3", bucket: BUCKET, prefix: "" },
      {
        type: "s3",
        bucket: BUCKET,
        prefix: "",
        region: "us-east-1",
        endpoint: "http://127.0.0.1:9000",
        forcePathStyle: false,
      },
      { type: "gcs", bucket: BUCKET, prefix: "" },
    ]
  ) {
    const remote = remoteWith(target);
    await assertReplicaTargetConformance(optionsFor(remote));
    assertEquals(remote.controlPlaneRecords().size, 0);
    const listed = await Array.fromAsync(
      remote.storage!().list("", new AbortController().signal),
    );
    assertEquals(listed, []);
  }
});

Deno.test("assertReplicaTargetConformance: catches a target swamp cannot use", async () => {
  const bad: [unknown, string][] = [
    [
      { type: "s3", bucket: BUCKET, prefix: "", secretAccessKey: "x" },
      "secretAccessKey",
    ],
    [
      { type: "gcs", bucket: BUCKET, prefix: "", credentials: {} },
      "credentials",
    ],
    [
      {
        type: "s3",
        bucket: BUCKET,
        prefix: "",
        endpoint: "https://key:secret@s3.example",
      },
      "must not carry credentials",
    ],
    [{ type: "s3", bucket: BUCKET, prefix: "root/" }, '"prefix"'],
    [{ type: "azure", bucket: BUCKET, prefix: "" }, '"type"'],
  ];
  for (const [target, message] of bad) {
    await assertRejects(
      () => assertReplicaTargetConformance(optionsFor(remoteWith(target))),
      Error,
      message,
    );
  }
});

Deno.test("assertReplicaTargetConformance: catches a target naming another bucket", async () => {
  const remote = remoteWith({ type: "s3", bucket: "other", prefix: "" });
  await assertRejects(
    () => assertReplicaTargetConformance(optionsFor(remote)),
    Error,
    "must name the bucket",
  );
});

Deno.test("assertReplicaTargetConformance: catches a prefix that is not where the datastore writes", async () => {
  // The in-memory remote writes at the bucket root, so any prefix is wrong.
  const remote = remoteWith({ type: "s3", bucket: BUCKET, prefix: "root" });
  await assertRejects(
    () => assertReplicaTargetConformance(optionsFor(remote)),
    Error,
    "root/_control/",
  );
  assertEquals(remote.controlPlaneRecords().size, 0);
});

Deno.test("assertReplicaTargetConformance: catches chunks stored outside the target's prefix", async () => {
  const remote = remoteWith({ type: "s3", bucket: BUCKET, prefix: "" });
  await assertRejects(
    () =>
      assertReplicaTargetConformance({
        ...optionsFor(remote),
        // Control records are found, chunks are not.
        objectExists: (key) =>
          key.startsWith("_blobs/")
            ? Promise.resolve(false)
            : remote.objectExists(key),
      }),
    Error,
    "a chunk storage() stored",
  );
});

Deno.test("InMemoryRemote.objectExists: answers by bucket key", async () => {
  const remote = remoteWith({ type: "gcs", bucket: BUCKET, prefix: "" });
  const signal = new AbortController().signal;
  const sha = "ab".padEnd(64, "0");
  await remote.storage!().put("ns", sha, new Uint8Array([1]), signal);
  assertEquals(await remote.objectExists(`_blobs/ns/sha256/ab/${sha}`), true);
  assertEquals(await remote.objectExists(`_blobs/ns/sha256/cd/${sha}`), false);
  assertEquals(await remote.objectExists(`ns/${sha}`), false);
  remote.seedControlPlane("writer/x", new Uint8Array([1]));
  assertEquals(await remote.objectExists("_control/writer/x"), true);
  assertEquals(await remote.objectExists("_control/writer/y"), false);
});
