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

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  unreachable,
} from "@std/assert";
import { join } from "@std/path";
import { z } from "zod";
import type { VaultConfigField } from "../../domain/vaults/vault_config_fields.ts";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import { VaultConfig } from "../../domain/vaults/vault_config.ts";
import { MockVaultProvider } from "../../domain/vaults/mock_vault_provider.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import {
  createVaultMigrateDeps,
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
    isVaultTypeLoaded: () => Promise.resolve(true),
    findRegistryConfigFields: () => Promise.resolve(null),
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

// Key-source rule for local_encryption targets (swamp-club#2690).

Deno.test("vaultMigrate: an untrusted local_encryption target cannot name its own key source", async () => {
  for (
    const targetConfig of [
      { base_dir: "/elsewhere" },
      { key_file: "/k" },
      { ssh_key_path: "~/.ssh/id_ed25519" },
      { auto_generate: false },
    ]
  ) {
    const field = Object.keys(targetConfig)[0];
    const providers: string[] = [];
    const saved: VaultConfig[] = [];
    const deps = makeDeps({
      // The real registry resolves types case-insensitively.
      getVaultTypeInfo: (type) =>
        type.toLowerCase() === "local_encryption"
          ? {
            type,
            name: "Local Encryption",
            description: "local_encryption vault",
            isBuiltIn: true,
          }
          : undefined,
      createProvider: (_type, name) => {
        providers.push(name);
        return new MockVaultProvider(name);
      },
      saveConfig: (config) => {
        saved.push(config);
        return Promise.resolve();
      },
    });
    const input = {
      vaultName: "my-vault",
      targetType: "LOCAL_ENCRYPTION",
      targetConfig,
      repoDir: "/repo",
    };

    const previewError = await assertRejects(() =>
      vaultMigratePreview(createLibSwampContext(), deps, input)
    ) as { code: string; message: string };
    assertEquals(previewError.code, "validation_failed", field);
    assertStringIncludes(previewError.message, `Cannot set ${field}`);
    assertEquals(previewError.message.includes("/"), false, field);

    const error = await assertRejects(() =>
      collect<VaultMigrateEvent>(
        vaultMigrate(createLibSwampContext(), deps, input),
      )
    ) as { code: string };
    assertEquals(error.code, "validation_failed", field);
    assertEquals(providers, [], field);
    assertEquals(saved, [], field);
  }
});

Deno.test("vaultMigrate: an untrusted local_encryption target gets the server's key source", async () => {
  let createdProviderConfig: Record<string, unknown> | undefined;
  let savedConfig: VaultConfig | null = null;
  const deps = makeDeps({
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
      targetType: "local_encryption",
      targetConfig: {},
      repoDir: "/repo",
    }),
  );

  assertEquals(events[events.length - 1].kind, "completed");
  const expected = { auto_generate: true, base_dir: "/repo" };
  assertEquals(createdProviderConfig, expected);
  assertEquals(savedConfig!.config, expected);
});

Deno.test("vaultMigrate: a trusted local_encryption target may name its own key source", async () => {
  let savedConfig: VaultConfig | null = null;
  const deps = makeDeps({
    saveConfig: (config) => {
      savedConfig = config;
      return Promise.resolve();
    },
  });

  const events = await collect<VaultMigrateEvent>(
    vaultMigrate(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      targetType: "local_encryption",
      targetConfig: { key_file: "/k", auto_generate: true },
      repoDir: "/repo",
      trustKeySource: true,
    }),
  );

  assertEquals(events[events.length - 1].kind, "completed");
  assertEquals(savedConfig!.config, { key_file: "/k", auto_generate: true });
});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir({
    prefix: "swamp-vault-migrate-test-",
  });
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

Deno.test("createVaultMigrateDeps: reads, saves and deletes configs through an injected repository", async () => {
  await withTempDir(async (dir) => {
    const injected = new YamlVaultConfigRepository(
      dir,
      undefined,
      join(dir, "injected"),
    );
    await injected.save(SOURCE_CONFIG);
    const deps = await createVaultMigrateDeps(dir, { repo: injected });
    const target = VaultConfig.create(
      SOURCE_CONFIG.id,
      SOURCE_CONFIG.name,
      "local_encryption",
      {},
    );

    assertEquals((await deps.findVaultConfig("my-vault"))?.type, "mock");
    await deps.saveConfig(target);
    await deps.deleteConfig(SOURCE_CONFIG);

    assertEquals(
      (await injected.findById("local_encryption", "vault-1"))?.name,
      "my-vault",
    );
    assertEquals(await injected.findById("mock", "vault-1"), null);
    assertEquals(await new YamlVaultConfigRepository(dir).findAll(), []);
  });
});

Deno.test("createVaultMigrateDeps: without an injected repository, uses the vaultsDir option", async () => {
  await withTempDir(async (dir) => {
    const vaultsDir = join(dir, "options");
    const deps = await createVaultMigrateDeps(dir, { vaultsDir });

    await deps.saveConfig(SOURCE_CONFIG);

    const own = new YamlVaultConfigRepository(dir, undefined, vaultsDir);
    assertEquals((await own.findById("mock", "vault-1"))?.name, "my-vault");
    assertEquals(
      (await deps.findVaultConfig("my-vault"))?.id,
      SOURCE_CONFIG.id,
    );
  });
});

// ---------------------------------------------------------------------------
// Required config fields (swamp-club#3003)
// ---------------------------------------------------------------------------

const ONE_PASSWORD_SCHEMA = z.object({
  op_vault: z.string().min(1).describe("The 1Password vault to use"),
  op_account: z.string().optional().describe("Account shorthand or UUID"),
}).strict();

