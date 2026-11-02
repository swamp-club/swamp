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

import "../src/domain/models/models.ts";
import { parse, stringify } from "@std/yaml";
import { VaultConfig } from "../src/domain/vaults/vault_config.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoMarkerRepository } from "../src/infrastructure/persistence/repo_marker_repository.ts";
import { MockVaultProvider } from "../src/domain/vaults/mock_vault_provider.ts";
import { vaultTypeRegistry } from "../src/domain/vaults/vault_type_registry.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  type AnyRow,
  checkRows,
  type PinnedRow,
  row,
  type RowRepos,
  runCli,
} from "./usecase_sync_fixtures.ts";
import { checkRowsOnV3 } from "./usecase_v3_fixtures.ts";

await initializeLogging({});

const json = (repos: RowRepos) => ["--repo-dir", repos.repoA, "--json"];

async function createVault(repos: RowRepos): Promise<void> {
  await runCli({
    args: ["vault", "create", "local_encryption", "v1", ...json(repos)],
  });
}

async function editedVaultYaml(repos: RowRepos): Promise<string> {
  await createVault(repos);
  const vault = await repos.a.repoContext.vaultConfigRepo.findByName("v1");
  const path = repos.a.repoContext.vaultConfigRepo.getPath(
    vault!.type,
    vault!.id,
  );
  const doc = parse(await Deno.readTextFile(path)) as Record<string, unknown>;
  doc.auditReads = true;
  return stringify(doc);
}

function vaultCreateRow(managedConfig: boolean): AnyRow {
  return row({
    name: `vault create${managedConfig ? " (managedConfig)" : ""}`,
    rootUnit: { cli: true, serve: true },
    syncOrder: {
      cli: managedConfig ? ["push"] : [],
      serve: ["push", "release"],
    },
    outsideUseCase: managedConfig ? { cli: ["markDirty(bulk)"] } : undefined,
    options: { managedConfig },
    cli: (repos) => ({
      args: ["vault", "create", "local_encryption", "v1", ...json(repos)],
    }),
    serve: () => ({
      type: "vault.create",
      payload: { vaultType: "local_encryption", name: "v1" },
    }),
  });
}

function vaultEditRow(managedConfig: boolean): AnyRow {
  return row({
    name: `vault edit${managedConfig ? " (managedConfig)" : ""}`,
    rootUnit: { cli: true, serve: true },
    syncOrder: {
      cli: managedConfig ? ["push"] : [],
      serve: ["push", "release"],
    },
    outsideUseCase: managedConfig ? { cli: ["markDirty(bulk)"] } : undefined,
    options: { managedConfig },
    seed: editedVaultYaml,
    cli: (repos, content) => ({
      args: ["vault", "edit", "v1", ...json(repos)],
      stdin: content,
    }),
    serve: (_repos, content) => ({
      type: "vault.edit",
      payload: { vaultNameOrId: "v1", content },
    }),
    verify: async (repos) => {
      const vault = await repos.a.repoContext.vaultConfigRepo.findByName("v1");
      if (vault?.auditReads !== true) throw new Error("vault edit not saved");
    },
  });
}

function vaultMigrateRow(
  managedConfig: boolean,
  sourceType: () => string,
): AnyRow {
  return row({
    name: `vault migrate${managedConfig ? " (managedConfig)" : ""}`,
    rootUnit: { cli: true, serve: true },
    syncOrder: {
      cli: managedConfig ? ["push"] : [],
      serve: ["push", "release"],
    },
    outsideUseCase: managedConfig ? { cli: ["markDirty(bulk)"] } : undefined,
    options: { managedConfig },
    seed: async (repos) => {
      await repos.a.repoContext.vaultConfigRepo.save(
        VaultConfig.create(crypto.randomUUID(), "src", sourceType(), {}),
      );
    },
    cli: (repos) => ({
      args: [
        "vault",
        "migrate",
        "src",
        "--to-type",
        "local_encryption",
        "--yes",
        ...json(repos),
      ],
    }),
    serve: () => ({
      type: "vault.migrate",
      payload: { vaultName: "src", targetType: "local_encryption" },
    }),
    verify: async (repos) => {
      const vault = await repos.a.repoContext.vaultConfigRepo.findByName("src");
      if (vault?.type !== "local_encryption") {
        throw new Error("vault migrate did not change the type");
      }
    },
  });
}

