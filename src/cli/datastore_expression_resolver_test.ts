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
import { join } from "@std/path";
import { z } from "zod";
import {
  type DatastoreExpressionContext,
  resolveDatastoreExpressions,
} from "./datastore_expression_resolver.ts";
import { UserError } from "../domain/errors.ts";
import type { VaultService } from "../domain/vaults/vault_service.ts";
import { vaultTypeRegistry } from "../domain/vaults/vault_type_registry.ts";
import { MockVaultProvider } from "../domain/vaults/mock_vault_provider.ts";
import { withMockedEnv } from "../infrastructure/persistence/path_test_helpers.ts";

function baseContext(
  overrides?: Partial<DatastoreExpressionContext>,
): DatastoreExpressionContext {
  return { repoDir: "/tmp/test-repo", ...overrides };
}

function mockVaultFactory(
  secrets: Record<string, Record<string, string>>,
): (repoDir: string) => Promise<VaultService> {
  return (_repoDir: string) =>
    Promise.resolve({
      get: (
        vaultName: string,
        secretKey: string,
        _auditSource: string,
      ): Promise<string> => {
        const vault = secrets[vaultName];
        if (!vault) {
          return Promise.reject(
            new Error(
              `Vault "${vaultName}" not found. Available vaults: ${
                Object.keys(secrets).join(", ")
              }`,
            ),
          );
        }
        const value = vault[secretKey];
        if (value === undefined) {
          return Promise.reject(
            new Error(
              `Secret "${secretKey}" not found in vault "${vaultName}"`,
            ),
          );
        }
        return Promise.resolve(value);
      },
    } as unknown as VaultService);
}

Deno.test("resolveDatastoreExpressions: config with no expressions passes through unchanged", async () => {
  const config = { host: "localhost", port: 5432, ssl: true };
  const result = await resolveDatastoreExpressions(config, baseContext());
  assertEquals(result, { host: "localhost", port: 5432, ssl: true });
});

Deno.test("resolveDatastoreExpressions: empty config returns empty object", async () => {
  const result = await resolveDatastoreExpressions({}, baseContext());
  assertEquals(result, {});
});

Deno.test("resolveDatastoreExpressions: config with only primitives passes through", async () => {
  const config = { count: 42, enabled: false, label: null as unknown };
  const result = await resolveDatastoreExpressions(config, baseContext());
  assertEquals(result, { count: 42, enabled: false, label: null });
});

Deno.test("resolveDatastoreExpressions: resolves env expression in flat config", async () => {
  await withMockedEnv(
    { SWAMP_TEST_DS_EXPR_TOKEN: "my-secret-token" },
    async () => {
      const config = { token: "${{ env.SWAMP_TEST_DS_EXPR_TOKEN }}" };
      const result = await resolveDatastoreExpressions(config, baseContext());
      assertEquals(result, { token: "my-secret-token" });
    },
  );
});

Deno.test("resolveDatastoreExpressions: resolves env expression in nested config", async () => {
  await withMockedEnv({ SWAMP_TEST_DS_EXPR_NESTED: "secret-val" }, async () => {
    const config = {
      connection: { token: "${{ env.SWAMP_TEST_DS_EXPR_NESTED }}" },
    };
    const result = await resolveDatastoreExpressions(config, baseContext());
    assertEquals(result, { connection: { token: "secret-val" } });
  });
});

Deno.test("resolveDatastoreExpressions: resolves env expressions in arrays", async () => {
  await withMockedEnv({
    SWAMP_TEST_DS_EXPR_A: "host-a",
    SWAMP_TEST_DS_EXPR_B: "host-b",
  }, async () => {
    const config = {
      hosts: [
        "${{ env.SWAMP_TEST_DS_EXPR_A }}",
        "${{ env.SWAMP_TEST_DS_EXPR_B }}",
      ],
    };
    const result = await resolveDatastoreExpressions(config, baseContext());
    assertEquals(result, { hosts: ["host-a", "host-b"] });
  });
});

Deno.test("resolveDatastoreExpressions: interpolates multiple expressions in one string", async () => {
  await withMockedEnv({
    SWAMP_TEST_DS_EXPR_HOST: "db.example.com",
    SWAMP_TEST_DS_EXPR_PORT: "5432",
  }, async () => {
    const config = {
      url:
        "https://${{ env.SWAMP_TEST_DS_EXPR_HOST }}:${{ env.SWAMP_TEST_DS_EXPR_PORT }}/db",
    };
    const result = await resolveDatastoreExpressions(config, baseContext());
    assertEquals(result, { url: "https://db.example.com:5432/db" });
  });
});