const ONE_PASSWORD_INFO = {
  type: "@swamp/1password",
  name: "1Password",
  description: "1Password vault provider",
  isBuiltIn: false,
  configSchema: ONE_PASSWORD_SCHEMA,
  createProvider: (name: string) => new MockVaultProvider(name),
};

const REGISTRY_FIELDS: VaultConfigField[] = [
  {
    name: "op_vault",
    type: "string",
    description: "The 1Password vault to use",
    required: true,
  },
  { name: "op_account", type: "string", required: false },
];

/** Deps for a 1Password target that is installed only once resolved. */
function makeOnePasswordDeps(
  options: {
    registryFields?: VaultConfigField[] | null;
    loaded?: boolean;
  } = {},
) {
  let loaded = options.loaded ?? false;
  const resolved: string[] = [];
  const deps = makeDeps({
    isVaultTypeLoaded: () => Promise.resolve(loaded),
    findRegistryConfigFields: () =>
      Promise.resolve(options.registryFields ?? null),
    resolveExtensionVaultType: (type) => {
      resolved.push(type);
      loaded = true;
      return Promise.resolve();
    },
    getVaultTypeInfo: (type) =>
      type === "@swamp/1password"
        ? ONE_PASSWORD_INFO
        : type === "mock"
        ? { type, name: "Mock", description: "mock vault", isBuiltIn: true }
        : undefined,
  });
  return { deps, resolved };
}

Deno.test("vaultMigratePreview: the registry's field list never refuses a config the installed schema accepts", async () => {
  // Published metadata that still calls a defaulted field required.
  const { deps, resolved } = makeOnePasswordDeps({
    registryFields: [
      { name: "op_vault", type: "string", required: true },
      { name: "op_account", type: "string", required: true },
    ],
  });

  const preview = await vaultMigratePreview(createLibSwampContext(), deps, {
    vaultName: "my-vault",
    targetType: "@swamp/1password",
    targetConfig: { op_vault: "Private" },
    repoDir: "/repo",
  });

  assertEquals(preview.targetTypeName, "1Password");
  assertEquals(resolved, ["@swamp/1password"]);
});

Deno.test("vaultMigrate: a missing required field is named by the installed schema, with the supplied config kept in the hint", async () => {
  const { deps, resolved } = makeOnePasswordDeps({
    registryFields: REGISTRY_FIELDS,
  });

  const error = await assertRejects(() =>
    collect<VaultMigrateEvent>(
      vaultMigrate(createLibSwampContext(), deps, {
        vaultName: "my-vault",
        targetType: "@swamp/1password",
        targetConfig: { op_account: "me" },
        repoDir: "/repo",
      }),
    )
  ) as { code: string; message: string };

  assertEquals(resolved, ["@swamp/1password"]);
  assertEquals(error.code, "validation_failed");
  assertEquals(
    error.message,
    "Invalid config for vault type '@swamp/1password': missing required field " +
      "'op_vault' (The 1Password vault to use). Re-run with: swamp vault migrate " +
      "my-vault --to-type @swamp/1password --config " +
      '\'{"op_account":"me","op_vault":"<op_vault>"}\'',
  );
});

Deno.test("vaultMigratePreview: a complete config installs the target type and passes its schema", async () => {
  const { deps, resolved } = makeOnePasswordDeps({
    registryFields: REGISTRY_FIELDS,
  });

  const preview = await vaultMigratePreview(createLibSwampContext(), deps, {
    vaultName: "my-vault",
    targetType: "@swamp/1password",
    targetConfig: { op_vault: "Private" },
    repoDir: "/repo",
  });

  assertEquals(preview.targetTypeName, "1Password");
  assertEquals(resolved, ["@swamp/1password"]);
});

Deno.test("vaultMigratePreview: without registry metadata the type is installed and its schema names the missing field", async () => {
  const { deps, resolved } = makeOnePasswordDeps({ registryFields: null });

  const error = await assertRejects(() =>
    vaultMigratePreview(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      targetType: "@swamp/1password",
      repoDir: "/repo",
    })
  ) as { code: string; message: string };

  assertEquals(resolved, ["@swamp/1password"]);
  assertEquals(error.code, "validation_failed");
  assertEquals(
    error.message,
    "Invalid config for vault type '@swamp/1password': missing required field " +
      "'op_vault' (The 1Password vault to use). Re-run with: swamp vault migrate " +
      'my-vault --to-type @swamp/1password --config \'{"op_vault":"<op_vault>"}\'',
  );
});

Deno.test("vaultMigratePreview: a loaded target type is checked against its schema, not the registry", async () => {
  let registryAsked = 0;
  const { deps } = makeOnePasswordDeps({ loaded: true });
  deps.findRegistryConfigFields = () => {
    registryAsked++;
    return Promise.resolve(REGISTRY_FIELDS);
  };

  const error = await assertRejects(() =>
    vaultMigratePreview(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      targetType: "@swamp/1password",
      targetConfig: { op_vault: "Private", vault: "typo" },
      repoDir: "/repo",
    })
  ) as { message: string };

  assertEquals(registryAsked, 0);
  assertStringIncludes(
    error.message,
    "unknown field 'vault'; accepted fields: op_vault, op_account",
  );
  assertStringIncludes(error.message, "Re-run with a corrected --config.");
});

Deno.test("vaultMigratePreview: the re-run hint stays pasteable when a supplied value has a single quote", async () => {
  const { deps } = makeOnePasswordDeps({ registryFields: null });

  const error = await assertRejects(() =>
    vaultMigratePreview(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      targetType: "@swamp/1password",
      targetConfig: { op_account: "o'brien" },
      repoDir: "/repo",
    })
  ) as { message: string };

  assertStringIncludes(
    error.message,
    `--config '{"op_account":"o'\\''brien","op_vault":"<op_vault>"}'`,
  );
});
