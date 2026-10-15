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
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import {
  assertReplicaPathConformance,
  type ReplicaPathConformanceOptions,
} from "./replica_path_conformance.ts";
import { createInMemoryRemote } from "./in_memory_remote.ts";
import type { ReplicaPathStore } from "./datastore_types.ts";

function inMemoryOptions(objectsPerFence?: number) {
  const remote = createInMemoryRemote({
    storage: true,
    replicaPaths: true,
    replicaTarget: { type: "s3", bucket: "in-memory", prefix: "" },
  });
  const options: ReplicaPathConformanceOptions = {
    replicaTarget: () => remote.replicaTarget!(),
    openReplicaPaths: () => remote.replicaPaths!(),
    openStorage: () => remote.storage!(),
    writeObject: (key, bytes) =>
      Promise.resolve(remote.putReplicaObject!(key, bytes)),
    deleteObject: (key) => Promise.resolve(remote.deleteReplicaObject!(key)),
    objectExists: (key) => remote.objectExists(key),
    ...(objectsPerFence !== undefined ? { objectsPerFence } : {}),
  };
  return { remote, options };
}

const signal = new AbortController().signal;

Deno.test("assertReplicaPathConformance: the in-memory remote conforms and is left without replica objects or chunks", async () => {
  for (const objectsPerFence of [undefined, 1, 7]) {
    const { remote, options } = inMemoryOptions(objectsPerFence);
    await assertReplicaPathConformance(options);
    assertEquals(await remote.replicaPaths!().list(signal), []);
    const listed = await Array.fromAsync(remote.storage!().list("", signal));
    assertEquals(listed, []);
  }
});

/**
 * A bucket stand-in over one map, for stores that break the contract in
 * one way each. Keys are full bucket keys with an empty prefix.
 */
function fakeOptions(
  makeStore: (objects: Map<string, Uint8Array>) => ReplicaPathStore,
): ReplicaPathConformanceOptions {
  const objects = new Map<string, Uint8Array>();
  const remote = createInMemoryRemote({ storage: true });
  return {
    replicaTarget: () => ({ type: "s3", bucket: "fake", prefix: "" }),
    openReplicaPaths: () => makeStore(objects),
    openStorage: () => remote.storage!(),
    writeObject: (key, bytes) => {
      objects.set(key, bytes);
      return Promise.resolve();
    },
    deleteObject: (key) => {
      objects.delete(key);
      return Promise.resolve();
    },
    objectExists: async (key) =>
      objects.has(key) || await remote.objectExists(key),
    objectsPerFence: 5,
  };
}

function listFences(objects: Map<string, Uint8Array>): string[] {
  const fences = new Set<string>();
  for (const key of objects.keys()) {
    const [root, fence, ...rest] = key.split("/");
    if (root === "_litestream" && rest.length > 0) fences.add(fence);
  }
  return [...fences];
}

function removeUnder(objects: Map<string, Uint8Array>, prefix: string): void {
  for (const key of [...objects.keys()]) {
    if (key.startsWith(prefix)) objects.delete(key);
  }
}

Deno.test("assertReplicaPathConformance: catches a store that deletes a look-alike sibling", async () => {
  await assertRejects(
    () =>
      assertReplicaPathConformance(fakeOptions((objects) => ({
        list: () => Promise.resolve(listFences(objects)),
        removePath: (fence) => {
          if (!/^[0-9]{12}$/.test(fence) || fence === "000000000000") {
            return Promise.reject(new Error("malformed"));
          }
          // No trailing slash: a directory named after the fence goes too.
          removeUnder(objects, `_litestream/${fence}`);
          return Promise.resolve();
        },
      }))),
    Error,
    "are the fence's",
  );
});

Deno.test("assertReplicaPathConformance: catches a store that removes only the first listing page", async () => {
  await assertRejects(
    () =>
      assertReplicaPathConformance(fakeOptions((objects) => ({
        list: () => Promise.resolve(listFences(objects)),
        removePath: (fence) => {
          if (!/^[0-9]{12}$/.test(fence) || fence === "000000000000") {
            return Promise.reject(new Error("malformed"));
          }
          const page = [...objects.keys()]
            .filter((key) => key.startsWith(`_litestream/${fence}/`))
            .slice(0, 2);
          for (const key of page) objects.delete(key);
          return Promise.resolve();
        },
      }))),
    Error,
    "every page",
  );
});

Deno.test("assertReplicaPathConformance: catches a store that accepts a malformed fence", async () => {
  await assertRejects(
    () =>
      assertReplicaPathConformance(fakeOptions((objects) => ({
        list: () => Promise.resolve(listFences(objects)),
        removePath: (fence) => {
          removeUnder(objects, `_litestream/${fence}/`);
          return Promise.resolve();
        },
      }))),
    Error,
    "must refuse a malformed fence",
  );
});

Deno.test("assertReplicaPathConformance: a removePath that always throws is reported, not hidden by the cleanup", async () => {
  await assertRejects(
    () =>
      assertReplicaPathConformance(fakeOptions((objects) => ({
        list: () => Promise.resolve(listFences(objects)),
        removePath: () => Promise.reject(new Error("removal broken")),
      }))),
    Error,
    "removal broken",
  );
});

Deno.test("assertReplicaPathConformance: catches a store whose list misses a fence", async () => {
  await assertRejects(
    () =>
      assertReplicaPathConformance(fakeOptions((objects) => ({
        list: () => Promise.resolve(listFences(objects).slice(1)),
        removePath: (fence) => {
          if (!/^[0-9]{12}$/.test(fence) || fence === "000000000000") {
            return Promise.reject(new Error("malformed"));
          }
          removeUnder(objects, `_litestream/${fence}/`);
          return Promise.resolve();
        },
      }))),
    Error,
    "list() must return the fences",
  );
});

Deno.test("createInMemoryRemote: replicaPaths pages, refuses malformed fences and takes injected failures", async () => {
  const remote = createInMemoryRemote({ replicaPaths: true });
  for (let i = 0; i < 5; i++) {
    remote.putReplicaObject!(
      `_litestream/000000000003/ltx/${i}`,
      new Uint8Array([i]),
    );
  }
  remote.putReplicaObject!(
    "_litestream/000000000004/snapshot",
    new Uint8Array(),
  );
  const store = remote.replicaPaths!();
  assertEquals((await store.list(signal)).sort(), [
    "000000000003",
    "000000000004",
  ]);
  await store.removePath("000000000003", signal);
  assertEquals(await store.list(signal), ["000000000004"]);
  await assertRejects(() => store.removePath("3", signal), Error, "12 digits");
  assert(await remote.objectExists("_litestream/000000000004/snapshot"));
  remote.failNext("replicaPaths");
  await assertRejects(() => store.list(signal), Error, "injected replicaPaths");
  assertEquals(await store.list(signal), ["000000000004"]);
  let refused = false;
  try {
    remote.putReplicaObject!("_blobs/x", new Uint8Array());
  } catch {
    refused = true;
  }
  assert(refused, "a replica object must be under _litestream/");
});
