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
import type { DatastoreStorage, StoredChunk } from "./datastore_types.ts";

/** Options for {@link assertStorageConformance}. */
export interface StorageConformanceOptions {
  /** How many puts of one hash are raced against each other. Default: 8. */
  concurrency?: number;
  /**
   * Sets a stored chunk's `lastModified`, so the suite can check that
   * `touch` and `put` refresh it without waiting. A filesystem storage sets
   * the mtime; an in-memory one writes the field. Leave it out for a
   * backend that cannot backdate an object, such as a real bucket: the
   * refresh checks are then skipped.
   */
  setLastModified?(
    namespace: string,
    sha256: string,
    date: Date,
  ): Promise<void>;
  /**
   * The namespace the main checks use, for a storage bound to one
   * namespace. Default: a fresh `conformance-<random>` namespace per run.
   * With it the suite's chunk contents are unique to the run, so chunks an
   * earlier run left behind do not change the result.
   */
  namespace?: string;
  /**
   * Parts of `storage/1` the storage cannot offer, each with the reason it
   * cannot, as a non-empty string. Default: none, and every check runs.
   *
   * - `list`: the list checks are skipped, and iterating `list` must reject.
   *   The checks that `touch` and `put` refresh `lastModified` read it
   *   through `list`, so they are skipped too.
   * - `delete`: the delete checks are skipped, and `delete` must reject and
   *   leave the chunk. The suite cannot clean up, so it leaves the chunks it
   *   wrote behind.
   * - `namespaces`: the namespace isolation checks, including `_default`,
   *   are skipped. `namespace` must then be given.
   *
   * An unsupported method must still reject on an aborted signal, with
   * either error.
   */
  unsupported?: {
    /** Why the storage cannot list its chunks. */
    list?: string;
    /** Why the storage cannot delete chunks. */
    delete?: string;
    /** Why the storage serves one namespace only. */
    namespaces?: string;
  };
}

const encode = (text: string) => new TextEncoder().encode(text);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

async function listAll(
  storage: DatastoreStorage,
  namespace: string,
): Promise<StoredChunk[]> {
  return await Array.fromAsync(
    storage.list(namespace, new AbortController().signal),
  );
}

/**
 * Checks a `storage/1` {@link DatastoreStorage} against the contract swamp
 * relies on.
 *
 * `openStorage` is called more than once and must return handles onto the
 * same chunks each time, as two swamp processes on one datastore get. The
 * suite writes only under namespaces of its own and deletes what it wrote.
 *
 * Checked: the contract string and capabilities, and that `touch` is
 * implemented exactly when declared; `put` then `get`, `get` of a missing
 * chunk, `has` on present, missing and mixed batches; a re-put leaving one
 * chunk; `delete` and its idempotence; namespace isolation, including the
 * `_default` namespace of an unnamespaced datastore; `list` reporting
 * exactly the stored chunks; that `put` copies its input; `touch` returning
 * the hashes it did not find; that `touch` and `put` refresh
 * `lastModified` (when `setLastModified` is given); concurrent puts of one
 * hash leaving one complete chunk; visibility of one handle's writes to
 * another; and every method rejecting on an aborted signal.
 *
 * A storage that cannot offer `list`, `delete` or more than one namespace
 * says so in `options.unsupported`, with the reason: those checks are then
 * skipped, and an unsupported method must reject. `has`, `get`, `put`,
 * copying, concurrency and visibility are always checked.
 *
 * ```ts
 * import { assertStorageConformance } from "@swamp-club/swamp-testing";
 *
 * Deno.test("storage conformance", async () => {
 *   await assertStorageConformance(() => createProvider(config).storage!());
 * });
 * ```
 */
