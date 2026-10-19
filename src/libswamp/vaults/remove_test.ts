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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import { VaultConfig } from "../../domain/vaults/vault_config.ts";
import type { VaultReferences } from "../../domain/vaults/vault_references.ts";
import {
  vaultRemove,
  type VaultRemoveDeps,
  type VaultRemoveEvent,
  type VaultRemoveLocalStorage,
  vaultRemovePreview,
  vaultRemoveStoredSecrets,
} from "./remove.ts";

const localVault = VaultConfig.create(
  "11111111-1111-4111-8111-111111111111",
  "trip-planner",
  "local_encryption",
  { auto_generate: true },
);

const storage: VaultRemoveLocalStorage = {
  baseDir: "/repo",
  directory: "/repo/.swamp/secrets/local_encryption/trip-planner",
  secretKeys: ["API_KEY"],
};

const noReferences: VaultReferences = {
  references: [],
  possibleReferences: [],
};

const referenced: VaultReferences = {
  references: [{ kind: "definition", name: "app", via: "vault.get" }],
  possibleReferences: [],
};

function makeDeps(
  overrides: Partial<VaultRemoveDeps> = {},
): VaultRemoveDeps & { deleted: string[]; removedSecrets: string[] } {
  const deleted: string[] = [];
  const removedSecrets: string[] = [];
  return {
    deleted,
    removedSecrets,
    findVault: (name) =>
      Promise.resolve(name === localVault.name ? localVault : null),
    listVaultNames: () => Promise.resolve(["default", "trip-planner"]),
    getDefaultVaultName: () => Promise.resolve("default"),
    findReferences: () => Promise.resolve(noReferences),
    findLocalStorage: () => Promise.resolve(storage),
    deleteConfig: (config) => {
      deleted.push(config.name);
      return Promise.resolve();
    },
    removeLocalSecrets: (s, name) => {
      removedSecrets.push(name);
      return Promise.resolve({
        directory: s.directory,
        removed: true,
        secretCount: s.secretKeys.length,
      });
    },
    ...overrides,
  };
}

