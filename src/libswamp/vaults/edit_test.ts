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
import { z } from "zod";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  createVaultEditDeps,
  vaultEdit,
  type VaultEditDeps,
  type VaultEditEvent,
} from "./edit.ts";
import type { VaultConfigData } from "../../domain/vaults/vault_config.ts";
import { registerManagedConfig } from "../../infrastructure/persistence/paths.ts";
import { assertPathEquals } from "../../infrastructure/persistence/path_test_helpers.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import { VaultConfig } from "../../domain/vaults/vault_config.ts";

function prepareEditor(editor: string) {
  return (path: string) =>
    Promise.resolve({
      editor,
      waitsForExit: false,
      open: () => Promise.resolve({ editor, path }),
    });
}

function makeDeps(overrides: Partial<VaultEditDeps> = {}): VaultEditDeps {
  return {
    findByName: () => Promise.resolve(null),
    findById: () => Promise.resolve(null),
    findAll: () => Promise.resolve([]),
    getVaultPath: () => "/fake/path/vault.yaml",
    fileExists: () => Promise.resolve(true),
    prepareEditor: prepareEditor("VS Code"),
    readConfigData: () => Promise.resolve(null),
    saveConfigData: () => Promise.resolve(),
    getConfigSchema: () => Promise.resolve(undefined),
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
    getVaultPath: () => "/repo/vaults/env/vault-1.yaml",
    prepareEditor: prepareEditor("Neovim"),
  });

  const events = await collect<VaultEditEvent>(
    vaultEdit(createLibSwampContext(), deps, {
      vaultNameOrId: "my-vault",
    }),
  );

  assertEquals(events, [
    { kind: "resolving" },
    {
      kind: "launching",
      data: {
        editor: "Neovim",
        path: "/repo/vaults/env/vault-1.yaml",
        waitsForExit: false,
      },
    },
    {
      kind: "completed",
      data: {
        path: "/repo/vaults/env/vault-1.yaml",
        editor: "Neovim",
        status: "opened",
        name: "my-vault",
        type: "env",
      },
    },
  ]);
});

Deno.test("vaultEdit: announces editor launch before opening", async () => {
  let opened = false;
  const deps = makeDeps({
    findByName: () => Promise.resolve(testVaultConfig),
    getVaultPath: () => "/repo/vaults/env/vault-1.yaml",
    prepareEditor: (path) =>
      Promise.resolve({
        editor: "VS Code",
        waitsForExit: true,
        open: () => {
          opened = true;
          return Promise.resolve({ editor: "VS Code", path });
        },
      }),
  });

  const iterator = vaultEdit(createLibSwampContext(), deps, {
    vaultNameOrId: "my-vault",
  })[Symbol.asyncIterator]();

  await iterator.next();
  const launch = await iterator.next();
  assertEquals(launch.value, {
    kind: "launching",
    data: {
      editor: "VS Code",
      path: "/repo/vaults/env/vault-1.yaml",
      waitsForExit: true,
    },
  });
  assertEquals(opened, false);

  await iterator.next();
  assertEquals(opened, true);
});

Deno.test("vaultEdit: finds vault by ID when name lookup fails", async () => {
  const deps = makeDeps({
    findByName: () => Promise.resolve(null),
    findAll: () => Promise.resolve([testVaultConfig]),
    getVaultPath: () => "/repo/vaults/env/vault-1.yaml",
    prepareEditor: prepareEditor("VS Code"),
  });

  const events = await collect<VaultEditEvent>(
    vaultEdit(createLibSwampContext(), deps, {
      vaultNameOrId: "vault-1",
    }),
  );

  const completed = events[2] as Extract<
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
    getVaultPath: () => "/repo/vaults/env/vault-1.yaml",
    prepareEditor: prepareEditor("VS Code"),
  });

  const events = await collect<VaultEditEvent>(
    vaultEdit(createLibSwampContext(), deps, {
      vaultNameOrId: "vault-1",
      vaultType: "env",
    }),
  );

  const completed = events[2] as Extract<
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
    getVaultPath: () => "/repo/vaults/env/vault-1.yaml",
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

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir({ prefix: "swamp-vault-edit-test-" });
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

const existingData: VaultConfigData = {
  id: "vault-1",
  name: "my-vault",
  type: "env",
  config: { prefix: "APP_" },
  createdAt: "2026-01-01T00:00:00.000Z",
};

