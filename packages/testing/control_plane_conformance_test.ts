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
import { assertRejects } from "jsr:@std/assert@1.0.19";
import {
  assertControlPlaneStoreConformance,
  createInMemoryControlPlaneStore,
} from "./control_plane_conformance.ts";
import type { ControlPlaneStore } from "./datastore_types.ts";

Deno.test("assertControlPlaneStoreConformance: the in-memory store conforms and is left empty", async () => {
  const store = createInMemoryControlPlaneStore();

  await assertControlPlaneStoreConformance(() => store);

  if ((await store.list("")).length !== 0) {
    throw new Error("the suite left records behind");
  }
});

Deno.test("assertControlPlaneStoreConformance: a store without putIfAbsent fails unless it is declared so", async () => {
  const { putIfAbsent: _dropped, ...partial } =
    createInMemoryControlPlaneStore();
  const store: ControlPlaneStore = partial;

  await assertRejects(
    () => assertControlPlaneStoreConformance(() => store),
    Error,
    "must implement putIfAbsent",
  );
  await assertControlPlaneStoreConformance(() => store, {
    requirePutIfAbsent: false,
  });
});

Deno.test("assertControlPlaneStoreConformance: catches a create that overwrites", async () => {
  const store = createInMemoryControlPlaneStore();
  const overwriting: ControlPlaneStore = {
    ...store,
    putIfAbsent: async (key, data) => {
      await store.put(key, data);
      return true;
    },
  };

  await assertRejects(
    () => assertControlPlaneStoreConformance(() => overwriting),
    Error,
    "must return false",
  );
});

Deno.test("assertControlPlaneStoreConformance: catches a create that checks and writes in two steps", async () => {
  const store = createInMemoryControlPlaneStore();
  // Reads, yields, then writes: every racer sees the key as free.
  const racy: ControlPlaneStore = {
    ...store,
    putIfAbsent: async (key, data) => {
      if (await store.get(key) !== null) return false;
      await Promise.resolve();
      await store.put(key, data);
      return true;
    },
  };

  await assertRejects(
    () => assertControlPlaneStoreConformance(() => racy),
    Error,
    "exactly one must return true",
  );
});

Deno.test("assertControlPlaneStoreConformance: catches handles that do not share their records", async () => {
  await assertRejects(
    () =>
      assertControlPlaneStoreConformance(() =>
        createInMemoryControlPlaneStore()
      ),
    Error,
    "a second handle must see",
  );
});

Deno.test("assertControlPlaneStoreConformance: catches a list that matches by name prefix instead of by path", async () => {
  const store = createInMemoryControlPlaneStore();
  const loose: ControlPlaneStore = {
    ...store,
    list: (prefix) => store.list(prefix.replace(/\/$/, "")),
  };

  await assertRejects(
    () => assertControlPlaneStoreConformance(() => loose),
    Error,
    "list must return every key under the prefix",
  );
});
