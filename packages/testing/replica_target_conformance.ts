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
import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import type {
  DatastoreStorage,
  V3ReplicaTarget,
  WritableDatastoreControlPlaneStore,
} from "./datastore_types.ts";

/** Options for {@link assertReplicaTargetConformance}. */
export interface ReplicaTargetConformanceOptions {
  /** The provider's `replicaTarget()`, which swamp calls synchronously. */
  replicaTarget: () => V3ReplicaTarget;
  /** The bucket the provider is configured with. */
  bucket: string;
  /** The provider's `storage()`. */
  openStorage: () => DatastoreStorage | Promise<DatastoreStorage>;
  /** The provider's writable `datastoreControlPlaneStore()`. */
  openDatastoreStore: () =>
    | WritableDatastoreControlPlaneStore
    | Promise<WritableDatastoreControlPlaneStore>;
  /**
   * Whether an object exists at `key`, a full key in `bucket`, read
   * straight from the backend with the test's own client rather than
   * through the provider.
   */
  objectExists: (key: string) => Promise<boolean>;
}

/**
 * The fields each kind of target may carry; anything else is refused. These
 * rules copy swamp's own (`src/domain/datastore/replica_target.ts`), and
 * `replica_target_test.ts` there runs both over one fixture list: change
 * them together.
 */
const ALLOWED_KEYS: Readonly<Record<string, readonly string[]>> = {
  s3: ["type", "bucket", "prefix", "region", "endpoint", "forcePathStyle"],
  gcs: ["type", "bucket", "prefix"],
};

/**
 * Why `value` is not a replica target swamp can use, or undefined when it
 * is one. The same rules swamp applies to what `replicaTarget()` returns.
 */
export function replicaTargetProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "it is not an object";
  }
  const record = value as Record<string, unknown>;
  // An own-key check: `type: "constructor"` must not find Object's.
  const allowed =
    typeof record.type === "string" && Object.hasOwn(ALLOWED_KEYS, record.type)
      ? ALLOWED_KEYS[record.type]
      : undefined;
  if (allowed === undefined) return '"type" must be "s3" or "gcs"';
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      return `it carries "${key}", which a ${record.type} target may not; ` +
        "a replica target never carries credentials";
    }
  }
  const bucket = record.bucket;
  if (typeof bucket !== "string" || bucket === "" || bucket.includes("/")) {
    return '"bucket" must be a non-empty string without "/"';
  }
  const prefix = record.prefix;
  if (typeof prefix !== "string") return '"prefix" must be a string';
  if (prefix !== "") {
    const segments = prefix.split("/");
    if (segments.some((s) => s === "" || s === "." || s === "..")) {
      return '"prefix" must have no leading, trailing or repeated "/", ' +
        'and no "." or ".." segment';
    }
  }
  if (record.type === "gcs") return undefined;
  if (
    record.region !== undefined &&
    (typeof record.region !== "string" || record.region === "")
  ) {
    return '"region" must be a non-empty string';
  }
  if (
    record.forcePathStyle !== undefined &&
    typeof record.forcePathStyle !== "boolean"
  ) {
    return '"forcePathStyle" must be a boolean';
  }
  if (record.endpoint !== undefined) {
    return endpointProblem(record.endpoint);
  }
  return undefined;
}

function endpointProblem(endpoint: unknown): string | undefined {
  if (typeof endpoint !== "string" || endpoint === "") {
    return '"endpoint" must be a non-empty string';
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return '"endpoint" must be a URL';
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return '"endpoint" must be an http or https URL';
  }
  if (url.username !== "" || url.password !== "") {
    return '"endpoint" must not carry credentials';
  }
  if (url.search !== "" || url.hash !== "") {
    return '"endpoint" must have no query or fragment';
  }
  return undefined;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Checks a provider's `replicaTarget()` against the contract swamp's v3
 * replication relies on.
 *
 * Checked: the target is one swamp accepts (its type's fields only, so no
 * credentials; a bucket; a prefix with no leading, trailing or repeated
 * slash and no `.` or `..` segment; an http or https endpoint with no
 * userinfo, query or fragment); it names the provider's `bucket`; and its
 * `prefix` is the datastore root that `storage()` and
 * `datastoreControlPlaneStore()` write under: a control-plane record the
 * suite writes is at `<prefix>/_control/<key>`, and a chunk at
 * `<prefix>/_blobs/<namespace>/sha256/<first two hex>/<sha256>` (with no
 * leading slash for an empty prefix).
 *
 * The suite writes one record and one chunk of its own, under a namespace
 * of its own, and deletes both.
 *
 * ```ts
 * import { assertReplicaTargetConformance } from "@swamp-club/swamp-testing";
 *
 * Deno.test("replica target conformance", async () => {
 *   const provider = createProvider(config);
 *   await assertReplicaTargetConformance({
 *     replicaTarget: () => provider.replicaTarget!(),
 *     bucket: config.bucket,
 *     openStorage: () => provider.storage!(),
 *     openDatastoreStore: () =>
 *       provider.datastoreControlPlaneStore!() as WritableDatastoreControlPlaneStore,
 *     objectExists: (key) => headObject(config.bucket, key),
 *   });
 * });
 * ```
 */
export async function assertReplicaTargetConformance(
  options: ReplicaTargetConformanceOptions,
): Promise<void> {
  const target = options.replicaTarget();
  assert(
    typeof (target as { then?: unknown }).then !== "function",
    "replicaTarget() must return the target itself, not a promise: swamp " +
      "calls it synchronously",
  );
  const problem = replicaTargetProblem(target);
  assert(
    problem === undefined,
    `replicaTarget() returned a target swamp cannot use: ${problem}`,
  );
  assertEquals(
    target.bucket,
    options.bucket,
    "replicaTarget() must name the bucket the datastore writes to",
  );
  const root = target.prefix === "" ? "" : `${target.prefix}/`;
  const suffix = crypto.randomUUID().slice(0, 8);

  const store = await options.openDatastoreStore();
  const key = `conformance-replica-target-${suffix}`;
  await store.put(key, new TextEncoder().encode("replica target"));
  try {
    const controlKey = `${root}_control/${key}`;
    assert(
      await options.objectExists(controlKey),
      `a record datastoreControlPlaneStore() wrote must be at ${controlKey}: ` +
        `replicaTarget()'s prefix must be the datastore root it writes under`,
    );
  } finally {
    await store.delete(key);
  }

  const storage = await options.openStorage();
  const signal = new AbortController().signal;
  const namespace = `conformance-${suffix}`;
  const bytes = new TextEncoder().encode(`replica target ${suffix}`);
  const sha256 = await sha256Hex(bytes);
  await storage.put(namespace, sha256, bytes, signal);
  try {
    const chunkKey = `${root}_blobs/${namespace}/sha256/${
      sha256.slice(0, 2)
    }/${sha256}`;
    assert(
      await options.objectExists(chunkKey),
      `a chunk storage() stored must be at ${chunkKey}: replicaTarget()'s ` +
        `prefix must be the datastore root it writes under`,
    );
  } finally {
    await storage.delete(namespace, sha256, signal);
  }
}
