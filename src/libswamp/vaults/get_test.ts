// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  createVaultGetDeps,
  type VaultConfigInfo,
  vaultGet,
  type VaultGetDeps,
  type VaultGetEvent,
} from "./get.ts";

const testCreatedAt = new Date("2026-01-01T00:00:00.000Z");

const testVault: VaultConfigInfo = {
  id: "vault-1",
  name: "my-vault",
  type: "file",
  config: { path: "/vaults/my-vault" },
  createdAt: testCreatedAt,
};

function makeDeps(overrides: {
  byName?: VaultConfigInfo | null;
  byId?: VaultConfigInfo | null;
  all?: VaultConfigInfo[];
  storagePath?: string;
}): VaultGetDeps {
  return {
    findByName: () => Promise.resolve(overrides.byName ?? null),
    findById: () => Promise.resolve(overrides.byId ?? null),
    findAll: () => Promise.resolve(overrides.all ?? []),
    storagePath: () => overrides.storagePath ?? "/vaults/my-vault",
  };
}

Deno.test("vaultGet yields resolving -> completed when found by name", async () => {
  const deps = makeDeps({
    byName: testVault,
    storagePath: "/vaults/my-vault",
  });

  const events = await collect<VaultGetEvent>(
    vaultGet(createLibSwampContext(), deps, "my-vault"),
  );

  assertEquals(events, [
    { kind: "resolving" },
    {
      kind: "completed",
      data: {
        id: "vault-1",
        name: "my-vault",
        type: "file",
        config: { path: "/vaults/my-vault" },
        createdAt: testCreatedAt.toISOString(),
        storagePath: "/vaults/my-vault",
      },
    },
  ]);
});

Deno.test("vaultGet yields completed when not found by name but found by scanning all", async () => {
  const deps = makeDeps({
    byName: null,
    all: [testVault],
    storagePath: "/vaults/my-vault",
  });

  const events = await collect<VaultGetEvent>(
    vaultGet(createLibSwampContext(), deps, "vault-1"),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<VaultGetEvent, { kind: "completed" }>;
  assertEquals(last.kind, "completed");
  assertEquals(last.data.id, "vault-1");
});

Deno.test("vaultGet yields resolving -> error with not_found when vault does not exist", async () => {
  const deps = makeDeps({ byName: null, all: [] });

  const events = await collect<VaultGetEvent>(
    vaultGet(createLibSwampContext(), deps, "missing-vault"),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<VaultGetEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});

Deno.test("vaultGet yields error with validation_failed when vault type does not match", async () => {
  const deps = makeDeps({ byName: testVault });

  const events = await collect<VaultGetEvent>(
    vaultGet(createLibSwampContext(), deps, "my-vault", "s3"),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<VaultGetEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("createVaultGetDeps: storagePath uses vaults/ not .swamp/vault/", () => {
  const deps = createVaultGetDeps("/tmp/fake-repo");
  const config: VaultConfigInfo = {
    id: "abc-123",
    name: "test-vault",
    type: "local_encryption",
    config: {},
    createdAt: new Date(),
  };
  assertEquals(
    deps.storagePath(config),
    "vaults/local_encryption/abc-123.yaml",
  );
});