Deno.test("resolveDatastoreExpressions: trims whitespace inside expression delimiters", async () => {
  await withMockedEnv({ SWAMP_TEST_DS_EXPR_WS: "trimmed" }, async () => {
    const config = { val: "${{  env.SWAMP_TEST_DS_EXPR_WS  }}" };
    const result = await resolveDatastoreExpressions(config, baseContext());
    assertEquals(result, { val: "trimmed" });
  });
});

Deno.test("resolveDatastoreExpressions: throws UserError for missing env var", async () => {
  await withMockedEnv({ SWAMP_TEST_DS_EXPR_MISSING: undefined }, async () => {
    const config = { token: "${{ env.SWAMP_TEST_DS_EXPR_MISSING }}" };
    await assertRejects(
      () => resolveDatastoreExpressions(config, baseContext()),
      UserError,
      "SWAMP_TEST_DS_EXPR_MISSING",
    );
  });
});

Deno.test("resolveDatastoreExpressions: throws UserError for empty env var", async () => {
  await withMockedEnv({ SWAMP_TEST_DS_EXPR_EMPTY: "" }, async () => {
    const config = { token: "${{ env.SWAMP_TEST_DS_EXPR_EMPTY }}" };
    await assertRejects(
      () => resolveDatastoreExpressions(config, baseContext()),
      UserError,
      "not set or empty",
    );
  });
});

Deno.test("resolveDatastoreExpressions: resolves vault.get with quoted args", async () => {
  const ctx = baseContext({
    vaultServiceFactory: mockVaultFactory({
      infra: { "db-password": "s3cret" },
    }),
  });
  const config = { password: '${{ vault.get("infra", "db-password") }}' };
  const result = await resolveDatastoreExpressions(config, ctx);
  assertEquals(result, { password: "s3cret" });
});

Deno.test("resolveDatastoreExpressions: resolves vault.get with unquoted args", async () => {
  const ctx = baseContext({
    vaultServiceFactory: mockVaultFactory({
      myVault: { token: "vault-token" },
    }),
  });
  const config = { token: "${{ vault.get(myVault, token) }}" };
  const result = await resolveDatastoreExpressions(config, ctx);
  assertEquals(result, { token: "vault-token" });
});

Deno.test("resolveDatastoreExpressions: resolves vault.get with single-quoted args", async () => {
  const ctx = baseContext({
    vaultServiceFactory: mockVaultFactory({
      v: { k: "single-quoted-val" },
    }),
  });
  const config = { secret: "${{ vault.get('v', 'k') }}" };
  const result = await resolveDatastoreExpressions(config, ctx);
  assertEquals(result, { secret: "single-quoted-val" });
});

Deno.test("resolveDatastoreExpressions: throws UserError when vault not found", async () => {
  const ctx = baseContext({
    vaultServiceFactory: mockVaultFactory({}),
  });
  const config = { token: '${{ vault.get("missing", "key") }}' };
  await assertRejects(
    () => resolveDatastoreExpressions(config, ctx),
    UserError,
    "Failed to resolve vault expression",
  );
});

Deno.test("resolveDatastoreExpressions: throws UserError when secret not found", async () => {
  const ctx = baseContext({
    vaultServiceFactory: mockVaultFactory({
      infra: { "other-key": "val" },
    }),
  });
  const config = { token: '${{ vault.get("infra", "missing-key") }}' };
  await assertRejects(
    () => resolveDatastoreExpressions(config, ctx),
    UserError,
    "Failed to resolve vault expression",
  );
});

Deno.test("resolveDatastoreExpressions: resolves both env and vault in different fields", async () => {
  await withMockedEnv({ SWAMP_TEST_DS_EXPR_MIX: "env-val" }, async () => {
    const ctx = baseContext({
      vaultServiceFactory: mockVaultFactory({
        v: { k: "vault-val" },
      }),
    });
    const config = {
      host: "${{ env.SWAMP_TEST_DS_EXPR_MIX }}",
      token: "${{ vault.get(v, k) }}",
    };
    const result = await resolveDatastoreExpressions(config, ctx);
    assertEquals(result, { host: "env-val", token: "vault-val" });
  });
});

