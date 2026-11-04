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
import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { Data } from "../src/domain/data/data.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { VaultConfig } from "../src/domain/vaults/vault_config.ts";
import { vaultTypeRegistry } from "../src/domain/vaults/vault_type_registry.ts";
import { DATASTORE_FORMAT_MARKER_FILE } from "../src/domain/datastore/datastore_format.ts";
import {
  EngineProfileError,
  EngineRepositoryNotInitializedError,
} from "../src/engine/profile.ts";
import { createLocalEngineContext } from "../src/serve/local_engine_context.ts";
import { SERVE_ENV_MAP } from "../src/serve/serve_config.ts";
import {
  assertPathEquals,
  withMockedEnv,
} from "../src/infrastructure/persistence/path_test_helpers.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { YamlVaultConfigRepository } from "../src/infrastructure/persistence/yaml_vault_config_repository.ts";

await initializeLogging({});

async function fixture(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "local-engine-context-" });
  try {
    await Deno.mkdir(join(dir, ".swamp"));
    await Deno.writeTextFile(
      join(dir, ".swamp.yaml"),
      "swampVersion: 0.0.0\ninitializedAt: 2026-01-01T00:00:00.000Z\nautoGc: true\n",
    );
    await Deno.writeTextFile(
      join(dir, ".swamp", "serve.yaml"),
      "auth:\n  mode: token\n  admins: [user:operator]\n",
    );
    const environment: Record<string, string | undefined> = Object.fromEntries(
      [
        ...Object.values(SERVE_ENV_MAP),
        "SWAMP_DATASTORE",
        "SWAMP_EXTENSIONS_DIR",
        "SWAMP_WORKFLOWS_DIR",
        "SWAMP_MODELS_DIR",
        "SWAMP_BEHAVIORS_DIR",
        "SWAMP_REPORTS_DIR",
        "SWAMP_VAULTS_DIR",
      ].map((name) => [name, undefined]),
    );
    await withMockedEnv(environment, () => run(dir));
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("createLocalEngineContext: missing marker reports repository recovery before persistence", async () => {
  await fixture(async (dir) => {
    await Deno.remove(join(dir, ".swamp.yaml"));
    const error = await assertRejects(
      () => createLocalEngineContext(dir),
      EngineRepositoryNotInitializedError,
      "Select an initialized repository with --repo, or restore its .swamp.yaml file.",
    );
    assertEquals(error.code, "repository_not_initialized");
    await assertRejects(
      () => Deno.stat(join(dir, ".swamp", "_extension_catalog.db")),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("createLocalEngineContext: local composition preserves policy and disposes services twice safely", async () => {
  await fixture(async (dir) => {
    await Deno.writeTextFile(
      join(dir, ".swamp", "serve.yaml"),
      "auth:\n  mode: token\n  admins: [user:operator]\n",
    );
    const composed = await createLocalEngineContext(dir);
    try {
      assertEquals(composed.context.authConfig.mode, "token");
      assertEquals(composed.context.repoContext.autoGc, true);
      assertEquals(composed.context.activeRunRegistry?.size, 0);
      assertEquals(composed.context.policySnapshotLoader !== undefined, true);
    } finally {
      await composed.dispose();
      await composed.dispose();
    }
  });
});

Deno.test("createLocalEngineContext: late startup failure stops pollers and releases database handles", async () => {
  await fixture(async (dir) => {
    await Deno.writeTextFile(
      join(dir, ".swamp", "serve.yaml"),
      "auth:\n  mode: token\n  admins: [user:operator]\naudit:\n  stores:\n    - target: events\n  wal:\n    directory: .swamp/blocked-wal\n",
    );
    await Deno.writeTextFile(
      join(dir, ".swamp", "blocked-wal"),
      "not a directory",
    );
    await assertRejects(() => createLocalEngineContext(dir));
    // A fresh context can reopen the same repositories after the failed one.
    await Deno.writeTextFile(
      join(dir, ".swamp", "serve.yaml"),
      "auth:\n  mode: token\n  admins: [user:operator]\n",
    );
    const next = await createLocalEngineContext(dir);
    await next.dispose();
  });
});

Deno.test("createLocalEngineContext: profile preflight precedes vault import, provider construction and reads", async (t) => {
  await fixture(async (dir) => {
    const type = `@test/preflight-${crypto.randomUUID()}`;
    const imported = join(dir, "vault-imported");
    const constructed = join(dir, "vault-constructed");
    const read = join(dir, "vault-read");
    const bundleDir = join(dir, ".swamp", "vault-bundles", "cached");
    await Deno.mkdir(bundleDir, { recursive: true });
    await Deno.writeTextFile(
      join(bundleDir, "provider.js"),
      `await Deno.writeTextFile(${JSON.stringify(imported)}, "imported");
export const vault = {
  type: ${
        JSON.stringify(type)
      }, name: "preflight", description: "preflight sentinel",
  createProvider() {
    Deno.writeTextFileSync(${JSON.stringify(constructed)}, "constructed");
    return {
      async get(key) {
        await Deno.writeTextFile(${JSON.stringify(read)}, "read");
        return key === "namespace" ? "" : "outputs";
      },
      async put() {}, async list() { return []; }, getName() { return "preflight"; },
    };
  },
};`,
    );
    await new YamlVaultConfigRepository(dir).save(
      VaultConfig.create(crypto.randomUUID(), "preflight", type, {}),
    );
    const baseStore = {
      type: "filesystem",
      path: "store",
      directories: ['${{ vault.get("preflight", "route") }}'],
    };
    const baseServe = { auth: { mode: "token", admins: ["user:operator"] } };
    const configure = async (datastore: object, serve: object) => {
      await Deno.writeTextFile(
        join(dir, ".swamp.yaml"),
        JSON.stringify({
          swampVersion: "0.0.0",
          initializedAt: "2026-01-01T00:00:00.000Z",
          datastore: { ...baseStore, ...datastore },
        }),
      );
      await Deno.writeTextFile(
        join(dir, ".swamp", "serve.yaml"),
        JSON.stringify({ ...baseServe, ...serve }),
      );
    };
    try {
      for (
        const [name, datastore, serve] of [
          ["format 3", { format: 3 }, {}],
          ["namespace", { namespace: "shared" }, {}],
          ["empty namespace", { namespace: "" }, {}],
          ["namespace expression resolving empty", {
            namespace: '${{ vault.get("preflight", "namespace") }}',
          }, {}],
          ["schedule", {}, { schedule: true }],
          ["listener", {}, { port: 12345 }],
        ] as const
      ) {
        await t.step(name, async () => {
          await configure(datastore, serve);
          await assertRejects(
            () => createLocalEngineContext(dir),
            EngineProfileError,
          );
          for (const path of [imported, constructed, read]) {
            await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
          }
          await assertRejects(
            () => Deno.stat(join(dir, ".swamp", "_extension_catalog.db")),
            Deno.errors.NotFound,
          );
        });
      }
      await t.step("format 3 marker at an expanded path", async () => {
        const store = join(dir, "expanded-store");
        await Deno.mkdir(store);
        await Deno.writeTextFile(
          join(store, DATASTORE_FORMAT_MARKER_FILE),
          JSON.stringify({ format: 3 }),
        );
        await configure({ path: "${SWAMP_ENGINE_PREFLIGHT_STORE}" }, {});
        await withMockedEnv(
          { SWAMP_ENGINE_PREFLIGHT_STORE: store },
          async () => {
            await assertRejects(
              () => createLocalEngineContext(dir),
              EngineProfileError,
              "local-v1 requires datastore format 2",
            );
          },
        );
        for (const path of [imported, constructed, read]) {
          await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
        }
        await assertRejects(
          () => Deno.stat(join(dir, ".swamp", "_extension_catalog.db")),
          Deno.errors.NotFound,
        );
      });
      // Prove this is a live cached provider fixture, not an inert expression.
      await configure({}, {});
      const composed = await createLocalEngineContext(dir);
      try {
        assertEquals(await Deno.readTextFile(imported), "imported");
        assertEquals(await Deno.readTextFile(constructed), "constructed");
        assertEquals(await Deno.readTextFile(read), "read");
        assertPathEquals(
          composed.context.datastoreResolver.resolvePath("outputs", "run.yaml"),
          join(dir, "store", "outputs", "run.yaml"),
        );
      } finally {
        await composed.dispose();
      }
    } finally {
      vaultTypeRegistry.invalidateType(type);
    }
  });
});

Deno.test("createLocalEngineContext: resolved datastore field expressions route external output and local data", async () => {
  await fixture(async (dir) => {
    const store = join(dir, "external-store");
    await Deno.writeTextFile(
      join(dir, ".swamp.yaml"),
      JSON.stringify({
        swampVersion: "0.0.0",
        initializedAt: "2026-01-01T00:00:00.000Z",
        datastore: {
          type: "filesystem",
          path: store,
          directories: ["${{ env.SWAMP_ENGINE_DIRECTORY }}"],
          exclude: ["${{ env.SWAMP_ENGINE_EXCLUSION }}"],
        },
      }),
    );
    await withMockedEnv({
      SWAMP_ENGINE_DIRECTORY: "outputs",
      SWAMP_ENGINE_EXCLUSION: "outputs/private/**",
    }, async () => {
      const composed = await createLocalEngineContext(dir);
      try {
        const resolver = composed.context.datastoreResolver;
        assertPathEquals(
          resolver.resolvePath("outputs", "run.yaml"),
          join(store, "outputs", "run.yaml"),
        );
        assertPathEquals(
          resolver.resolvePath("outputs", "private", "run.yaml"),
          join(dir, ".swamp", "outputs", "private", "run.yaml"),
        );
        const type = ModelType.create("command/shell");
        const modelId = crypto.randomUUID();
        const data = Data.create({
          name: "local-data",
          contentType: "text/plain",
          lifetime: "infinite",
          garbageCollection: 1,
          tags: { type: "resource" },
          ownerDefinition: {
            ownerType: "model-method",
            ownerRef: `${type.normalized}:${modelId}`,
          },
        });
        const content = new TextEncoder().encode("local data");
        await composed.context.repoContext.unifiedDataRepo.save(
          type,
          modelId,
          data,
          content,
        );
        assertEquals(
          (await Deno.stat(join(dir, ".swamp", "data"))).isDirectory,
          true,
        );
        await assertRejects(
          () => Deno.stat(join(store, "data")),
          Deno.errors.NotFound,
        );
        assertEquals(
          await composed.context.repoContext.unifiedDataRepo.getContent(
            type,
            modelId,
            data.name,
          ),
          content,
        );
      } finally {
        await composed.dispose();
      }
    });
  });
});

for (
  const config of [
    { path: "store" },
    { type: "filesystem" },
    { type: "filesystem", path: "" },
    { type: "filesystem", path: "store", format: 1 },
    { type: "filesystem", path: "store", format: "2" },
  ]
) {
  Deno.test(`createLocalEngineContext: malformed filesystem block refuses before persistence (${JSON.stringify(config)})`, async () => {
    await fixture(async (dir) => {
      await Deno.writeTextFile(
        join(dir, ".swamp.yaml"),
        JSON.stringify({
          swampVersion: "0.0.0",
          initializedAt: "2026-01-01T00:00:00.000Z",
          datastore: config,
        }),
      );
      await assertRejects(() => createLocalEngineContext(dir));
      await assertRejects(
        () => Deno.stat(join(dir, ".swamp", "_extension_catalog.db")),
        Deno.errors.NotFound,
      );
    });
  });
}

for (const name of ["SWAMP_DATASTORE", "SWAMP_EXTENSIONS_DIR"]) {
  Deno.test(`createLocalEngineContext: refuses nonempty ${name} before opening persistence`, async () => {
    await fixture(async (dir) => {
      await withMockedEnv({ [name]: "unsupported override" }, async () => {
        await assertRejects(
          () => createLocalEngineContext(dir),
          EngineProfileError,
          `${name} overrides`,
        );
        await assertRejects(
          () => Deno.stat(join(dir, ".swamp", "_extension_catalog.db")),
          Deno.errors.NotFound,
        );
      });
      await withMockedEnv({ [name]: "" }, async () => {
        const composed = await createLocalEngineContext(dir);
        await composed.dispose();
      });
    });
  });
}

Deno.test("createLocalEngineContext: conflicting model directory aliases refuse before opening persistence; matching aliases are accepted", async () => {
  await fixture(async (dir) => {
    await withMockedEnv({
      SWAMP_MODELS_DIR: "extensions/first",
      SWAMP_BEHAVIORS_DIR: "extensions/second",
    }, async () => {
      await assertRejects(
        () => createLocalEngineContext(dir),
        EngineProfileError,
        "Set only one variable, or set both to the same value.",
      );
      await assertRejects(
        () => Deno.stat(join(dir, ".swamp", "_extension_catalog.db")),
        Deno.errors.NotFound,
      );
    });
    await withMockedEnv({
      SWAMP_MODELS_DIR: "extensions/same",
      SWAMP_BEHAVIORS_DIR: "extensions/same",
    }, async () => {
      const composed = await createLocalEngineContext(dir);
      await composed.dispose();
    });
  });
});

for (
  const path of ["~/store", "$HOME/store", "${SWAMP_ENGINE_DATA_ROOT}/store"]
) {
  Deno.test(`createLocalEngineContext: expands ${path} before repository writes and format validation`, async () => {
    await fixture(async (dir) => {
      const home = join(dir, "account-home");
      const store = join(home, "store");
      await Deno.mkdir(store, { recursive: true });
      await Deno.writeTextFile(
        join(dir, ".swamp.yaml"),
        "swampVersion: 0.0.0\ninitializedAt: 2026-01-01T00:00:00.000Z\n" +
          `datastore:\n  type: filesystem\n  path: ${JSON.stringify(path)}\n`,
      );
      await Deno.writeTextFile(
        join(store, DATASTORE_FORMAT_MARKER_FILE),
        JSON.stringify({ format: 2 }),
      );
      await withMockedEnv(
        { HOME: home, SWAMP_ENGINE_DATA_ROOT: home },
        async () => {
          const composed = await createLocalEngineContext(dir);
          try {
            assertPathEquals(
              composed.context.datastoreResolver.datastorePath(),
              store,
            );
            const type = ModelType.create("command/shell");
            const modelId = crypto.randomUUID();
            const data = Data.create({
              name: "expanded-store",
              contentType: "text/plain",
              lifetime: "infinite",
              garbageCollection: 1,
              tags: { type: "resource" },
              ownerDefinition: {
                ownerType: "model-method",
                ownerRef: `${type.normalized}:${modelId}`,
              },
            });
            const content = new TextEncoder().encode(
              "persisted in expanded store",
            );
            await composed.context.repoContext.unifiedDataRepo.save(
              type,
              modelId,
              data,
              content,
            );
            assertEquals(
              (await Deno.stat(join(store, "data"))).isDirectory,
              true,
            );
            assertEquals(
              await composed.context.repoContext.unifiedDataRepo.getContent(
                type,
                modelId,
                data.name,
              ),
              content,
            );
          } finally {
            await composed.dispose();
          }
          await Deno.writeTextFile(
            join(store, DATASTORE_FORMAT_MARKER_FILE),
            JSON.stringify({ format: 3 }),
          );
          await assertRejects(
            () => createLocalEngineContext(dir),
            EngineProfileError,
            "local-v1 requires datastore format 2",
          );
        },
      );
    });
  });
}