/** Deps for stdin updates of `existingData`, recording what gets saved. */
function makeStdinDeps(
  overrides: Partial<VaultEditDeps> = {},
): { deps: VaultEditDeps; saved: VaultConfigData[] } {
  const saved: VaultConfigData[] = [];
  const deps = makeDeps({
    findByName: (name) =>
      Promise.resolve(name === "my-vault" ? testVaultConfig : null),
    readConfigData: () => Promise.resolve({ ...existingData }),
    saveConfigData: (data) => {
      saved.push(data);
      return Promise.resolve();
    },
    prepareEditor: () => {
      throw new Error("the editor must not be prepared in stdin mode");
    },
    ...overrides,
  });
  return { deps, saved };
}

async function runStdin(
  deps: VaultEditDeps,
  stdinContent: string,
  extra: Partial<Parameters<typeof vaultEdit>[2]> = {},
): Promise<VaultEditEvent> {
  const events = await collect<VaultEditEvent>(
    vaultEdit(createLibSwampContext(), deps, {
      vaultNameOrId: "my-vault",
      stdinContent,
      ...extra,
    }),
  );
  return events[events.length - 1];
}

function errorOf(event: VaultEditEvent) {
  assertEquals(event.kind, "error");
  return (event as Extract<VaultEditEvent, { kind: "error" }>).error;
}

Deno.test("vaultEdit: stdin update saves the config, keeping id and createdAt", async () => {
  const { deps, saved } = makeStdinDeps();

  const last = await runStdin(
    deps,
    "id: other-id\nname: my-vault\ntype: env\nconfig:\n  prefix: NEW_\n",
  );

  assertEquals(last, {
    kind: "completed",
    data: {
      path: "/fake/path/vault.yaml",
      status: "updated",
      name: "my-vault",
      type: "env",
    },
  });
  assertEquals(saved, [{
    id: "vault-1",
    name: "my-vault",
    type: "env",
    config: { prefix: "NEW_" },
    createdAt: "2026-01-01T00:00:00.000Z",
  }]);
});

Deno.test("vaultEdit: stdin update rejects YAML that does not parse", async () => {
  const { deps, saved } = makeStdinDeps();

  const error = errorOf(await runStdin(deps, "name: [unclosed"));

  assertEquals(error.code, "validation_failed");
  assertStringIncludes(error.message, "Invalid vault YAML from stdin");
  assertEquals(saved, []);
});

Deno.test("vaultEdit: stdin update rejects YAML that is not a mapping", async () => {
  const { deps, saved } = makeStdinDeps();

  const error = errorOf(await runStdin(deps, "- a\n- b\n"));

  assertEquals(error.code, "validation_failed");
  assertEquals(saved, []);
});

Deno.test("vaultEdit: stdin update rejects content missing required fields", async () => {
  const { deps, saved } = makeStdinDeps();

  const error = errorOf(await runStdin(deps, "config: {}\n"));

  assertEquals(error.code, "validation_failed");
  assertEquals(saved, []);
});

Deno.test("vaultEdit: stdin update rejects a type change", async () => {
  const { deps, saved } = makeStdinDeps();

  const error = errorOf(
    await runStdin(deps, "name: my-vault\ntype: local_encryption\n"),
  );

  assertEquals(error.code, "validation_failed");
  assertStringIncludes(error.message, "Cannot change the type");
  assertEquals(saved, []);
});

Deno.test("vaultEdit: stdin update rejects a rename that breaks the naming rule", async () => {
  for (const name of ["Bad_Name", "_token-secrets"]) {
    const { deps, saved } = makeStdinDeps();

    const error = errorOf(
      await runStdin(deps, `name: ${name}\ntype: env\n`),
    );

    assertEquals(error.code, "validation_failed");
    assertStringIncludes(error.message, "Invalid vault name");
    assertEquals(saved, []);
  }
});

Deno.test("vaultEdit: stdin update rejects a rename onto another vault's name", async () => {
  const { deps, saved } = makeStdinDeps({
    findByName: (name) => {
      if (name === "my-vault") return Promise.resolve(testVaultConfig);
      if (name === "taken") {
        return Promise.resolve({ id: "vault-2", name: "taken", type: "env" });
      }
      return Promise.resolve(null);
    },
  });

  const error = errorOf(await runStdin(deps, "name: taken\ntype: env\n"));

  assertEquals(error.code, "already_exists");
  assertEquals(saved, []);
});

