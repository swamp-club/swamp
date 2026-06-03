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

import { assertEquals, assertStringIncludes, unreachable } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import { VaultConfig } from "../../domain/vaults/vault_config.ts";
import { MockVaultProvider } from "../../domain/vaults/mock_vault_provider.ts";
import {
  vaultMigrate,
  type VaultMigrateDeps,
  type VaultMigrateEvent,
  vaultMigratePreview,
} from "./migrate.ts";

const SOURCE_CONFIG = VaultConfig.create(
  "vault-1",
  "my-vault",
  "mock",
  {},
);

function makeDeps(
  overrides: Partial<VaultMigrateDeps> = {},
): VaultMigrateDeps {
  const targetSecrets = new Map<string, string>();
  return {
    findVaultConfig: () => Promise.resolve(SOURCE_CONFIG),
    resolveExtensionVaultType: () => Promise.resolve(),
    getVaultTypeInfo: (type) => {
      if (type === "mock" || type === "local_encryption") {
        return {
          type,
          name: type === "mock" ? "Mock" : "Local Encryption",
          description: `${type} vault`,
          isBuiltIn: true,
        };
      }
      return undefined;
    },
    createProvider: (_type, name) =>
      new MockVaultProvider(name, Object.fromEntries(targetSecrets)),
    loadSourceVaultService: async () => {
      // Create a minimal vault service with the source provider
      const { VaultService } = await import(
        "../../domain/vaults/vault_service.ts"
      );
      const svc = new VaultService();
      svc.registerVault({
        name: "my-vault",
        type: "mock",
        config: {},
      });
      return svc;
    },
    saveConfig: () => Promise.resolve(),
    deleteConfig: () => Promise.resolve(),
    listAvailableTypes: () => ["mock", "local_encryption"],
    ...overrides,
  };
}

Deno.test("vaultMigratePreview: returns preview with secret count", async () => {
  const deps = makeDeps();
  const preview = await vaultMigratePreview(
    createLibSwampContext(),
    deps,
    {
      vaultName: "my-vault",
      targetType: "local_encryption",
      repoDir: "/tmp",
    },
  );

  assertEquals(preview.vaultName, "my-vault");
  assertEquals(preview.currentType, "mock");
  assertEquals(preview.targetType, "local_encryption");
  // MockVaultProvider has default secrets
  assertEquals(typeof preview.secretCount, "number");
});

Deno.test("vaultMigratePreview: throws not_found for missing vault", async () => {
  const deps = makeDeps({
    findVaultConfig: () => Promise.resolve(null),
  });

  try {
    await vaultMigratePreview(
      createLibSwampContext(),
      deps,
      {
        vaultName: "missing",
        targetType: "local_encryption",
        repoDir: "/tmp",
      },
    );
    unreachable();
  } catch (err) {
    assertEquals((err as { code: string }).code, "not_found");
  }
});

Deno.test("vaultMigratePreview: rejects same-type migration", async () => {
  const deps = makeDeps();

  try {
    await vaultMigratePreview(
      createLibSwampContext(),
      deps,
      {
        vaultName: "my-vault",
        targetType: "mock",
        repoDir: "/tmp",
      },
    );
    unreachable();
  } catch (err) {
    assertEquals((err as { code: string }).code, "validation_failed");
    assertStringIncludes(
      (err as { message: string }).message,
      "Cannot migrate to the same type",
    );
  }
});

Deno.test("vaultMigratePreview: rejects unknown target type", async () => {
  const deps = makeDeps({
    getVaultTypeInfo: () => undefined,
  });

  try {
    await vaultMigratePreview(
      createLibSwampContext(),
      deps,
      {
        vaultName: "my-vault",
        targetType: "nonexistent",
        repoDir: "/tmp",
      },
    );
    unreachable();
  } catch (err) {
    assertEquals((err as { code: string }).code, "validation_failed");
    assertStringIncludes(
      (err as { message: string }).message,
      "Unknown vault type",
    );
  }
});

Deno.test("vaultMigrate: copies secrets and updates config", async () => {
  const copiedSecrets = new Map<string, string>();
  let savedConfig: VaultConfig | null = null;
  let deletedConfig: VaultConfig | null = null;

  const deps = makeDeps({
    createProvider: (_type, name) => {
      return {
        get: (key: string) => {
          const val = copiedSecrets.get(key);
          if (!val) throw new Error(`Not found: ${key}`);
          return Promise.resolve(val);
        },
        put: (key: string, value: string) => {
          copiedSecrets.set(key, value);
          return Promise.resolve();
        },
        list: () => Promise.resolve(Array.from(copiedSecrets.keys())),
        getName: () => name,
      };
    },
    saveConfig: (config) => {
      savedConfig = config;
      return Promise.resolve();
    },
    deleteConfig: (config) => {
      deletedConfig = config;
      return Promise.resolve();
    },
  });

  const events = await collect<VaultMigrateEvent>(
    vaultMigrate(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      targetType: "local_encryption",
      repoDir: "/tmp",
    }),
  );

  // Should have copying events, updating_config, and completed
  const kinds = events.map((e) => e.kind);
  assertEquals(kinds.includes("updating_config"), true);
  assertEquals(kinds[kinds.length - 1], "completed");

  // Secrets should have been copied
  assertEquals(copiedSecrets.size > 0, true);

  // Config should have been saved with new type
  assertEquals(savedConfig!.type, "local_encryption");
  assertEquals(savedConfig!.name, "my-vault");

  // Old config should have been deleted
  assertEquals(deletedConfig!.type, "mock");
});

