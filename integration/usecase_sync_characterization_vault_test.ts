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

/**
 * Use-case sync characterization, vault rows (swamp-club#2860). See
 * `usecase_sync_fixtures.ts` for how each row runs and what is observed.
 */

import "../src/domain/models/models.ts";
import { parse, stringify } from "@std/yaml";
import { VaultConfig } from "../src/domain/vaults/vault_config.ts";
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

await initializeLogging({});

const json = (repos: RowRepos) => ["--repo-dir", repos.repoA, "--json"];

/** Creates local_encryption vault `v1` the way a user would. */
async function createVault(repos: RowRepos): Promise<void> {
  await runCli({
    args: ["vault", "create", "local_encryption", "v1", ...json(repos)],
  });
}

/** Vault `v1`'s on-disk YAML with read auditing switched on. */
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
    // Recorded before the CLI adopted a root unit (swamp-club#3033).
    syncOrder: { cli: managedConfig ? ["push"] : [] },
    // With managedConfig the CLI pushes config through a bulk mark after the
    // use case: managed_config_sync.ts pushManagedConfigChanges /
    // pushManagedConfigPaths in PINNED_MARK_CALL_SITES.
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
    // Recorded before the CLI adopted a root unit (swamp-club#3033).
    syncOrder: { cli: managedConfig ? ["push"] : [] },
    // With managedConfig the CLI pushes config through a bulk mark after the
    // use case: managed_config_sync.ts pushManagedConfigChanges /
    // pushManagedConfigPaths in PINNED_MARK_CALL_SITES.
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
    // Recorded before the CLI adopted a root unit (swamp-club#3033).
    syncOrder: { cli: managedConfig ? ["push"] : [] },
    // With managedConfig the CLI pushes config through a bulk mark after the
    // use case: managed_config_sync.ts pushManagedConfigChanges /
    // pushManagedConfigPaths in PINNED_MARK_CALL_SITES.
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

/** The in-memory source type `vault migrate` moves away from, per run. */
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
];

/**
 * Today's behaviour, one entry per row. Every divergence and gap noted
 * below was deliberately left unfixed: datastore refactor phase 2 moves
 * unit-of-work ownership into the use cases and is expected to change these
 * rows, and should update this table as it does.
 */
const EXPECTED: Record<string, PinnedRow> = {
  "vault create": {
    // Vault configs are repo-local without managedConfig: nothing is marked or
    // pushed.
    cli: { "ops": [], "remote": { "added": [], "removed": [], "changed": [] } },
    // The handler's path mark is dropped by the hook (the file is outside the
    // cache), and the push is empty. Datastore refactor phase 2 is expected to
    // change this.
    serve: {
      "ops": ["push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "vault create (managedConfig)": {
    // DIVERGENCE: a bare markDirty from the CLI, a path mark from serve.
    // Datastore refactor phase 2 is expected to change this.
    cli: {
      "ops": ["markDirty(bulk)", "push[1]"],
      "remote": {
        "added": ["config/vaults/local_encryption/<id>.yaml"],
        "removed": [],
        "changed": [],
      },
    },
    serve: {
      "ops": ["markDirty config/vaults/local_encryption/<id>.yaml", "push[1]"],
      "remote": {
        "added": ["config/vaults/local_encryption/<id>.yaml"],
        "removed": [],
        "changed": [],
      },
    },
  },
  "vault edit": {
    // Repo-local without managedConfig: nothing is marked or pushed.
    cli: { "ops": [], "remote": { "added": [], "removed": [], "changed": [] } },
    // An empty push after the write. Datastore refactor phase 2 is expected to
    // change this.
    serve: {
      "ops": ["push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "vault edit (managedConfig)": {
    // DIVERGENCE: a bare markDirty from the CLI, a path mark from serve.
    // Datastore refactor phase 2 is expected to change this.
    cli: {
      "ops": ["markDirty(bulk)", "push[1]"],
      "remote": {
        "added": [],
        "removed": [],
        "changed": ["config/vaults/local_encryption/<id>.yaml"],
      },
    },
    serve: {
      "ops": ["markDirty config/vaults/local_encryption/<id>.yaml", "push[1]"],
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
    // No ops. Note serve's vault.put is the one write in connection.ts that is
    // not wrapped in withSyncGate. Datastore refactor phase 2 is expected to
    // change this.
    serve: {
      "ops": [],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "vault delete": {
    // Secrets live outside the datastore: nothing to sync.
    cli: { "ops": [], "remote": { "added": [], "removed": [], "changed": [] } },
    // Serve's vault.delete takes the sync gate but never pushes. Datastore
    // refactor phase 2 is expected to change this.
    serve: {
      "ops": [],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "vault migrate": {
    // Repo-local without managedConfig: nothing is marked or pushed.
    cli: { "ops": [], "remote": { "added": [], "removed": [], "changed": [] } },
    // An empty push after the write. Datastore refactor phase 2 is expected to
    // change this.
    serve: {
      "ops": ["push[0]"],
      "remote": { "added": [], "removed": [], "changed": [] },
    },
  },
  "vault migrate (managedConfig)": {
    // DIVERGENCE: the CLI's bare mark makes its push a walk that deletes
    // nothing, so the source vault's config stays on the remote and a peer
    // still sees the old vault. Serve marks both paths and deletes it.
    // Datastore refactor phase 2 is expected to change this.
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