Deno.test("vaultEdit: stdin update validates config against the type's schema", async () => {
  const { deps, saved } = makeStdinDeps({
    getConfigSchema: () =>
      Promise.resolve(z.object({ prefix: z.string().min(3) })),
  });

  const error = errorOf(
    await runStdin(deps, "name: my-vault\ntype: env\nconfig:\n  prefix: X\n"),
  );

  assertEquals(error.code, "validation_failed");
  assertStringIncludes(error.message, "Invalid config for vault type 'env'");
  assertEquals(saved, []);
});

Deno.test("vaultEdit: stdin rename asks authorizeUpdate and saves when allowed", async () => {
  const { deps, saved } = makeStdinDeps();
  const asked: Array<[string, string]> = [];

  const last = await runStdin(deps, "name: renamed\ntype: env\n", {
    authorizeUpdate: (before, after) => {
      asked.push([before.name, after.name]);
      return true;
    },
  });

  assertEquals(last.kind, "completed");
  assertEquals(asked, [["my-vault", "renamed"]]);
  assertEquals(saved.map((d) => d.name), ["renamed"]);
});

Deno.test("vaultEdit: stdin rename denied by authorizeUpdate writes nothing", async () => {
  const { deps, saved } = makeStdinDeps();

  const error = errorOf(
    await runStdin(deps, "name: renamed\ntype: env\n", {
      authorizeUpdate: () => false,
    }),
  );

  assertEquals(error.code, "forbidden");
  assertEquals(saved, []);
});

Deno.test("vaultEdit: stdin update without a rename does not ask authorizeUpdate", async () => {
  const { deps, saved } = makeStdinDeps();
  let asked = false;

  const last = await runStdin(deps, "name: my-vault\ntype: env\n", {
    authorizeUpdate: () => {
      asked = true;
      return false;
    },
  });

  assertEquals(last.kind, "completed");
  assertEquals(asked, false);
  assertEquals(saved.length, 1);
});

Deno.test("vaultEdit: byId looks the vault up by id only", async () => {
  const lookups: string[] = [];
  const deps = makeDeps({
    // A vault whose name matches the id must not be picked.
    findByName: (name) => {
      lookups.push(`name:${name}`);
      return Promise.resolve({ id: "other", name, type: "env" });
    },
    findById: (type, id) => {
      lookups.push(`id:${type}/${id}`);
      return Promise.resolve(testVaultConfig);
    },
  });

  const events = await collect<VaultEditEvent>(
    vaultEdit(createLibSwampContext(), deps, {
      vaultNameOrId: "vault-1",
      vaultType: "env",
      byId: true,
    }),
  );

  assertEquals(lookups, ["id:env/vault-1"]);
  const completed = events[events.length - 1] as Extract<
    VaultEditEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.name, "my-vault");
});

Deno.test("createVaultEditDeps: resolves and updates the vault under the managedConfig vaults dir (swamp-club#2426)", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    const configBase = join(dir, "datastore", "config");
    await Deno.mkdir(repoDir, { recursive: true });
    // Keyed by this run's temp dir, so it cannot leak into another test.
    registerManagedConfig(repoDir, true, configBase);
    const repo = new YamlVaultConfigRepository(repoDir);
    await repo.save(
      VaultConfig.fromData({ ...existingData, type: "local_encryption" }),
    );

    const deps = createVaultEditDeps(repoDir);
    const events = await collect<VaultEditEvent>(
      vaultEdit(createLibSwampContext(), deps, {
        vaultNameOrId: "my-vault",
        stdinContent: "name: my-vault\ntype: local_encryption\nconfig: {}\n",
      }),
    );

    const last = events[events.length - 1] as Extract<
      VaultEditEvent,
      { kind: "completed" }
    >;
    assertEquals(last.kind, "completed");
    assertPathEquals(
      last.data.path,
      join(configBase, "vaults", "local_encryption", "vault-1.yaml"),
    );
    const reread = await repo.findById("local_encryption", "vault-1");
    assertEquals(reread?.config, {});
  });
});
