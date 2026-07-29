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

// Integration tests for the vault selection resolution chain (field → spec → definition → defaultVault → first-available).

import { assertEquals, assertStringIncludes } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { z } from "zod";
import { ModelType } from "../src/domain/models/model_type.ts";
import type { ResourceOutputSpec } from "../src/domain/models/model.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import {
  createResourceWriter,
  processSensitiveResourceData,
} from "../src/domain/models/data_writer.ts";
import type { UnifiedDataRepository } from "../src/domain/data/repositories.ts";
import { SOLO_NAMESPACE } from "../src/domain/data/namespace.ts";
import { generateDataId } from "../src/domain/data/data_id.ts";

function createMockRepo(): UnifiedDataRepository {
  return {
    namespace: SOLO_NAMESPACE,
    findAllGlobal: () => Promise.resolve([]),
    findAllForType: () => Promise.resolve([]),
    findByName: () => Promise.resolve(null),
    findById: () => Promise.resolve(null),
    listVersions: () => Promise.resolve([]),
    findAllForModel: () => Promise.resolve([]),
    save: () => Promise.resolve({ version: 1 }),
    append: () => Promise.resolve(),
    stream: async function* () {},
    getContent: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
    removeLatestMarker: () => Promise.resolve(),
    nextId: () => generateDataId(),
    getPath: () => "",
    getContentPath: () => "",
    collectGarbage: () =>
      Promise.resolve({ versionsRemoved: 0, bytesReclaimed: 0 }),
    allocateVersion: () =>
      Promise.resolve({
        version: 1,
        contentPath: "/tmp/mock",
        priorVersions: [],
      }),
    finalizeVersion: () =>
      Promise.resolve({ size: 0, checksum: "mock-checksum" }),
    getLatestVersionSync: () => null,
    findByNameSync: () => null,
    listVersionsSync: () => [],
    getContentSync: () => null,
    findAllForModelSync: () => [],
    findAllGlobalSync: () => [],
    findByTaggedName: () => Promise.resolve([]),
    rename: () => {
      throw new Error("not implemented");
    },
    saveDeferred: () =>
      Promise.resolve({
        type: ModelType.create("test"),
        modelId: "",
        dataName: "",
        version: 1,
      }),
    finalizeVersionDeferred: () =>
      Promise.resolve({
        receipt: {
          type: ModelType.create("test"),
          modelId: "",
          dataName: "",
          version: 1,
        },
        size: 0,
        checksum: "",
      }),
    advanceLatestMarkers: () => Promise.resolve(),
    rollbackVersions: () => Promise.resolve(),
  };
}

const modelType = ModelType.create("test/vault-selection");
const modelId = "vault-selection-test-id";

function createSensitiveSpec(
  overrides?: Partial<ResourceOutputSpec>,
): ResourceOutputSpec {
  return {
    schema: z.object({
      secret: z.string().meta({ sensitive: true }),
      name: z.string(),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
    ...overrides,
  };
}

// --- Scenario 1: Single vault, no overrides — backwards compatible ---

Deno.test("vault selection: single vault with no overrides uses that vault", async () => {
  const spec = createSensitiveSpec();
  const data: Record<string, unknown> = { secret: "my-secret", name: "test" };
  const vaultService = new VaultService();
  vaultService.registerVault({
    name: "only-vault",
    type: "mock",
    config: {},
  });

  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
    "creds",
    "main",
  );

  assertStringIncludes(data.secret as string, "'only-vault'");
  assertEquals(data.name, "test");
});

// --- Scenario 2: Two vaults, no overrides — falls back to vaultNames[0] ---

Deno.test("vault selection: two vaults with no overrides uses first registered", async () => {
  const spec = createSensitiveSpec();
  const data: Record<string, unknown> = { secret: "my-secret", name: "test" };
  const vaultService = new VaultService();
  vaultService.registerVault({
    name: "alpha-vault",
    type: "mock",
    config: {},
  });
  vaultService.registerVault({
    name: "beta-vault",
    type: "mock",
    config: {},
  });

  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
    "creds",
    "main",
  );

  assertStringIncludes(data.secret as string, "'alpha-vault'");
});

// --- Scenario 3: defaultVault overrides first-registered fallback ---