Deno.test("resolveDatastoreExpressions: interpolates env and vault in one string", async () => {
  await withMockedEnv({ SWAMP_TEST_DS_EXPR_PREFIX: "prod" }, async () => {
    const ctx = baseContext({
      vaultServiceFactory: mockVaultFactory({
        v: { k: "abc123" },
      }),
    });
    const config = {
      url: "${{ env.SWAMP_TEST_DS_EXPR_PREFIX }}-${{ vault.get(v, k) }}",
    };
    const result = await resolveDatastoreExpressions(config, ctx);
    assertEquals(result, { url: "prod-abc123" });
  });
});

Deno.test("resolveDatastoreExpressions: throws UserError for unsupported expression", async () => {
  const config = { val: "${{ foo.bar }}" };
  await assertRejects(
    () => resolveDatastoreExpressions(config, baseContext()),
    UserError,
    "Unsupported expression",
  );
});

Deno.test("resolveDatastoreExpressions: managedConfig blocks vault expressions", async () => {
  const ctx = baseContext({
    managedConfig: true,
    vaultServiceFactory: mockVaultFactory({ v: { k: "val" } }),
  });
  const config = { token: "${{ vault.get(v, k) }}" };
  await assertRejects(
    () => resolveDatastoreExpressions(config, ctx),
    UserError,
    "managedConfig",
  );
});

Deno.test("resolveDatastoreExpressions: managedConfig allows env expressions", async () => {
  await withMockedEnv({ SWAMP_TEST_DS_EXPR_MC: "allowed" }, async () => {
    const ctx = baseContext({ managedConfig: true });
    const config = { token: "${{ env.SWAMP_TEST_DS_EXPR_MC }}" };
    const result = await resolveDatastoreExpressions(config, ctx);
    assertEquals(result, { token: "allowed" });
  });
});

Deno.test("resolveDatastoreExpressions: partial expression syntax passes through", async () => {
  const config = { val: "token-${{ env.X" };
  const result = await resolveDatastoreExpressions(config, baseContext());
  assertEquals(result, { val: "token-${{ env.X" });
});

Deno.test("resolveDatastoreExpressions: non-string config values pass through", async () => {
  const config = { port: 5432, ssl: true, timeout: null as unknown };
  const result = await resolveDatastoreExpressions(config, baseContext());
  assertEquals(result, { port: 5432, ssl: true, timeout: null });
});

Deno.test("resolveDatastoreExpressions: deeply nested config resolves at all levels", async () => {
  await withMockedEnv({ SWAMP_TEST_DS_EXPR_DEEP: "deep-val" }, async () => {
    const config = {
      level1: {
        level2: {
          level3: { secret: "${{ env.SWAMP_TEST_DS_EXPR_DEEP }}" },
        },
      },
    };
    const result = await resolveDatastoreExpressions(config, baseContext());
    assertEquals(result, {
      level1: { level2: { level3: { secret: "deep-val" } } },
    });
  });
});

Deno.test("resolveDatastoreExpressions: never imports bundles from install staging", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_ds_expr_staging_" });
  try {
    const marker = `__swamp_staging_imported_${
      crypto.randomUUID().slice(0, 8)
    }`;
    const staging = join(
      repoDir,
      ".swamp",
      "vault-bundles",
      `.swamp-staging-${crypto.randomUUID()}`,
    );
    await Deno.mkdir(staging, { recursive: true });
    const source =
      `globalThis["${marker}"] = true;\nexport const vault = {};\n`;
    await Deno.writeTextFile(join(staging, "v.js"), source);

    await assertRejects(
      () =>
        resolveDatastoreExpressions(
          { token: "${{ vault.get(missing, key) }}" },
          { repoDir },
        ),
      UserError,
    );
    assertEquals((globalThis as Record<string, unknown>)[marker], undefined);
    assertEquals(await Deno.readTextFile(join(staging, "v.js")), source);
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
});

async function makeTempRepo(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "swamp_ds_expr_vault_type_" });
}

async function removeTempRepo(repoDir: string): Promise<void> {
  await Deno.remove(repoDir, { recursive: true }).catch(() => {});
}

function uniqueExtensionVaultType(): string {
  return `@t${crypto.randomUUID().slice(0, 8)}/vault`;
}

