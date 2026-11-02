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
import { assert, assertRejects } from "jsr:@std/assert@1.0.19";
import type {
  DatastoreStorage,
  ReplicaPathStore,
  V3ReplicaTarget,
} from "./datastore_types.ts";
import { FENCE_DIGITS } from "./replica_path_fence.ts";

export interface ReplicaPathConformanceOptions {
  replicaTarget: () => V3ReplicaTarget;
  openReplicaPaths: () => ReplicaPathStore | Promise<ReplicaPathStore>;
  openStorage: () => DatastoreStorage | Promise<DatastoreStorage>;
  /**
   * Writes an object at `key`, a full key in the provider's bucket, with
   * the test's own client rather than through the provider, as Litestream
   * would.
   */
  writeObject: (key: string, bytes: Uint8Array) => Promise<void>;
  deleteObject: (key: string) => Promise<void>;
  objectExists: (key: string) => Promise<boolean>;
  /**
   * objects the suite writes under each fence; raise it above the backend's
   * listing page size against an emulator to check that removePath pages.
   */
  objectsPerFence?: number;
}

export { replicaPathFenceProblem } from "./replica_path_fence.ts";

function pad(fence: number): string {
  return String(fence).padStart(FENCE_DIGITS, "0");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * checks replicaPaths() against the contract v3 lineage collection relies on:
 * list returns both suite fences, removePath deletes exactly one and refuses
 * malformed fences. It removes what it wrote.
 */
export async function assertReplicaPathConformance(
  options: ReplicaPathConformanceOptions,
): Promise<void> {
  const target = options.replicaTarget();
  const root = `${target.prefix === "" ? "" : `${target.prefix}/`}_litestream/`;
  const perFence = options.objectsPerFence ?? 3;
  assert(
    Number.isSafeInteger(perFence) && perFence >= 1,
    "objectsPerFence must be a positive integer",
  );
  // Fences far above any a real datastore reaches, so the suite never
  // meets a lineage of its own bucket.
  const first = 900_000_000_000 +
    Math.floor(Math.random() * 90_000_000_000);
  const removed = pad(first);
  const kept = pad(first + 1);
  const lookAlike = `${removed}-conformance`;
  const keysUnder = (dir: string) =>
    Array.from(
      { length: perFence },
      (_, i) => i === 0 ? `${root}${dir}/snapshot` : `${root}${dir}/ltx/0/${i}`,
    );
  const removedKeys = keysUnder(removed);
  const keptKeys = keysUnder(kept);
  const lookAlikeKey = `${root}${lookAlike}/object`;
  const bytes = new TextEncoder().encode(`replica path ${removed}`);

  const store = await options.openReplicaPaths();
  const storage = await options.openStorage();
  const signal = new AbortController().signal;
  const namespace = `conformance-${removed}`;
  const chunk = new TextEncoder().encode(`replica path chunk ${removed}`);
  const sha256 = await sha256Hex(chunk);
  const prefix = target.prefix === "" ? "" : `${target.prefix}/`;
  const chunkKey = `${prefix}_blobs/${namespace}/sha256/${
    sha256.slice(0, 2)
  }/${sha256}`;

  try {
    for (const key of [...removedKeys, ...keptKeys, lookAlikeKey]) {
      await options.writeObject(key, bytes);
    }
    await storage.put(namespace, sha256, chunk, signal);

    const listed = await store.list(signal);
    assert(
      listed.every((name) => typeof name === "string" && !name.includes("/")),
      `list() must return fence directory names without a slash: ${
        JSON.stringify(listed)
      }`,
    );
    assert(
      listed.includes(removed) && listed.includes(kept),
      `list() must return the fences written under ${root}: ` +
        `${removed} and ${kept}`,
    );

    await store.removePath(removed, signal);
    for (const key of removedKeys) {
      assert(
        !await options.objectExists(key),
        `removePath("${removed}") must delete ${key}` +
          (perFence > 1 ? ", and every page of the fence's objects" : ""),
      );
    }
    for (const key of keptKeys) {
      assert(
        await options.objectExists(key),
        `removePath("${removed}") must not delete ${key}, under another fence`,
      );
    }
    assert(
      await options.objectExists(lookAlikeKey),
      `removePath("${removed}") must not delete ${lookAlikeKey}: only ` +
        `objects under ${root}${removed}/ are the fence's`,
    );
    assert(
      await options.objectExists(chunkKey),
      `removePath("${removed}") must not delete the chunk at ${chunkKey}`,
    );
    assert(
      !(await store.list(signal)).includes(removed),
      `list() must not return ${removed} once its path is removed`,
    );
    await store.removePath(removed, signal);

    const malformed = [
      "",
      "1",
      kept.slice(0, FENCE_DIGITS - 1),
      `${kept}0`,
      `${kept}/`,
      `/${kept}`,
      `${kept.slice(0, FENCE_DIGITS - 1)}a`,
      "000000000000",
      "../_blobs",
      `${kept.slice(0, FENCE_DIGITS - 2)}/.`,
      `${kept.slice(0, FENCE_DIGITS - 1)} `,
      "٠".repeat(FENCE_DIGITS),
      lookAlike,
    ];
    for (const fence of malformed) {
      await assertRejects(
        async () => await store.removePath(fence, signal),
        Error,
        undefined,
        `removePath(${JSON.stringify(fence)}) must refuse a malformed fence`,
      );
    }
    for (const key of [...keptKeys, lookAlikeKey, chunkKey]) {
      assert(
        await options.objectExists(key),
        `a refused removePath must delete nothing, but ${key} is gone`,
      );
    }
  } finally {
    // Best effort: a cleanup that fails must not hide the check that did.
    const quietly = (cleanup: () => Promise<void>) => cleanup().catch(() => {});
    await quietly(() => store.removePath(removed, signal));
    await quietly(() => store.removePath(kept, signal));
    await quietly(() => options.deleteObject(lookAlikeKey));
    await quietly(() => storage.delete(namespace, sha256, signal));
  }
}