Deno.test("vault selection: defaultVault overrides first-registered fallback", async () => {
  const spec = createSensitiveSpec();
  const data: Record<string, unknown> = { secret: "my-secret", name: "test" };
  const vaultService = new VaultService(undefined, "beta-vault");
  vaultService.registerVault({
    name: "alpha-vault",
    type: "mock",
    config: {},
  });
  vaultService.registerVault({
    name: "beta-vault",
    type: "mock",
    config: {},
  });

  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
    "creds",
    "main",
  );

  assertStringIncludes(data.secret as string, "'beta-vault'");
});

// --- Scenario 4: spec-level vaultName overrides defaultVault ---

Deno.test("vault selection: spec-level vaultName overrides defaultVault", async () => {
  const spec = createSensitiveSpec({ vaultName: "spec-vault" });
  const data: Record<string, unknown> = { secret: "my-secret", name: "test" };
  const vaultService = new VaultService(undefined, "default-vault");
  vaultService.registerVault({
    name: "default-vault",
    type: "mock",
    config: {},
  });
  vaultService.registerVault({
    name: "spec-vault",
    type: "mock",
    config: {},
  });

  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
    "creds",
    "main",
  );

  assertStringIncludes(data.secret as string, "'spec-vault'");
});

// --- Scenario 5: field-level vaultName overrides everything ---

Deno.test("vault selection: field-level vaultName overrides spec and default", async () => {
  const spec: ResourceOutputSpec = {
    schema: z.object({
      secret: z.string().meta({ sensitive: true, vaultName: "field-vault" }),
      name: z.string(),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
    vaultName: "spec-vault",
  };
  const data: Record<string, unknown> = { secret: "my-secret", name: "test" };
  const vaultService = new VaultService(undefined, "default-vault");
  vaultService.registerVault({
    name: "default-vault",
    type: "mock",
    config: {},
  });
  vaultService.registerVault({
    name: "spec-vault",
    type: "mock",
    config: {},
  });
  vaultService.registerVault({
    name: "field-vault",
    type: "mock",
    config: {},
  });

  await processSensitiveResourceData(
    data,
    spec,
    vaultService,
    modelType,
    modelId,
    "create",
    "creds",
    "main",
  );

  assertStringIncludes(data.secret as string, "'field-vault'");
});

// --- Scenario 6: Definition-level vaultName override via createResourceWriter ---

Deno.test("vault selection: definition-level vaultName override via createResourceWriter", async () => {
  const repo = createMockRepo();
  const resources: Record<string, ResourceOutputSpec> = {
    creds: createSensitiveSpec(),
  };

  const vaultService = new VaultService();
  vaultService.registerVault({
    name: "first-vault",
    type: "mock",
    config: {},
  });
  vaultService.registerVault({
    name: "definition-vault",
    type: "mock",
    config: {},
  });

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    resources,
    undefined,
    [{ specName: "creds", vaultName: "definition-vault" }],
    undefined,
    undefined,
    undefined,
    vaultService,
    "create",
  );

  const data = { secret: "my-secret-value", name: "test" };
  await writeResource("creds", "main", data);

  assertStringIncludes(data.secret as string, "'definition-vault'");
  assertEquals(data.name, "test");
});

// --- Scenario 7: Definition vaultName beats defaultVault but loses to field ---

Deno.test("vault selection: definition override beats defaultVault", async () => {
  const repo = createMockRepo();
  const resources: Record<string, ResourceOutputSpec> = {
    creds: createSensitiveSpec(),
  };

  const vaultService = new VaultService(undefined, "default-vault");
  vaultService.registerVault({
    name: "default-vault",
    type: "mock",
    config: {},
  });
  vaultService.registerVault({
    name: "definition-vault",
    type: "mock",
    config: {},
  });

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    resources,
    undefined,
    [{ specName: "creds", vaultName: "definition-vault" }],
    undefined,
    undefined,
    undefined,
    vaultService,
    "create",
  );

  const data = { secret: "my-secret", name: "test" };
  await writeResource("creds", "main", data);

  assertStringIncludes(data.secret as string, "'definition-vault'");
});

// --- Scenario 8: No overrides, no default — backwards-compat fallback ---

Deno.test("vault selection: no overrides and no default preserves backwards-compat", async () => {
  const repo = createMockRepo();
  const resources: Record<string, ResourceOutputSpec> = {
    creds: createSensitiveSpec(),
  };

  const vaultService = new VaultService();
  vaultService.registerVault({
    name: "vault-a",
    type: "mock",
    config: {},
  });
  vaultService.registerVault({
    name: "vault-b",
    type: "mock",
    config: {},
  });

  const { writeResource } = createResourceWriter(
    repo,
    modelType,
    modelId,
    resources,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    vaultService,
    "create",
  );

  const data = { secret: "my-secret", name: "test" };
  await writeResource("creds", "main", data);

  assertStringIncludes(data.secret as string, "'vault-a'");
});

