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
 * The v3 gate for the vault config repository (swamp-club#3257). The real
 * repository runs on v3 inside a commit-log root, with managed config
 * registered at the namespace root's `config` directory, solo and
 * namespaced. Its writes stage #3256's definition changes with kind
 * `vault`; the unit commits them to a real `commits.db` and filesystem
 * `storage/1`, and a read model catches up into a second directory, whose
 * vault configs (bytes) must equal what the repository wrote. No commit
 * carries a secret or an absolute path, and a repo-local vault config
 * (what repo init writes) stages nothing.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import {
  type Namespace,
  restoreNamespace,
  SOLO_NAMESPACE,
} from "../src/domain/data/namespace.ts";
import { CommitRejectedError } from "../src/domain/datastore_v3/partition.ts";
import { partitionOf } from "../src/domain/datastore_v3/partition_key.ts";
import { createDefaultVaultConfig } from "../src/domain/vaults/default_vault.ts";
import { LocalEncryptionVaultProvider } from "../src/domain/vaults/local_encryption_vault_provider.ts";
import { VaultConfig } from "../src/domain/vaults/vault_config.ts";
import { runInCommitLogRoot } from "../src/infrastructure/datastore_v3/commit_log_root.ts";
import {
  contextHook,
  unitOptions,
} from "../src/infrastructure/datastore_v3/commit_log_test_helpers.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  registerManagedConfig,
  swampPath,
} from "../src/infrastructure/persistence/paths.ts";
import { recordingUnitOfWork } from "../src/infrastructure/persistence/test_helpers/staged_change_helpers.ts";
import { runInUnitOfWork } from "../src/infrastructure/persistence/unit_of_work_scope.ts";
import { YamlVaultConfigRepository } from "../src/infrastructure/persistence/yaml_vault_config_repository.ts";
import {
  catalogV3Path,
  readCatalog,
  readTree,
  type V3Env,
  withV3Env,
} from "./datastore_v3_read_model_helpers.ts";

await initializeLogging({});

const SECRET = "s3cr3t-value-never-committed";

/** One v3 repository context's vault config repository. */
class VaultWriter {
  readonly dir: string;
  readonly root: string;
  readonly hook = contextHook();
  readonly namespace: Namespace;

  constructor(
    readonly env: V3Env,
    readonly namespaceName: string,
    name = "writer",
  ) {
    this.dir = join(env.dir, name);
    this.namespace = namespaceName === ""
      ? SOLO_NAMESPACE
      : restoreNamespace(namespaceName);
    this.root = namespaceName === ""
      ? swampPath(this.dir)
      : swampPath(this.dir, namespaceName);
    registerManagedConfig(this.dir, true, join(this.root, "config"));
  }

  get vaultsDir(): string {
    return join(this.root, "config", "vaults");
  }

  vaults(hook: typeof this.hook | undefined = this.hook) {
    return new YamlVaultConfigRepository(
      this.dir,
      undefined,
      this.vaultsDir,
      hook,
    );
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    return runInCommitLogRoot(
      { markDirty: this.hook },
      unitOptions(this.env.store, this.env.storage, {
        namespace: this.namespace,
        signal: AbortSignal.timeout(60_000),
      }),
      fn,
    );
  }

  /** Catches the read model up; its vault configs must equal the writer's. */
  async assertMatches(): Promise<void> {
    await catchUp(this.env);
    assertEquals(
      await readTree(
        join(this.env.cacheRoot(this.namespaceName), "config", "vaults"),
      ),
      await readTree(this.vaultsDir),
    );
    assertEquals(readCatalog(catalogV3Path(this.env)).rows, []);
  }
}

async function catchUp(env: V3Env): Promise<void> {
  const readModel = env.openReadModel();
  try {
    await readModel.catchUp(AbortSignal.timeout(60_000));
  } finally {
    await readModel.close();
  }
}

/** Every committed put's content, decoded, in feed order. */
async function committedContents(env: V3Env): Promise<string[]> {
  const contents: string[] = [];
  for (const change of await env.store.changesSince(0, 10_000)) {
    for (const op of change.commit.ops) {
      if (op.kind === "put" && "inline" in op.content) {
        contents.push(
          new TextDecoder().decode(
            Uint8Array.from(atob(op.content.inline), (c) => c.charCodeAt(0)),
          ),
        );
      }
    }
  }
  return contents;
}

async function feedPartitions(env: V3Env): Promise<string[]> {
  return (await env.store.changesSince(0, 10_000)).map((change) =>
    change.commit.partition.toString()
  );
}

const configVault = (name: string) =>
  partitionOf({ kind: "config", definitionKind: "vault", name }).toString();

function vault(
  name: string,
  type = "local_encryption",
  config: Record<string, unknown> = { auto_generate: true },
): VaultConfig {
  return VaultConfig.create(crypto.randomUUID(), name, type, config);
}

/** The same vault (same id) under another name, type or config. */
function changed(
  from: VaultConfig,
  changes: Partial<ReturnType<VaultConfig["toData"]>>,
): VaultConfig {
  return VaultConfig.fromData({ ...from.toData(), ...changes });
}