export async function assertStorageConformance(
  openStorage: () => DatastoreStorage | Promise<DatastoreStorage>,
  options: StorageConformanceOptions = {},
): Promise<void> {
  const unsupported = options.unsupported ?? {};
  for (const [part, reason] of Object.entries(unsupported)) {
    if (reason === undefined) continue;
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new Error(
        `unsupported.${part} must give the reason the storage cannot offer it`,
      );
    }
  }
  if (unsupported.namespaces !== undefined && options.namespace === undefined) {
    throw new Error(
      "a storage that serves one namespace (unsupported.namespaces) must " +
        "name it in options.namespace",
    );
  }
  const canList = unsupported.list === undefined;
  const canDelete = unsupported.delete === undefined;
  const canNamespace = unsupported.namespaces === undefined;
  const storage = await openStorage();
  const other = await openStorage();
  const signal = new AbortController().signal;
  const suffix = crypto.randomUUID().slice(0, 8);
  const ns = options.namespace ?? `conformance-${suffix}`;
  const otherNs = `conformance-${suffix}-other`;
  // In a namespace of the caller's, chunks of earlier runs may remain.
  const salt = options.namespace === undefined ? "" : ` ${suffix}`;
  const written: [string, string][] = [];
  const chunk = async (text: string) => {
    const bytes = encode(text + salt);
    return { bytes, sha256: await sha256Hex(bytes) };
  };
  const put = async (
    namespace: string,
    c: { bytes: Uint8Array; sha256: string },
  ) => {
    written.push([namespace, c.sha256]);
    await storage.put(namespace, c.sha256, c.bytes, signal);
  };

  try {
    // contract and capabilities
    assertEquals(storage.contract, "storage/1", "contract must be storage/1");
    const caps = storage.capabilities();
    assert(
      Number.isSafeInteger(caps.maxChunkBytes) && caps.maxChunkBytes > 0,
      "capabilities().maxChunkBytes must be a positive integer",
    );
    assertEquals(
      typeof storage.touch === "function",
      caps.touch,
      "touch must be implemented exactly when capabilities().touch is true",
    );

    // put, get and has
    const a = await chunk("chunk a");
    const b = await chunk("chunk b");
    const missing = await chunk("never stored");
    assertEquals(
      await storage.get(ns, a.sha256, signal),
      null,
      "get must return null for a chunk that is not stored",
    );
    await put(ns, a);
    assertEquals(
      await storage.get(ns, a.sha256, signal),
      a.bytes,
      "put then get",
    );
    assertEquals(
      await other.get(ns, a.sha256, signal),
      a.bytes,
      "a second handle must see the first handle's put at once",
    );
    await put(ns, b);
    assertEquals(
      await storage.has(ns, [a.sha256, missing.sha256, b.sha256], signal),
      new Set([a.sha256, b.sha256]),
      "has must return exactly the stored hashes of the batch",
    );
    assertEquals(
      await storage.has(ns, [], signal),
      new Set(),
      "has of an empty batch must return an empty set",
    );

    // an empty chunk is a chunk
    const empty = {
      bytes: new Uint8Array(),
      sha256: await sha256Hex(new Uint8Array()),
    };
    await put(ns, empty);
    assertEquals(
      (await storage.get(ns, empty.sha256, signal))?.length,
      0,
      "an empty chunk must read back as empty, not as null",
    );

    // put copies its input
    const c = await chunk("chunk c");
    const input = c.bytes.slice();
    await put(ns, { bytes: input, sha256: c.sha256 });
    input.fill(0);
    assertEquals(
      await storage.get(ns, c.sha256, signal),
      c.bytes,
      "a chunk must not change when the caller later changes the bytes it put",
    );

    // re-put leaves one chunk
    await put(ns, a);
    assertEquals(await storage.get(ns, a.sha256, signal), a.bytes);
    if (canList) {
      const listed = await listAll(storage, ns);
      assertEquals(
        listed.map((s) => s.sha256).sort(),
        [a.sha256, b.sha256, c.sha256, empty.sha256].sort(),
        "list must report each stored chunk once, and nothing else",
      );
      for (const entry of listed) {
        assert(
          entry.lastModified instanceof Date &&
            !Number.isNaN(entry.lastModified.getTime()),
          "list must give each chunk a valid lastModified Date",
        );
      }
    } else {
      await assertRejects(
        () => listAll(storage, ns),
        `list is declared unsupported (${unsupported.list}), so it must reject`,
      );
    }

    // namespace isolation
    if (canNamespace) {
      assertEquals(
        await storage.get(otherNs, a.sha256, signal),
        null,
        "a chunk must not be readable from another namespace",
      );
      assertEquals(await storage.has(otherNs, [a.sha256], signal), new Set());
      if (canList) assertEquals(await listAll(storage, otherNs), []);
      const d = await chunk("chunk d, only in the other namespace");
      await put(otherNs, d);
      if (canList) {
        assertEquals(
          (await listAll(storage, otherNs)).map((s) => s.sha256),
          [d.sha256],
          "list must report only the chunks of its own namespace",
        );
        assert(
          !(await listAll(storage, ns)).some((s) => s.sha256 === d.sha256),
          "list must not report another namespace's chunks",
        );
      } else {
        // Without list, the other direction is checked by reading.
        assertEquals(
          await storage.get(ns, d.sha256, signal),
          null,
          "a chunk must not be readable from another namespace",
        );
      }
      if (canDelete) {
        await put(otherNs, a);
        await storage.delete(otherNs, a.sha256, signal);
        assertEquals(
          await storage.get(ns, a.sha256, signal),
          a.bytes,
          "deleting a chunk in one namespace must not delete it in another",
        );
      }

      // the unnamespaced datastore's namespace, `_default`, works like any
      // other; the chunk's content is unique to this run, so no real chunk
      // is touched
      const unnamespaced = await chunk(`unnamespaced ${crypto.randomUUID()}`);
      await put("_default", unnamespaced);
      assertEquals(
        await storage.get("_default", unnamespaced.sha256, signal),
        unnamespaced.bytes,
        "the _default namespace (an unnamespaced datastore) must store chunks",
      );
      if (canList) {
        assert(
          !(await listAll(storage, ns)).some((s) =>
            s.sha256 === unnamespaced.sha256
          ),
          "_default must be a namespace of its own",
        );
      }
      if (canDelete) {
        await storage.delete("_default", unnamespaced.sha256, signal);
      }
    }

    // touch
    if (storage.touch !== undefined) {
      assertEquals(
        await storage.touch(ns, [a.sha256, missing.sha256], signal),
        new Set([missing.sha256]),
        "touch must return exactly the hashes it did not find",
      );
      assertEquals(
        await storage.get(ns, missing.sha256, signal),
        null,
        "touch must not create a chunk",
      );
    }

    // touch and put refresh lastModified, as list reports it
    if (options.setLastModified !== undefined && canList) {
      const longAgo = new Date("2000-01-01T00:00:00Z");
      const lastModified = async (sha256: string) =>
        (await listAll(storage, ns)).find((s) => s.sha256 === sha256)
          ?.lastModified.getTime() ?? 0;
      await options.setLastModified(ns, a.sha256, longAgo);
      assertEquals(
        await lastModified(a.sha256),
        longAgo.getTime(),
        "setLastModified must set what list reports",
      );
      if (storage.touch !== undefined) {
        await storage.touch(ns, [a.sha256], signal);
        assert(
          (await lastModified(a.sha256)) > longAgo.getTime(),
          "touch must refresh lastModified",
        );
        await options.setLastModified(ns, a.sha256, longAgo);
      }
      await storage.put(ns, a.sha256, a.bytes, signal);
      assert(
        (await lastModified(a.sha256)) > longAgo.getTime(),
        "put of a stored chunk must refresh lastModified",
      );
    }

    // concurrent puts of one hash
    // Large enough to race, within the storage's own chunk limit.
    const racedText = "r".repeat(
      Math.max(0, Math.min(256 * 1024, caps.maxChunkBytes) - salt.length),
    );
    const raced = await chunk(racedText);
    written.push([ns, raced.sha256]);
    await Promise.all(
      Array.from(
        { length: options.concurrency ?? 8 },
        (_, i) =>
          (i % 2 === 0 ? storage : other).put(
            ns,
            raced.sha256,
            raced.bytes,
            signal,
          ),
      ),
    );
    assertEquals(
      await storage.get(ns, raced.sha256, signal),
      raced.bytes,
      "concurrent puts of one hash must leave one complete chunk",
    );
    if (canList) {
      assertEquals(
        (await listAll(storage, ns)).filter((s) => s.sha256 === raced.sha256)
          .length,
        1,
      );
    }

    // delete and its idempotence
    if (canDelete) {
      await storage.delete(ns, b.sha256, signal);
      assertEquals(
        await storage.get(ns, b.sha256, signal),
        null,
        "delete then get",
      );
      assertEquals(await storage.has(ns, [b.sha256], signal), new Set());
      await storage.delete(ns, b.sha256, signal);
      await storage.delete(ns, missing.sha256, signal);
      if (canList) {
        assert(
          !(await listAll(storage, ns)).some((s) => s.sha256 === b.sha256),
          "a deleted chunk must not be listed",
        );
      }
    } else {
      await assertRejects(
        () => storage.delete(ns, b.sha256, signal),
        `delete is declared unsupported (${unsupported.delete}), so it must reject`,
      );
      assertEquals(
        await storage.get(ns, b.sha256, signal),
        b.bytes,
        "a refused delete must leave the chunk",
      );
    }

    // an aborted signal
    const aborted = AbortSignal.abort(new Error("conformance abort"));
    const calls: [string, () => Promise<unknown>][] = [
      ["has", () => storage.has(ns, [a.sha256], aborted)],
      ["put", () => storage.put(ns, missing.sha256, missing.bytes, aborted)],
      ["get", () => storage.get(ns, a.sha256, aborted)],
      ["list", () => Array.fromAsync(storage.list(ns, aborted))],
      ["delete", () => storage.delete(ns, a.sha256, aborted)],
    ];
    if (storage.touch !== undefined) {
      const touch = storage.touch.bind(storage);
      calls.push(["touch", () => touch(ns, [a.sha256], aborted)]);
    }
    for (const [name, call] of calls) {
      await assertRejects(
        call,
        `${name} must reject when its signal has aborted`,
      );
    }
    assertEquals(
      await storage.get(ns, a.sha256, signal),
      a.bytes,
      "an aborted delete must leave the chunk",
    );
    assertEquals(
      await storage.get(ns, missing.sha256, signal),
      null,
      "an aborted put must store nothing",
    );
  } finally {
    // A storage that cannot delete keeps what the suite wrote.
    for (const [namespace, sha256] of canDelete ? written : []) {
      try {
        await storage.delete(namespace, sha256, signal);
      } catch { /* best-effort cleanup */ }
    }
  }
}