async function previewError(
  deps: VaultRemoveDeps,
  vaultName: string,
  force = false,
): Promise<{ code: string; message: string }> {
  try {
    await vaultRemovePreview(createLibSwampContext(), deps, {
      vaultName,
      force,
    });
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error("Expected vaultRemovePreview to throw");
}

Deno.test("vaultRemovePreview: describes the vault and its local secrets", async () => {
  const preview = await vaultRemovePreview(
    createLibSwampContext(),
    makeDeps(),
    { vaultName: "trip-planner" },
  );
  assertEquals(preview, {
    vaultName: "trip-planner",
    vaultId: localVault.id,
    vaultType: "local_encryption",
    localStorage: storage,
    references: [],
    possibleReferences: [],
  });
});

Deno.test("vaultRemovePreview: an unknown vault is not_found and lists the vaults", async () => {
  const error = await previewError(makeDeps(), "missing");
  assertEquals(error.code, "not_found");
  assertStringIncludes(
    error.message,
    "Available vaults: default, trip-planner",
  );
});

Deno.test("vaultRemovePreview: a reserved name explains it is reserved", async () => {
  const error = await previewError(makeDeps(), "_token-secrets");
  assertEquals(error.code, "not_found");
  assertStringIncludes(error.message, "reserved");
});

Deno.test("vaultRemovePreview: refuses the default vault, even with force", async () => {
  const deps = makeDeps({
    getDefaultVaultName: () => Promise.resolve("trip-planner"),
  });
  for (const force of [false, true]) {
    const error = await previewError(deps, "trip-planner", force);
    assertEquals(error.code, "validation_failed");
    assertStringIncludes(error.message, "default vault");
    assertStringIncludes(error.message, "defaultVault in .swamp.yaml");
  }
});

Deno.test("vaultRemovePreview: refuses a referenced vault without force and names the references", async () => {
  const deps = makeDeps({ findReferences: () => Promise.resolve(referenced) });
  const error = await previewError(deps, "trip-planner");
  assertEquals(error.code, "validation_failed");
  assertStringIncludes(error.message, "definition 'app' (vault.get)");
  assertStringIncludes(error.message, "--force");
});

Deno.test("vaultRemovePreview: with force, reports the references it overrides", async () => {
  const deps = makeDeps({ findReferences: () => Promise.resolve(referenced) });
  const preview = await vaultRemovePreview(createLibSwampContext(), deps, {
    vaultName: "trip-planner",
    force: true,
  });
  assertEquals(preview.references, referenced.references);
});

Deno.test("vaultRemove: removes only the config and reports the forced references", async () => {
  const deps = makeDeps({ findReferences: () => Promise.resolve(referenced) });
  const events = await collect<VaultRemoveEvent>(
    vaultRemove(createLibSwampContext(), deps, {
      vaultName: "trip-planner",
      force: true,
    }),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(deps.deleted, ["trip-planner"]);
  assertEquals(deps.removedSecrets, []);
  if (completed?.kind !== "completed") throw new Error("expected completed");
  assertEquals(completed.data.vaultName, "trip-planner");
  assertEquals(completed.data.vaultId, localVault.id);
  assertEquals(completed.data.forcedReferences, referenced.references);
  assertEquals(completed.data.secrets, undefined);
});

Deno.test("vaultRemove: re-checks the default vault and removes nothing", async () => {
  const deps = makeDeps({
    getDefaultVaultName: () => Promise.resolve("trip-planner"),
  });
  const events = await collect<VaultRemoveEvent>(
    vaultRemove(createLibSwampContext(), deps, {
      vaultName: "trip-planner",
      force: true,
    }),
  );
  const error = events.find((e) => e.kind === "error");
  if (error?.kind !== "error") throw new Error("expected error");
  assertEquals(error.error.code, "validation_failed");
  assertEquals(deps.deleted, []);
});

Deno.test("vaultRemove: re-checks references and removes nothing without force", async () => {
  const deps = makeDeps({ findReferences: () => Promise.resolve(referenced) });
  const events = await collect<VaultRemoveEvent>(
    vaultRemove(createLibSwampContext(), deps, { vaultName: "trip-planner" }),
  );
  assertEquals(events.some((e) => e.kind === "error"), true);
  assertEquals(deps.deleted, []);
});

Deno.test("vaultRemove: an unknown vault reports not_found", async () => {
  const deps = makeDeps();
  const events = await collect<VaultRemoveEvent>(
    vaultRemove(createLibSwampContext(), deps, { vaultName: "missing" }),
  );
  const error = events.find((e) => e.kind === "error");
  if (error?.kind !== "error") throw new Error("expected error");
  assertEquals(error.error.code, "not_found");
  assertEquals(deps.deleted, []);
});

Deno.test("vaultRemoveStoredSecrets: removes a local vault's secrets", async () => {
  const deps = makeDeps();
  const preview = await vaultRemovePreview(createLibSwampContext(), deps, {
    vaultName: "trip-planner",
  });
  const removed = await vaultRemoveStoredSecrets(
    createLibSwampContext(),
    deps,
    preview,
  );
  assertEquals(removed, {
    directory: storage.directory,
    removed: true,
    secretCount: 1,
  });
  assertEquals(deps.removedSecrets, ["trip-planner"]);
});

Deno.test("vaultRemoveStoredSecrets: does nothing for a vault whose secrets are not local", async () => {
  const deps = makeDeps({ findLocalStorage: () => Promise.resolve(undefined) });
  const preview = await vaultRemovePreview(createLibSwampContext(), deps, {
    vaultName: "trip-planner",
  });
  assertEquals(
    await vaultRemoveStoredSecrets(createLibSwampContext(), deps, preview),
    undefined,
  );
  assertEquals(deps.removedSecrets, []);
});

Deno.test("vaultRemoveStoredSecrets: a failure reaches the caller", async () => {
  const deps = makeDeps({
    removeLocalSecrets: () => Promise.reject(new Error("permission denied")),
  });
  const preview = await vaultRemovePreview(createLibSwampContext(), deps, {
    vaultName: "trip-planner",
  });
  await assertRejects(
    () => vaultRemoveStoredSecrets(createLibSwampContext(), deps, preview),
    Error,
    "permission denied",
  );
});