for (const namespace of ["", "infra"]) {
  const label = namespace === "" ? "an unnamespaced" : "a namespaced";

  Deno.test(`v3 vault staging: vault config writes match the read model for ${label} datastore`, async () => {
    await withV3Env(async (env) => {
      const writer = new VaultWriter(env, namespace);
      const repo = writer.vaults();

      // Create, edit, and an unchanged save, which stages nothing.
      const prod = vault("prod");
      await writer.run(() => repo.save(prod));
      const edited = changed(prod, { config: { auto_generate: false } });
      await writer.run(() => repo.save(edited));
      const before = (await feedPartitions(env)).length;
      await writer.run(() => repo.save(edited));
      assertEquals((await feedPartitions(env)).length, before);
      await writer.assertMatches();

      // A rename: the new name's partition first, then the old name's.
      const renamed = changed(edited, { name: "production" });
      await writer.run(() => repo.save(renamed));
      assertEquals((await feedPartitions(env)).slice(before), [
        configVault("production"),
        configVault("prod"),
      ]);
      await writer.assertMatches();

      // A migration to another type: a create at the new type's path, then
      // the old file's removal, both in the vault name's partition.
      const migrated = changed(renamed, {
        type: "@test/other-vault",
        config: {},
      });
      await writer.run(async () => {
        await repo.save(migrated);
        await repo.delete(renamed);
      });
      await writer.assertMatches();

      // The default vault repo init creates names no host path.
      const defaults = createDefaultVaultConfig();
      await writer.run(() => repo.save(defaults));
      await writer.assertMatches();

      // Delete.
      await writer.run(async () => {
        await repo.delete(migrated);
        await repo.delete(defaults);
      });
      await writer.assertMatches();

      for (const content of await committedContents(env)) {
        assert(!content.includes(env.dir), content);
        assert(!content.includes(SECRET), content);
      }
    });
  });
}

Deno.test("v3 vault staging: a secret stored through the vault provider, and a repo-local vault config as repo init writes it, commit nothing", async () => {
  await withV3Env(async (env) => {
    const writer = new VaultWriter(env, "");
    await writer.run(() => writer.vaults().save(vault("keys")));
    const before = await feedPartitions(env);

    await writer.run(async () => {
      const provider = new LocalEncryptionVaultProvider("keys", {
        base_dir: writer.dir,
        auto_generate: true,
      });
      await provider.put("token", SECRET);
      assertEquals(await provider.get("token"), SECRET);
      // Repo init's default vault, in the repository's own vaults/.
      await new YamlVaultConfigRepository(
        writer.dir,
        undefined,
        join(writer.dir, "vaults"),
        writer.hook,
      ).save(createDefaultVaultConfig());
    });

    assertEquals(await feedPartitions(env), before);
    for (const content of await committedContents(env)) {
      assert(!content.includes(SECRET));
    }
  });
});

Deno.test("v3 vault staging: a stale edit from another checkout is refused, and the store keeps the other writer's bytes", async () => {
  await withV3Env(async (env) => {
    const first = new VaultWriter(env, "", "first");
    const second = new VaultWriter(env, "", "second");
    const prod = vault("prod");
    await first.run(() => first.vaults().save(prod));
    // The second checkout holds the same bytes, as a catch-up leaves them.
    const rel = join("local_encryption", `${prod.id}.yaml`);
    await ensureDir(join(second.vaultsDir, "local_encryption"));
    await Deno.copyFile(
      join(first.vaultsDir, rel),
      join(second.vaultsDir, rel),
    );

    await first.run(() =>
      first.vaults().save(changed(prod, { config: { auto_generate: false } }))
    );
    const error = await assertRejects(
      () =>
        second.run(() =>
          second.vaults().save(changed(prod, { config: { key_file: "k" } }))
        ),
      CommitRejectedError,
    );
    assertEquals(error.reason, "expect-failed");
    assert(error.message.includes(configVault("prod")));
    await catchUp(env);
    assertEquals(
      await Deno.readTextFile(
        join(env.cacheRoot(""), "config", "vaults", rel),
      ),
      await Deno.readTextFile(join(first.vaultsDir, rel)),
    );
  });
});

Deno.test({
  name:
    "v3 vault staging: v2 reads no vault file a v3 save or delete reads first, under no hook and a legacy unit",
  // An unreadable file stands for a read: chmod does not stop a read on
  // Windows or as root.
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    await withV3Env(async (env) => {
      const writer = new VaultWriter(env, "");
      const prod = vault("prod");
      const path = writer.vaults(undefined).getPath(prod.type, prod.id);
      const lock = async () => {
        try {
          await Deno.chmod(path, 0o000);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      };
      const writes = (hook: typeof writer.hook | undefined) => async () => {
        const repo = writer.vaults(hook);
        await repo.save(prod);
        await lock();
        await repo.save(changed(prod, { config: { auto_generate: false } }));
        await lock();
        await repo.delete(prod);
      };

      // v2: no hook, and a legacy unit over a hook.
      await writes(undefined)();
      const { markDirty, uow } = recordingUnitOfWork();
      await runInUnitOfWork(uow, writes(markDirty));

      // v3 reads the replaced file first, so the same edit fails on it.
      await assertRejects(
        () => writer.run(writes(writer.hook)),
        Deno.errors.PermissionDenied,
      );
    });
  },
});