Deno.test("vaultMigrate: yields error when vault not found", async () => {
  const deps = makeDeps({
    findVaultConfig: () => Promise.resolve(null),
  });

  const events = await collect<VaultMigrateEvent>(
    vaultMigrate(createLibSwampContext(), deps, {
      vaultName: "missing",
      targetType: "local_encryption",
      repoDir: "/tmp",
    }),
  );

  const last = events[events.length - 1] as Extract<
    VaultMigrateEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});

Deno.test("vaultMigrate: yields error when target type unknown", async () => {
  const deps = makeDeps({
    getVaultTypeInfo: () => undefined,
  });

  const events = await collect<VaultMigrateEvent>(
    vaultMigrate(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      targetType: "nonexistent",
      repoDir: "/tmp",
    }),
  );

  const last = events[events.length - 1] as Extract<
    VaultMigrateEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
});

Deno.test("vaultMigrate: handles empty vault with zero secrets", async () => {
  let savedConfig: VaultConfig | null = null;

  const emptyProvider = {
    get: (_key: string): Promise<string> => {
      throw new Error("No secrets");
    },
    put: (_key: string, _value: string) => Promise.resolve(),
    list: () => Promise.resolve([] as string[]),
    getName: () => "empty-vault",
  };

  const deps = makeDeps({
    loadSourceVaultService: () => {
      return Promise.resolve(
        {
          get: () => {
            throw new Error("No secrets");
          },
          put: () => Promise.resolve(),
          list: () => Promise.resolve([]),
          getVaultNames: () => ["empty-vault"],
        } as unknown as import("../../domain/vaults/vault_service.ts").VaultService,
      );
    },
    createProvider: () => emptyProvider,
    findVaultConfig: () =>
      Promise.resolve(
        VaultConfig.create("vault-empty", "empty-vault", "mock", {}),
      ),
    saveConfig: (config) => {
      savedConfig = config;
      return Promise.resolve();
    },
  });

  const events = await collect<VaultMigrateEvent>(
    vaultMigrate(createLibSwampContext(), deps, {
      vaultName: "empty-vault",
      targetType: "local_encryption",
      repoDir: "/tmp",
    }),
  );

  const completed = events[events.length - 1] as Extract<
    VaultMigrateEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.secretsMigrated, 0);

  // Config should still be updated even with zero secrets
  assertEquals(savedConfig!.type, "local_encryption");
});

Deno.test("vaultMigrate: tolerates delete failure", async () => {
  const deps = makeDeps({
    deleteConfig: () => {
      throw new Error("Permission denied");
    },
  });

  const events = await collect<VaultMigrateEvent>(
    vaultMigrate(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      targetType: "local_encryption",
      repoDir: "/tmp",
    }),
  );

  // Should still complete despite delete failure
  const last = events[events.length - 1];
  assertEquals(last.kind, "completed");
});

Deno.test("vaultMigrate: case-insensitive target type resolves correct config", async () => {
  let savedConfig: VaultConfig | null = null;
  let createdProviderConfig: Record<string, unknown> | undefined;

  const deps = makeDeps({
    getVaultTypeInfo: (type) => {
      if (
        type.toLowerCase() === "mock" ||
        type.toLowerCase() === "local_encryption"
      ) {
        return {
          type,
          name: type.toLowerCase() === "mock" ? "Mock" : "Local Encryption",
          description: `${type} vault`,
          isBuiltIn: true,
        };
      }
      return undefined;
    },
    createProvider: (_type, name, config) => {
      createdProviderConfig = config as Record<string, unknown>;
      return new MockVaultProvider(name);
    },
    saveConfig: (config) => {
      savedConfig = config;
      return Promise.resolve();
    },
  });

  const events = await collect<VaultMigrateEvent>(
    vaultMigrate(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      targetType: "Local_Encryption",
      repoDir: "/tmp/test-repo",
    }),
  );

  const last = events[events.length - 1];
  assertEquals(last.kind, "completed");
  assertEquals(savedConfig!.type, "Local_Encryption");
  // The key assertion: config should have auto_generate and base_dir,
  // not an empty object from the default branch
  assertEquals(createdProviderConfig?.auto_generate, true);
  assertEquals(createdProviderConfig?.base_dir, "/tmp/test-repo");
});

Deno.test("vaultMigrate: rejects same-type migration", async () => {
  let deleteCalled = false;
  const deps = makeDeps({
    deleteConfig: () => {
      deleteCalled = true;
      return Promise.resolve();
    },
  });

  const events = await collect<VaultMigrateEvent>(
    vaultMigrate(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      targetType: "mock", // same as source type
      repoDir: "/tmp",
    }),
  );

  const last = events[events.length - 1] as Extract<
    VaultMigrateEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
  assertStringIncludes(last.error.message, "Cannot migrate to the same type");
  // Config must NOT be deleted — that would destroy the vault
  assertEquals(deleteCalled, false);
});

Deno.test("vaultMigrate: yields error event on secret copy failure", async () => {
  let copyCount = 0;
  const deps = makeDeps({
    createProvider: (_type, name) => ({
      get: () => Promise.reject(new Error("Not found")),
      put: (_key: string, _value: string) => {
        copyCount++;
        if (copyCount >= 2) {
          return Promise.reject(new Error("Network timeout"));
        }
        return Promise.resolve();
      },
      list: () => Promise.resolve([]),
      getName: () => name,
    }),
  });

  const events = await collect<VaultMigrateEvent>(
    vaultMigrate(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      targetType: "local_encryption",
      repoDir: "/tmp",
    }),
  );

  const last = events[events.length - 1] as Extract<
    VaultMigrateEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertStringIncludes(last.error.message, "Network timeout");
});
