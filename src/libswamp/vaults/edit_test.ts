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

import { assertEquals } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import { vaultEdit, type VaultEditDeps, type VaultEditEvent } from "./edit.ts";

function makeDeps(overrides: Partial<VaultEditDeps> = {}): VaultEditDeps {
  return {
    findByName: () => Promise.resolve(null),
    findById: () => Promise.resolve(null),
    findAll: () => Promise.resolve([]),
    getVaultPath: () => "/fake/path/vault.yaml",
    fileExists: () => Promise.resolve(true),
    openEditor: () => Promise.resolve({ editor: "VS Code" }),
    ...overrides,
  };
}

const testVaultConfig = {
  id: "vault-1",
  name: "my-vault",
  type: "env",
};

Deno.test("vaultEdit: yields error when vault not found", async () => {
  const deps = makeDeps();

  const events = await collect<VaultEditEvent>(
    vaultEdit(createLibSwampContext(), deps, {
      vaultNameOrId: "missing-vault",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const last = events[1] as Extract<VaultEditEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});

Deno.test("vaultEdit: opens editor when vault found by name", async () => {
  const deps = makeDeps({
    findByName: () => Promise.resolve(testVaultConfig),
    getVaultPath: () => "/repo/.swamp/vault/env/vault-1.yaml",
    openEditor: () => Promise.resolve({ editor: "Neovim" }),
  });

  const events = await collect<VaultEditEvent>(
    vaultEdit(createLibSwampContext(), deps, {
      vaultNameOrId: "my-vault",
    }),
  );

  assertEquals(events, [
    { kind: "resolving" },
    {
      kind: "completed",
      data: {
        path: "/repo/.swamp/vault/env/vault-1.yaml",
        editor: "Neovim",
        status: "opened",
        name: "my-vault",
        type: "env",
      },
    },
  ]);
});

Deno.test("vaultEdit: finds vault by ID when name lookup fails", async () => {
  const deps = makeDeps({
    findByName: () => Promise.resolve(null),
    findAll: () => Promise.resolve([testVaultConfig]),
    getVaultPath: () => "/repo/.swamp/vault/env/vault-1.yaml",
    openEditor: () => Promise.resolve({ editor: "VS Code" }),
  });

  const events = await collect<VaultEditEvent>(
    vaultEdit(createLibSwampContext(), deps, {
      vaultNameOrId: "vault-1",
    }),
  );

  const completed = events[1] as Extract<
    VaultEditEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.name, "my-vault");
});

Deno.test("vaultEdit: finds vault by ID with type hint", async () => {
  const deps = makeDeps({
    findByName: () => Promise.resolve(null),
    findById: (type, id) => {
      if (type === "env" && id === "vault-1") {
        return Promise.resolve(testVaultConfig);
      }
      return Promise.resolve(null);
    },
    getVaultPath: () => "/repo/.swamp/vault/env/vault-1.yaml",
    openEditor: () => Promise.resolve({ editor: "VS Code" }),
  });

  const events = await collect<VaultEditEvent>(
    vaultEdit(createLibSwampContext(), deps, {
      vaultNameOrId: "vault-1",
      vaultType: "env",
    }),
  );

  const completed = events[1] as Extract<
    VaultEditEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.name, "my-vault");
});

Deno.test("vaultEdit: yields error when vault type mismatch", async () => {
  const deps = makeDeps({
    findByName: () => Promise.resolve(testVaultConfig),
  });

  const events = await collect<VaultEditEvent>(
    vaultEdit(createLibSwampContext(), deps, {
      vaultNameOrId: "my-vault",
      vaultType: "aws-secrets-manager",
    }),
  );

  const last = events[1] as Extract<VaultEditEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("vaultEdit: yields error when vault file not found", async () => {
  const deps = makeDeps({
    findByName: () => Promise.resolve(testVaultConfig),
    getVaultPath: () => "/repo/.swamp/vault/env/vault-1.yaml",
    fileExists: () => Promise.resolve(false),
  });

  const events = await collect<VaultEditEvent>(
    vaultEdit(createLibSwampContext(), deps, {
      vaultNameOrId: "my-vault",
    }),
  );

  const last = events[1] as Extract<VaultEditEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});