function vaultRemoveRow(managedConfig: boolean): AnyRow {
  return row({
    name: `vault remove${managedConfig ? " (managedConfig)" : ""}`,
    rootUnit: { cli: true },
    syncOrder: { cli: managedConfig ? ["push"] : [] },
    // No bulk mark: the hooked repository marks the removed config's path,
    // so the push deletes it on the remote.
    options: { managedConfig },
    seed: async (repos) => {
      // Another vault is the default, so v1 is not refused as the fallback.
      await runCli({
        args: ["vault", "create", "local_encryption", "keep", ...json(repos)],
      });
      const markerRepo = new RepoMarkerRepository();
      const repoPath = RepoPath.create(repos.repoA);
      const marker = await markerRepo.read(repoPath);
      await markerRepo.write(repoPath, { ...marker!, defaultVault: "keep" });
      await createVault(repos);
      await runCli({
        args: ["vault", "put", "v1", "K1", "val", "--yes", ...json(repos)],
      });
    },
    cli: (repos) => ({
      args: ["vault", "remove", "v1", "--yes", ...json(repos)],
    }),
    // serve has no vault.remove
    serve: null,
    verify: async (repos) => {
      const vault = await repos.a.repoContext.vaultConfigRepo.findByName("v1");
      if (vault !== null) throw new Error("vault remove kept the config");
    },
  });
}

let migrateSourceType = "";

const ROWS: AnyRow[] = [
  vaultCreateRow(false),
  vaultCreateRow(true),
  vaultEditRow(false),
  vaultEditRow(true),
  row({
    name: "vault put",
    seed: createVault,
    cli: (repos) => ({
      args: ["vault", "put", "v1", "K1", "val", "--yes", ...json(repos)],
    }),
    serve: () => ({
      type: "vault.put",
      payload: { vaultName: "v1", key: "K1", value: "val" },
    }),
  }),
  row({
    name: "vault delete",
    seed: async (repos) => {
      await createVault(repos);
      await runCli({
        args: ["vault", "put", "v1", "K1", "val", "--yes", ...json(repos)],
      });
    },
    cli: (repos) => ({
      args: ["vault", "delete", "v1", "K1", "--force", ...json(repos)],
    }),
    serve: () => ({
      type: "vault.delete",
      payload: { vaultName: "v1", key: "K1" },
    }),
  }),
  vaultMigrateRow(false, () => migrateSourceType),
  vaultMigrateRow(true, () => migrateSourceType),
  vaultRemoveRow(false),
  vaultRemoveRow(true),
];

/**
 * pins current behaviour per row, divergences and gaps included; update the
 * table when unit-of-work ownership moves into the use cases
 */