// --- Scenario 9: VaultService.getDefaultVaultName for serve path ---

Deno.test("vault selection: VaultService.getDefaultVaultName for serve path", () => {
  const service = new VaultService(undefined, "oauth-vault");
  service.registerVault({ name: "first-vault", type: "mock", config: {} });
  service.registerVault({ name: "oauth-vault", type: "mock", config: {} });

  const vaultName = service.getDefaultVaultName() ??
    service.getVaultNames()[0];

  assertEquals(vaultName, "oauth-vault");
});

Deno.test("vault selection: VaultService.getDefaultVaultName falls back when no default", () => {
  const service = new VaultService();
  service.registerVault({ name: "first-vault", type: "mock", config: {} });
  service.registerVault({ name: "second-vault", type: "mock", config: {} });

  const vaultName = service.getDefaultVaultName() ??
    service.getVaultNames()[0];

  assertEquals(vaultName, "first-vault");
});

Deno.test("vault selection: VaultService.getDefaultVaultName ignores unregistered default", () => {
  const service = new VaultService(undefined, "nonexistent-vault");
  service.registerVault({ name: "first-vault", type: "mock", config: {} });

  const vaultName = service.getDefaultVaultName() ??
    service.getVaultNames()[0];

  assertEquals(vaultName, "first-vault");
});

// --- Scenario 12-14: VaultService.fromRepository with real vault configs on disk ---

async function withTwoVaultRepo(
  fn: (repoDir: string) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    const vaultADir = join(tempDir, "vaults", "mock");
    await ensureDir(vaultADir);
    await Deno.writeTextFile(
      join(vaultADir, "alpha-id.yaml"),
      stringifyYaml({
        id: "alpha-id",
        name: "alpha-vault",
        type: "mock",
        config: {},
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await Deno.writeTextFile(
      join(vaultADir, "beta-id.yaml"),
      stringifyYaml({
        id: "beta-id",
        name: "beta-vault",
        type: "mock",
        config: {},
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    await fn(tempDir);
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
}

Deno.test("vault selection: fromRepository with defaultVaultName routes put to the correct vault", async () => {
  await withTwoVaultRepo(async (repoDir) => {
    const vaultService = await VaultService.fromRepository(
      repoDir,
      { defaultVaultName: "beta-vault" },
    );

    assertEquals(vaultService.getDefaultVaultName(), "beta-vault");

    const targetVault = vaultService.getDefaultVaultName() ??
      vaultService.getVaultNames()[0];
    await vaultService.put(targetVault, "test-key", "test-secret");

    const stored = await vaultService.get("beta-vault", "test-key");
    assertEquals(stored, "test-secret");
  });
});

Deno.test("vault selection: fromRepository without defaultVaultName falls back to first vault", async () => {
  await withTwoVaultRepo(async (repoDir) => {
    const vaultService = await VaultService.fromRepository(repoDir);

    assertEquals(vaultService.getDefaultVaultName(), undefined);

    const targetVault = vaultService.getDefaultVaultName() ??
      vaultService.getVaultNames()[0];
    await vaultService.put(targetVault, "test-key", "test-secret");

    const stored = await vaultService.get(
      vaultService.getVaultNames()[0],
      "test-key",
    );
    assertEquals(stored, "test-secret");
  });
});

Deno.test("vault selection: fromRepository + processSensitiveResourceData end-to-end", async () => {
  await withTwoVaultRepo(async (repoDir) => {
    const vaultService = await VaultService.fromRepository(
      repoDir,
      { defaultVaultName: "beta-vault" },
    );

    const spec = createSensitiveSpec();
    const data: Record<string, unknown> = {
      secret: "serve-oauth-secret",
      name: "test",
    };

    await processSensitiveResourceData(
      data,
      spec,
      vaultService,
      modelType,
      modelId,
      "create",
      "creds",
      "main",
    );

    assertStringIncludes(data.secret as string, "'beta-vault'");
    assertEquals(data.name, "test");

    const vaultKey = `test-vault-selection-${modelId}-create-creds-main-secret`;
    const storedSecret = await vaultService.get("beta-vault", vaultKey);
    assertEquals(storedSecret, "serve-oauth-secret");
  });
});
