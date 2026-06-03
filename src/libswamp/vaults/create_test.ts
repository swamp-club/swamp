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
import {
  vaultCreate,
  type VaultCreateDeps,
  type VaultCreateEvent,
} from "./create.ts";

function makeDeps(overrides: Partial<VaultCreateDeps> = {}): VaultCreateDeps {
  return {
    resolveExtensionVaultType: () => Promise.resolve(),
    getVaultTypeInfo: () =>
      ({
        type: "local_encryption",
        name: "Local Encryption",
        isBuiltIn: true,
      }) as unknown as ReturnType<VaultCreateDeps["getVaultTypeInfo"]>,
    findByName: () => Promise.resolve(false),
    save: () => Promise.resolve(),
    listAvailableTypes: () => ["local_encryption", "aws_secrets_manager"],
    ...overrides,
  };
}

Deno.test("vaultCreate: yields completed on successful creation", async () => {
  const deps = makeDeps();

  const events = await collect<VaultCreateEvent>(
    vaultCreate(createLibSwampContext(), deps, {
      vaultType: "local_encryption",
      name: "my-vault",
      repoDir: "/repo",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "creating" });
  const completed = events[1] as Extract<
    VaultCreateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.name, "my-vault");
  assertEquals(completed.data.type, "local_encryption");
  assertEquals(completed.data.typeName, "Local Encryption");
});

Deno.test("vaultCreate: yields error for unknown vault type", async () => {
  const deps = makeDeps({
    getVaultTypeInfo: () => undefined,
  });

  const events = await collect<VaultCreateEvent>(
    vaultCreate(createLibSwampContext(), deps, {
      vaultType: "unknown_type",
      name: "my-vault",
      repoDir: "/repo",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "creating" });
  const last = events[1] as Extract<VaultCreateEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("vaultCreate: yields error when name already exists", async () => {
  const deps = makeDeps({
    findByName: () => Promise.resolve(true),
  });

  const events = await collect<VaultCreateEvent>(
    vaultCreate(createLibSwampContext(), deps, {
      vaultType: "local_encryption",
      name: "existing-vault",
      repoDir: "/repo",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "creating" });
  const last = events[1] as Extract<VaultCreateEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "already_exists");
});

Deno.test("vaultCreate: yields error for invalid vault name", async () => {
  const deps = makeDeps();

  const events = await collect<VaultCreateEvent>(
    vaultCreate(createLibSwampContext(), deps, {
      vaultType: "local_encryption",
      name: "Invalid-Name!",
      repoDir: "/repo",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "creating" });
  const last = events[1] as Extract<VaultCreateEvent, { kind: "error" }>;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});