const EXPECTED: Record<string, PinnedRow> = {
  "vault remove": {
    cli: { "ops": [], "remote": { "added": [], "removed": [], "changed": [] } },
    serve: null,
  },
  "vault remove (managedConfig)": {
    // The removed config's path mark makes the push delete it, so peers lose
    // the vault (unlike vault migrate's bare mark above).
    cli: {
      "ops": [
        "markDirty config/vaults/local_encryption/<id>.yaml",
        "markDirty config/vaults/local_encryption/<id>.yaml",
        "push[0 del 1]",
      ],
      "remote": {
        "added": [],
        "removed": ["config/vaults/local_encryption/<id>.yaml"],
        "changed": [],
      },
    },
    serve: null,
  },
  "vault create": {
    cli: { "ops": [], "remote": { "added": [], "removed": [], "changed": [] } },
    serve: {
      "ops": ["push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "vault create (managedConfig)": {
    cli: {
      "ops": ["markDirty(bulk)", "push[1]"],
      "remote": {
        "added": ["config/vaults/local_encryption/<id>.yaml"],
        "removed": [],
        "changed": [],
      },
    },
    serve: {
      "ops": [
        "markDirty config/vaults/local_encryption/<id>.yaml",
        "markDirty config/vaults/local_encryption/<id>.yaml",
        "push[1]",
      ],
      "remote": {
        "added": ["config/vaults/local_encryption/<id>.yaml"],
        "removed": [],
        "changed": [],
      },
    },
  },
  "vault edit": {
    cli: { "ops": [], "remote": { "added": [], "removed": [], "changed": [] } },
    serve: {
      "ops": ["push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "vault edit (managedConfig)": {
    cli: {
      "ops": ["markDirty(bulk)", "push[1]"],
      "remote": {
        "added": [],
        "removed": [],
        "changed": ["config/vaults/local_encryption/<id>.yaml"],
      },
    },
    serve: {
      "ops": [
        "markDirty config/vaults/local_encryption/<id>.yaml",
        "markDirty config/vaults/local_encryption/<id>.yaml",
        "push[1]",
      ],
      "remote": {
        "added": [],
        "removed": [],
        "changed": ["config/vaults/local_encryption/<id>.yaml"],
      },
    },
  },
  "vault put": {
    // A local_encryption vault keeps its secrets outside the datastore, so
    // neither composition syncs anything.
    cli: { "ops": [], "remote": { "added": [], "removed": [], "changed": [] } },
    // no ops; serve's vault.put is the one write in connection.ts not wrapped
    // in withSyncGate
    serve: {
      "ops": [],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "vault delete": {
    cli: { "ops": [], "remote": { "added": [], "removed": [], "changed": [] } },
    serve: {
      "ops": [],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "vault migrate": {
    cli: { "ops": [], "remote": { "added": [], "removed": [], "changed": [] } },
    serve: {
      "ops": ["push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "vault migrate (managedConfig)": {
    // divergence: the CLI's bare mark makes its push a walk that deletes
    // nothing, so a peer still sees the old vault; serve marks both paths and
    // deletes it
    cli: {
      "ops": ["markDirty(bulk)", "push[1]"],
      "remote": {
        "added": ["config/vaults/local_encryption/<id>.yaml"],
        "removed": [],
        "changed": [],
      },
    },
    serve: {
      "ops": [
        "markDirty config/vaults/local_encryption/<id>.yaml",
        "markDirty config/vaults/local_encryption/<id>.yaml",
        "markDirty config/vaults/@test/usecase-vault-<id>/<id>.yaml",
        "markDirty config/vaults/@test/usecase-vault-<id>/<id>.yaml",
        "push[1 del 1]",
      ],
      "remote": {
        "added": ["config/vaults/local_encryption/<id>.yaml"],
        "removed": ["config/vaults/@test/usecase-vault-<id>/<id>.yaml"],
        "changed": [],
      },
    },
  },
};

Deno.test("use case sync characterization: vault use cases mark and push today's paths", async (t) => {
  migrateSourceType = `@test/usecase-vault-${crypto.randomUUID()}`;
  vaultTypeRegistry.register({
    type: migrateSourceType,
    name: "Migrate source",
    description: "In-memory vault the migrate rows move away from",
    isBuiltIn: false,
    createProvider: (name) => new MockVaultProvider(name),
  });
  try {
    await checkRows(t, ROWS, EXPECTED);
  } finally {
    vaultTypeRegistry.invalidateType(migrateSourceType);
  }
});

Deno.test("use-case sync characterization: on a v3 datastore every vault row commits what the second checkout reads (swamp-club#3279)", async (t) => {
  migrateSourceType = `@test/usecase-vault-${crypto.randomUUID()}`;
  vaultTypeRegistry.register({
    type: migrateSourceType,
    name: "Migrate source",
    description: "In-memory vault the migrate rows move away from",
    isBuiltIn: false,
    createProvider: (name) => new MockVaultProvider(name),
  });
  try {
    await checkRowsOnV3(t, ROWS);
  } finally {
    vaultTypeRegistry.invalidateType(migrateSourceType);
  }
});

Deno.test("use-case sync characterization: on a namespaced v3 datastore every vault row commits what the second checkout reads (swamp-club#3279)", async (t) => {
  migrateSourceType = `@test/usecase-vault-${crypto.randomUUID()}`;
  vaultTypeRegistry.register({
    type: migrateSourceType,
    name: "Migrate source",
    description: "In-memory vault the migrate rows move away from",
    isBuiltIn: false,
    createProvider: (name) => new MockVaultProvider(name),
  });
  try {
    await checkRowsOnV3(t, ROWS, {}, { namespace: "team" });
  } finally {
    vaultTypeRegistry.invalidateType(migrateSourceType);
  }
});
