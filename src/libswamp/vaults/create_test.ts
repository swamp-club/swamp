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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  createVaultCreateDeps,
  vaultCreate,
  type VaultCreateDeps,
  type VaultCreateEvent,
} from "./create.ts";
import { VaultConfig } from "../../domain/vaults/vault_config.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";

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
  assertEquals(
    last.error.message,
    "Invalid vault name: Invalid-Name!. Vault names must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens.",
  );
});

// Key-source rule for local_encryption vaults (swamp-club#2690).

async function createLocal(
  vaultType: string,
  config: Record<string, unknown> | undefined,
  trustKeySource?: boolean,
): Promise<{ last: VaultCreateEvent; saved: VaultConfig[] }> {
  const saved: VaultConfig[] = [];
  const deps = makeDeps({
    save: (c) => {
      saved.push(c);
      return Promise.resolve();
    },
  });
  const events = await collect<VaultCreateEvent>(
    vaultCreate(createLibSwampContext(), deps, {
      vaultType,
      name: "my-vault",
      config,
      repoDir: "/repo",
      trustKeySource,
    }),
  );
  return { last: events[events.length - 1], saved };
}

Deno.test("vaultCreate: an untrusted local_encryption config cannot name its own key source", async () => {
  for (
    const config of [
      { base_dir: "/elsewhere" },
      { key_file: "/k" },
      { ssh_key_path: "~/.ssh/id_ed25519" },
      { auto_generate: false },
    ]
  ) {
    const field = Object.keys(config)[0];
    const { last, saved } = await createLocal("local_encryption", config);

    assertEquals(last.kind, "error", field);
    const error = (last as Extract<VaultCreateEvent, { kind: "error" }>).error;
    assertEquals(error.code, "validation_failed", field);
    assertStringIncludes(error.message, `Cannot set ${field} for vault`);
    assertEquals(error.message.includes("/"), false, field);
    assertEquals(saved, [], field);
  }
});

Deno.test("vaultCreate: an untrusted local_encryption config gets the server's key source", async () => {
  for (
    const config of [
      {},
      { base_dir: "/repo", auto_generate: true },
      { note: "kept" },
    ]
  ) {
    const { last, saved } = await createLocal("local_encryption", config);

    assertEquals(last.kind, "completed");
    assertEquals(saved[0].config, {
      ...config,
      auto_generate: true,
      base_dir: "/repo",
    });
  }
});

Deno.test("vaultCreate: the key-source rule matches the local_encryption type in any case", async () => {
  const refused = await createLocal("LOCAL_ENCRYPTION", { key_file: "/k" });
  assertEquals(refused.last.kind, "error");
  assertEquals(refused.saved, []);

  const defaulted = await createLocal("Local_Encryption", undefined);
  assertEquals(defaulted.saved[0].config, {
    auto_generate: true,
    base_dir: "/repo",
  });
});

Deno.test("vaultCreate: a trusted local_encryption config may name its own key source", async () => {
  const { last, saved } = await createLocal(
    "local_encryption",
    { ssh_key_path: "~/.ssh/id_ed25519" },
    true,
  );

  assertEquals(last.kind, "completed");
  assertEquals(saved[0].config, { ssh_key_path: "~/.ssh/id_ed25519" });
});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir({
    prefix: "swamp-vault-create-test-",
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

Deno.test("createVaultCreateDeps: saves through an injected repository", async () => {
  await withTempDir(async (dir) => {
    const injected = new YamlVaultConfigRepository(
      dir,
      undefined,
      join(dir, "injected"),
    );
    const deps = await createVaultCreateDeps(dir, injected);
    const config = VaultConfig.create("vault-1", "v1", "local_encryption", {});

    await deps.save(config);

    assertEquals(
      (await injected.findById("local_encryption", "vault-1"))?.name,
      "v1",
    );
    assertEquals(
      await new YamlVaultConfigRepository(dir).findById(
        "local_encryption",
        "vault-1",
      ),
      null,
    );
    assertEquals(await deps.findByName("v1"), true);
  });
});

Deno.test("createVaultCreateDeps: without an injected repository, saves under the repo's vaults dir", async () => {
  await withTempDir(async (dir) => {
    const deps = await createVaultCreateDeps(dir);

    await deps.save(
      VaultConfig.create("vault-1", "v1", "local_encryption", {}),
    );

    assertEquals(
      (await new YamlVaultConfigRepository(dir).findById(
        "local_encryption",
        "vault-1",
      ))?.name,
      "v1",
    );
  });
});