async function writeVaultDef(
  repoDir: string,
  name: string,
  type: string,
  config: Record<string, unknown>,
): Promise<void> {
  const id = crypto.randomUUID();
  const dir = join(repoDir, "vaults", type);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, `${id}.yaml`),
    JSON.stringify({
      id,
      name,
      type,
      config,
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
}

function registerMockVaultType(type: string): void {
  vaultTypeRegistry.register({
    type,
    name: type,
    description: "test extension vault type",
    isBuiltIn: false,
    createProvider: (name, config) =>
      new MockVaultProvider(name, config as Record<string, string>),
  });
}

function installingResolver(calls: string[]) {
  return {
    resolve: (type: string): Promise<boolean> => {
      calls.push(type);
      registerMockVaultType(type);
      return Promise.resolve(true);
    },
  };
}

Deno.test("resolveDatastoreExpressions: auto-resolves the missing extension type of a vault.get target once", async () => {
  const repoDir = await makeTempRepo();
  const type = uniqueExtensionVaultType();
  try {
    await writeVaultDef(repoDir, "dsauth", type, { DIR: "secret-dir" });
    const calls: string[] = [];
    const result = await resolveDatastoreExpressions(
      {
        first: "${{ vault.get(dsauth, DIR) }}",
        second: "${{ vault.get(dsauth, DIR) }}",
      },
      { repoDir, autoResolver: installingResolver(calls) },
    );
    assertEquals(result, { first: "secret-dir", second: "secret-dir" });
    assertEquals(calls, [type]);
  } finally {
    vaultTypeRegistry.invalidateType(type);
    await removeTempRepo(repoDir);
  }
});

Deno.test("resolveDatastoreExpressions: a later resolution uses the auto-resolved type without resolving again", async () => {
  const repoDir = await makeTempRepo();
  const type = uniqueExtensionVaultType();
  try {
    await writeVaultDef(repoDir, "dsauth", type, { DIR: "secret-dir" });
    const calls: string[] = [];
    const ctx = { repoDir, autoResolver: installingResolver(calls) };
    const config = { dir: "${{ vault.get(dsauth, DIR) }}" };
    await resolveDatastoreExpressions(config, ctx);
    const result = await resolveDatastoreExpressions(config, ctx);
    assertEquals(result, { dir: "secret-dir" });
    assertEquals(calls, [type]);
  } finally {
    vaultTypeRegistry.invalidateType(type);
    await removeTempRepo(repoDir);
  }
});

Deno.test("resolveDatastoreExpressions: never auto-resolves the type of a vault no vault.get names", async () => {
  const repoDir = await makeTempRepo();
  const used = uniqueExtensionVaultType();
  const unused = uniqueExtensionVaultType();
  try {
    await writeVaultDef(repoDir, "dsauth", used, { DIR: "secret-dir" });
    await writeVaultDef(repoDir, "other", unused, {});
    const calls: string[] = [];
    await resolveDatastoreExpressions(
      { dir: "${{ vault.get(dsauth, DIR) }}" },
      { repoDir, autoResolver: installingResolver(calls) },
    );
    assertEquals(calls, [used]);
  } finally {
    vaultTypeRegistry.invalidateType(used);
    vaultTypeRegistry.invalidateType(unused);
    await removeTempRepo(repoDir);
  }
});

Deno.test("resolveDatastoreExpressions: without an auto-resolver names the uninstalled vault type and the pull command", async () => {
  const repoDir = await makeTempRepo();
  const type = uniqueExtensionVaultType();
  try {
    await writeVaultDef(repoDir, "dsauth", type, {});
    const error = await assertRejects(
      () =>
        resolveDatastoreExpressions(
          { dir: "${{ vault.get(dsauth, DIR) }}" },
          { repoDir },
        ),
      UserError,
    );
    assertStringIncludes(error.message, `vault type '${type}'`);
    assertStringIncludes(error.message, `swamp extension pull ${type}`);
  } finally {
    await removeTempRepo(repoDir);
  }
});

Deno.test("resolveDatastoreExpressions: an auto-resolver that cannot install the type yields the pull command", async () => {
  const repoDir = await makeTempRepo();
  const type = uniqueExtensionVaultType();
  try {
    await writeVaultDef(repoDir, "dsauth", type, {});
    const calls: string[] = [];
    const error = await assertRejects(
      () =>
        resolveDatastoreExpressions(
          { dir: "${{ vault.get(dsauth, DIR) }}" },
          {
            repoDir,
            autoResolver: {
              resolve: (t) => {
                calls.push(t);
                return Promise.reject(new Error("registry unreachable"));
              },
            },
          },
        ),
      UserError,
    );
    assertEquals(calls, [type]);
    assertStringIncludes(error.message, `swamp extension pull ${type}`);
  } finally {
    await removeTempRepo(repoDir);
  }
});

Deno.test("resolveDatastoreExpressions: a vault skipped for its config reports that error", async () => {
  const repoDir = await makeTempRepo();
  const type = uniqueExtensionVaultType();
  vaultTypeRegistry.register({
    type,
    name: type,
    description: "test extension vault type with required config",
    isBuiltIn: false,
    configSchema: z.object({ token: z.string().describe("API token") }),
    createProvider: (name) => new MockVaultProvider(name),
  });
  try {
    await writeVaultDef(repoDir, "dsauth", type, {});
    const calls: string[] = [];
    const error = await assertRejects(
      () =>
        resolveDatastoreExpressions(
          { dir: "${{ vault.get(dsauth, DIR) }}" },
          { repoDir, autoResolver: installingResolver(calls) },
        ),
      UserError,
    );
    assertEquals(calls, []);
    assertStringIncludes(error.message, "could not be loaded");
    assertStringIncludes(error.message, "token");
  } finally {
    vaultTypeRegistry.invalidateType(type);
    await removeTempRepo(repoDir);
  }
});

Deno.test("resolveDatastoreExpressions: auto-resolving a vault type never runs the vault type registry loader", async () => {
  const repoDir = await makeTempRepo();
  const type = uniqueExtensionVaultType();
  let loaderRuns = 0;
  vaultTypeRegistry.setLoader(() => {
    loaderRuns++;
    return Promise.resolve();
  });
  vaultTypeRegistry.setTypeLoader(() => {
    loaderRuns++;
    return Promise.resolve();
  });
  try {
    await writeVaultDef(repoDir, "dsauth", type, { DIR: "secret-dir" });
    await resolveDatastoreExpressions(
      { dir: "${{ vault.get(dsauth, DIR) }}" },
      { repoDir, autoResolver: installingResolver([]) },
    );
    assertEquals(loaderRuns, 0);
  } finally {
    vaultTypeRegistry.clearLoadersForTesting();
    vaultTypeRegistry.invalidateType(type);
    await removeTempRepo(repoDir);
  }
});

Deno.test("resolveDatastoreExpressions: a cached vault bundle that imports zod loads before any extension loader ran", async () => {
  const repoDir = await makeTempRepo();
  const type = uniqueExtensionVaultType();
  const previousZod = globalThis.__swamp_zod;
  globalThis.__swamp_zod = undefined;
  try {
    const bundleDir = join(repoDir, ".swamp", "vault-bundles", "abc12345");
    await Deno.mkdir(bundleDir, { recursive: true });
    await Deno.writeTextFile(
      join(bundleDir, "v.js"),
      `import { z } from "zod";
export const vault = {
  type: ${JSON.stringify(type)},
  configSchema: z.object({ DIR: z.string() }),
  createProvider(name, config) {
    return {
      getName: () => name,
      get: (key) => Promise.resolve(config[key]),
      put: () => Promise.resolve(),
      list: () => Promise.resolve(Object.keys(config)),
    };
  },
};
`,
    );
    await writeVaultDef(repoDir, "dsauth", type, { DIR: "bundled-dir" });
    const result = await resolveDatastoreExpressions(
      { dir: "${{ vault.get(dsauth, DIR) }}" },
      { repoDir },
    );
    assertEquals(result, { dir: "bundled-dir" });
  } finally {
    globalThis.__swamp_zod = previousZod;
    vaultTypeRegistry.invalidateType(type);
    await removeTempRepo(repoDir);
  }
});

Deno.test("resolveDatastoreExpressions: a failing definition never displaces a same-named vault that registered", async () => {
  const repoDir = await makeTempRepo();
  const working = uniqueExtensionVaultType();
  const missing = uniqueExtensionVaultType();
  registerMockVaultType(working);
  try {
    await writeVaultDef(repoDir, "dsauth", working, { DIR: "working-dir" });
    await writeVaultDef(repoDir, "dsauth", missing, { DIR: "other-dir" });
    const calls: string[] = [];
    const result = await resolveDatastoreExpressions(
      { dir: "${{ vault.get(dsauth, DIR) }}" },
      { repoDir, autoResolver: installingResolver(calls) },
    );
    assertEquals(result, { dir: "working-dir" });
    assertEquals(calls, []);
  } finally {
    vaultTypeRegistry.invalidateType(working);
    vaultTypeRegistry.invalidateType(missing);
    await removeTempRepo(repoDir);
  }
});
