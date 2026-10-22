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
 * Turning managedConfig on in a v3 repo keeps the config it already has
 * (swamp-club#3300): `datastore config migrate` commits the repo's model
 * definitions, workflows and vault configs into the config tier, and a
 * writing command adopts them when managedConfig was set by hand.
 */

import "../src/domain/models/models.ts";
import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { copy, walk } from "@std/fs";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { join } from "@std/path";
import { configure, type LogRecord } from "@logtape/logtape";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  requireInitializedRepoReadOnly,
  requireInitializedRepoUnlocked,
} from "../src/cli/repo_context.ts";
import { isCustomDatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { UserError } from "../src/domain/errors.ts";
import type { PartitionKey } from "../src/domain/datastore_v3/partition_key.ts";
import { v3DatastoreFor } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import {
  commitConfigAdoption,
  ConfigAdoptionRefusedError,
  planConfigAdoption,
} from "../src/infrastructure/datastore_v3/v3_config_adoption.ts";
import { holdsV3WriterLock } from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import { runCli, runCliRejecting, UNSET_ENV } from "./usecase_sync_fixtures.ts";
import { assertCheckoutsAgree, withV3RowRepos } from "./usecase_v3_fixtures.ts";
import type { RowRepos } from "./usecase_sync_fixtures.ts";

await initializeLogging({});

const json = (repoDir: string) => ["--repo-dir", repoDir, "--json"];

async function cli(repoDir: string, ...args: string[]): Promise<unknown> {
  const out = await withMockedEnv(
    UNSET_ENV,
    () => runCli({ args: [...args, ...json(repoDir)] }),
  );
  const text = out.join("\n").trim();
  return text === "" ? undefined : JSON.parse(text);
}

/** `workflow get` without the checkout-specific file path. */
async function workflowOf(repoDir: string, name: string): Promise<unknown> {
  const { path: _path, ...rest } = await cli(
    repoDir,
    "workflow",
    "get",
    name,
  ) as Record<string, unknown>;
  return rest;
}

/** The managed-config warnings `fn` logs, or those of `category`. */
async function managedConfigWarnings(
  fn: () => Promise<void>,
  category: string[] = ["cli", "managed-config"],
): Promise<string[]> {
  const captured: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => captured.push(record) },
    loggers: [{
      category,
      lowestLevel: "warning",
      sinks: ["capture"],
    }],
    reset: true,
  });
  try {
    await fn();
  } finally {
    await initializeLogging({ _reset: true });
  }
  return captured.map((r) => r.message.map((p) => String(p)).join(""));
}

async function vaultNames(repoDir: string): Promise<string[]> {
  const listed = await cli(repoDir, "vault", "list") as {
    results: { name: string }[];
  };
  return listed.results.map((v) => v.name).sort();
}

/** Sets `datastore.managedConfig: true` in a checkout's `.swamp.yaml`. */
async function turnOnManagedConfigByHand(repoDir: string): Promise<void> {
  const path = join(repoDir, ".swamp.yaml");
  const text = await Deno.readTextFile(path);
  await Deno.writeTextFile(
    path,
    text.replace(/^ {2}format: 3$/m, "  format: 3\n  managedConfig: true"),
  );
}

/** The commits the datastore holds. */
async function commitCount(repos: RowRepos): Promise<number> {
  const config = repos.a.datastoreConfig;
  if (isCustomDatastoreConfig(config)) throw new Error("v3 is filesystem");
  return (await v3DatastoreFor(repos.repoA, config).describe()).storedCommits;
}

/**
 * Copies the git-tracked config of checkout A into checkout B, as a git
 * clone holds it: same ids, same bytes.
 */
async function cloneConfig(repos: RowRepos): Promise<void> {
  for (const dir of ["models", "workflows", "vaults"]) {
    await Deno.remove(join(repos.repoB, dir), { recursive: true }).catch(
      () => {},
    );
    await copy(join(repos.repoA, dir), join(repos.repoB, dir));
  }
}

/**
 * Gives each of B's repo-local config files bytes A never committed, at the
 * same key: B's caught-up config tier then does not already hold them, so a
 * stale view of the commit log is all that would let B create them.
 */
async function divergeConfig(repoDir: string): Promise<void> {
  for (const dir of ["models", "workflows", "vaults"]) {
    for await (
      const entry of walk(join(repoDir, dir), { includeDirs: false })
    ) {
      await Deno.writeTextFile(entry.path, "# edited on B\n", {
        append: true,
      });
    }
  }
}

/**
 * The vault `swamp repo init` writes into `vaults/` (swamp-club#3259); the
 * fixture's init leaves it out.
 */
async function initDefaultVault(repoDir: string): Promise<void> {
  await cli(repoDir, "vault", "create", "local_encryption", "default");
}

/**
 * The adopted file under a checkout's config tier whose name is `name`; with
 * an empty name, the first `v2` vault config.
 */
async function configFile(
  repoDir: string,
  tree: string,
  name: string,
): Promise<string> {
  for await (
    const entry of walk(swampPath(repoDir, "config", tree), {
      includeDirs: false,
    })
  ) {
    if (name !== "" && entry.name === name) return entry.path;
    if (
      name === "" &&
      (await Deno.readTextFile(entry.path)).includes("name: v2")
    ) {
      return entry.path;
    }
  }
  throw new Error(`no ${name || "v2 vault"} under ${tree}`);
}

/** Runs an edit command with `doc` as the new content on stdin. */
async function edit(
  repoDir: string,
  args: string[],
  doc: Record<string, unknown>,
): Promise<void> {
  await withMockedEnv(
    UNSET_ENV,
    () =>
      runCli({ args: [...args, ...json(repoDir)], stdin: stringifyYaml(doc) }),
  );
}

/** A, with init's default vault, a model, a workflow and a second vault. */
async function seedRepoLocalConfig(repoDir: string): Promise<void> {
  await initDefaultVault(repoDir);
  await cli(repoDir, "model", "create", "command/shell", "m1");
  await cli(repoDir, "workflow", "create", "w1");
  await cli(repoDir, "vault", "create", "local_encryption", "v2");
}

Deno.test("v3 config migrate: commits the init vault, a model, a workflow and a second vault, and a second checkout sees them", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    await seedRepoLocalConfig(repos.repoA);
    assertEquals(
      await commitCount(repos),
      0,
      "repo-local config commits nothing",
    );

    const migrated = await cli(
      repos.repoA,
      "datastore",
      "config",
      "migrate",
    ) as Record<string, unknown>;
    assertEquals(migrated.alreadyMigrated, false);
    assertEquals(migrated.committed, 4);
    assertEquals(migrated.copiedModels, true);
    assertEquals(migrated.copiedWorkflows, true);
    assertEquals(migrated.copiedVaults, true);
    assertEquals(migrated.managedConfigSet, true);
    assertEquals(migrated.skipped, []);

    // All of it stays visible in this checkout, read from the config tier.
    assertEquals(await vaultNames(repos.repoA), ["default", "v2"]);
    const model = await cli(repos.repoA, "model", "get", "m1") as {
      name: string;
    };
    assertEquals(model.name, "m1");
    const workflow = await workflowOf(repos.repoA, "w1") as {
      name: string;
    };
    assertEquals(workflow.name, "w1");

    // A second checkout catches up to the same records.
    await assertCheckoutsAgree(repos, datastorePath, "after migrate");
    await turnOnManagedConfigByHand(repos.repoB);
    assertEquals(await vaultNames(repos.repoB), ["default", "v2"]);
    assertEquals(
      await cli(repos.repoB, "model", "get", "m1"),
      await cli(repos.repoA, "model", "get", "m1"),
    );
    assertEquals(
      await workflowOf(repos.repoB, "w1"),
      await workflowOf(repos.repoA, "w1"),
    );
  });
});

Deno.test("v3 config migrate: a re-run commits nothing", async () => {
  await withV3RowRepos({}, async (repos) => {
    await seedRepoLocalConfig(repos.repoA);
    await cli(repos.repoA, "datastore", "config", "migrate");
    const commits = await commitCount(repos);

    const again = await cli(
      repos.repoA,
      "datastore",
      "config",
      "migrate",
    ) as Record<string, unknown>;
    assertEquals(again, {
      alreadyMigrated: true,
      managedConfigSet: false,
      skipped: [],
    });
    assertEquals(await commitCount(repos), commits);
  });
});

Deno.test("v3 config migrate: a name deleted from the config tier is not brought back", async () => {
  await withV3RowRepos({}, async (repos) => {
    await seedRepoLocalConfig(repos.repoA);
    await cli(repos.repoA, "datastore", "config", "migrate");
    await cli(repos.repoA, "model", "delete", "m1", "--force");
    // The repo-local copy is still there, as after a v2 migrate.
    assert(
      (await Deno.stat(join(repos.repoA, "models"))).isDirectory,
    );

    const again = await cli(
      repos.repoA,
      "datastore",
      "config",
      "migrate",
    ) as Record<string, unknown>;
    assertEquals(again.alreadyMigrated, true);
    const missing = await withMockedEnv(
      UNSET_ENV,
      () =>
        runCliRejecting({
          args: ["model", "get", "m1", ...json(repos.repoA)],
        }),
    );
    assertInstanceOf(missing, Error);
  });
});

Deno.test("v3 config migrate: adopted config edits commit through the repositories", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    await seedRepoLocalConfig(repos.repoA);
    await cli(repos.repoA, "datastore", "config", "migrate");
    const before = await commitCount(repos);
    const model = parseYaml(
      await Deno.readTextFile(
        await configFile(repos.repoA, "models", "m1.yaml"),
      ),
    ) as Record<string, unknown>;
    await edit(repos.repoA, ["model", "edit", "m1"], {
      ...model,
      tags: { edited: "yes" },
    });
    const afterModel = await commitCount(repos);
    assert(afterModel > before, "an edit of an adopted model commits");
    const workflow = parseYaml(
      await Deno.readTextFile(
        await configFile(repos.repoA, "workflows", "workflow-w1.yaml"),
      ),
    ) as Record<string, unknown>;
    await edit(repos.repoA, ["workflow", "edit", "w1"], {
      ...workflow,
      description: "edited",
    });
    const afterWorkflow = await commitCount(repos);
    assert(
      afterWorkflow > afterModel,
      "an edit of an adopted workflow commits",
    );
    const vault = parseYaml(
      await Deno.readTextFile(await configFile(repos.repoA, "vaults", "")),
    ) as Record<string, unknown>;
    // A rename tombstones the adopted key, expecting it present.
    await edit(repos.repoA, ["vault", "edit", String(vault.name)], {
      ...vault,
      name: "v2-renamed",
    });
    assert(
      await commitCount(repos) > afterWorkflow,
      "a rename of an adopted vault commits",
    );
    assertEquals(await vaultNames(repos.repoA), ["default", "v2-renamed"]);
    await assertCheckoutsAgree(repos, datastorePath, "after edits");
  });
});

Deno.test("v3 config migrate: a stale clone's create of a committed key is refused", async () => {
  await withV3RowRepos({}, async (repos) => {
    await seedRepoLocalConfig(repos.repoA);
    await cli(repos.repoA, "datastore", "config", "migrate");
    await cloneConfig(repos);
    await divergeConfig(repos.repoB);

    // B's view of the commit log is stale: it believes nothing is committed.
    const config = repos.a.datastoreConfig;
    if (isCustomDatastoreConfig(config)) throw new Error("v3 is filesystem");
    await turnOnManagedConfigByHand(repos.repoB);
    const b = await requireInitializedRepoUnlocked({
      repoDir: repos.repoB,
      outputMode: "json",
    });
    const configBase = b.datastoreResolver.resolvePath("config");
    // A stale checkout has not materialised A's commits yet.
    await Deno.remove(configBase, { recursive: true });
    const stale = await planConfigAdoption({
      repoDir: repos.repoB,
      configBase,
      partitionHasCommits: () => Promise.resolve(false),
      definitionCommitState: () => Promise.resolve("none"),
    });
    assertEquals(stale.adoptions.length, 4);
    const commits = await commitCount(repos);
    const error = await assertRejects(
      () => commitConfigAdoption(b.repoContext, configBase, stale),
      ConfigAdoptionRefusedError,
    );
    assertInstanceOf(error, UserError);
    assertStringIncludes(error.message, "Run the command again");
    assertEquals(await commitCount(repos), commits, "nothing landed");
  });
});

Deno.test("v3 managedConfig by hand: a writing command adopts the repo's config, and a read-only one warns and writes nothing", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    await seedRepoLocalConfig(repos.repoA);
    await turnOnManagedConfigByHand(repos.repoA);

    // A read-only open finds the config but cannot commit it.
    const warnings = await managedConfigWarnings(async () => {
      const readOnly = await requireInitializedRepoReadOnly({
        repoDir: repos.repoA,
        outputMode: "json",
      });
      assertEquals(readOnly.managedConfig, true);
    });
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0], "not in the datastore config tier yet");
    assertEquals(
      await commitCount(repos),
      0,
      "a read-only open commits nothing",
    );

    // The first writing command adopts it.
    await cli(repos.repoA, "model", "create", "command/shell", "m2");
    assertEquals(await vaultNames(repos.repoA), ["default", "v2"]);
    const m1 = await cli(repos.repoA, "model", "get", "m1") as {
      name: string;
    };
    assertEquals(m1.name, "m1");
    const w1 = await workflowOf(repos.repoA, "w1") as {
      name: string;
    };
    assertEquals(w1.name, "w1");

    // Config migrate afterwards finds nothing left to do.
    const migrated = await cli(
      repos.repoA,
      "datastore",
      "config",
      "migrate",
    ) as Record<string, unknown>;
    assertEquals(migrated.alreadyMigrated, true);

    await assertCheckoutsAgree(repos, datastorePath, "after adoption");
  });
});

Deno.test("v3 managedConfig by hand: the swamp-uat#623 sequence shows clone A's config on clone B", async () => {
  await withV3RowRepos({}, async (repos) => {
    // Both clones turn managedConfig on by hand as they join, as the UAT's
    // v3 backend does; B is a clone of A.
    await initDefaultVault(repos.repoA);
    await turnOnManagedConfigByHand(repos.repoA);
    await cloneConfig(repos);
    await turnOnManagedConfigByHand(repos.repoB);

    await cli(repos.repoA, "model", "create", "command/shell", "uat-model");
    await cli(repos.repoA, "workflow", "create", "uat-workflow");
    await cli(repos.repoA, "vault", "create", "local_encryption", "uat-vault");

    assertEquals(
      await cli(repos.repoB, "model", "get", "uat-model"),
      await cli(repos.repoA, "model", "get", "uat-model"),
    );
    assertEquals(
      await workflowOf(repos.repoB, "uat-workflow"),
      await workflowOf(repos.repoA, "uat-workflow"),
    );
    assertEquals(
      await cli(repos.repoB, "vault", "get", "uat-vault"),
      await cli(repos.repoA, "vault", "get", "uat-vault"),
    );
    assertEquals(await vaultNames(repos.repoB), ["default", "uat-vault"]);
  });
});

Deno.test("v3 managedConfig by hand: a refused adoption warns and the writing command still runs, with its locks held", async () => {
  await withV3RowRepos({}, async (repos) => {
    await seedRepoLocalConfig(repos.repoA);
    await cli(repos.repoA, "datastore", "config", "migrate");
    await cloneConfig(repos);
    await divergeConfig(repos.repoB);
    await turnOnManagedConfigByHand(repos.repoB);

    // B's first plan sees a stale commit log: each partition's first head
    // read answers "never written", as a checkout that has not caught up
    // would. The commit itself reads the real head.
    const config = repos.a.datastoreConfig;
    if (isCustomDatastoreConfig(config)) throw new Error("v3 is filesystem");
    const handle = v3DatastoreFor(repos.repoB, config);
    const store = handle.commitStore;
    const realHead = store.head.bind(store);
    const seen = new Set<string>();
    store.head = (namespace: string, partition: PartitionKey) => {
      if (
        partition.toString().startsWith("config--") &&
        !seen.has(partition.toString())
      ) {
        seen.add(partition.toString());
        return Promise.resolve({ seq: 0, highestFence: undefined });
      }
      return realHead(namespace, partition);
    };
    // Nor has it caught up: the context opens over a checkout that has not
    // materialised A's commits.
    const realCatchUp = handle.catchUp;
    handle.catchUp = () => Promise.resolve();
    const commits = await commitCount(repos);
    try {
      const warnings = await managedConfigWarnings(async () => {
        await requireInitializedRepoUnlocked({
          repoDir: repos.repoB,
          outputMode: "json",
        });
      });
      assertEquals(warnings.length, 1);
      assertStringIncludes(warnings[0], "Run the command again");
      assert(holdsV3WriterLock(config.path), "the writer lock is still held");
      assertEquals(await commitCount(repos), commits, "nothing landed");
    } finally {
      store.head = realHead;
      handle.catchUp = realCatchUp;
    }
    // The refused adoption wrote nothing; catching up gives B's config tier
    // what the commit log says: A's bytes.
    await handle.catchUp();
    const tierFile = (repoDir: string) =>
      Deno.readTextFile(
        swampPath(repoDir, "config", "models", "command", "shell", "m1.yaml"),
      );
    assertEquals(await tierFile(repos.repoB), await tierFile(repos.repoA));
    // A writing command then runs as usual.
    await cli(repos.repoB, "model", "create", "command/shell", "after");
  });
});

Deno.test("v3 config migrate: a symlink in the repo's config trees is never adopted", async () => {
  if (Deno.build.os === "windows") return;
  await withV3RowRepos({}, async (repos) => {
    await initDefaultVault(repos.repoA);
    const outside = join(repos.repoA, "..", "outside-secret.yaml");
    await Deno.writeTextFile(
      outside,
      "id: 6f1d2c1e-8f4a-4c7e-9d55-0b3f3f6f0a11\nname: leaked\ntype: local_encryption\n",
    );
    await Deno.mkdir(join(repos.repoA, "vaults", "local_encryption"), {
      recursive: true,
    });
    await Deno.symlink(
      outside,
      join(repos.repoA, "vaults", "local_encryption", "leaked.yaml"),
      { type: "file" },
    );
    await Deno.mkdir(join(repos.repoA, "models"), { recursive: true });
    await Deno.symlink(
      join(repos.repoA, ".."),
      join(repos.repoA, "models", "escape"),
      { type: "dir" },
    );
    // A tree whose root is itself a link is not read either.
    const outsideWorkflows = join(repos.repoA, "..", "outside-workflows");
    await Deno.mkdir(outsideWorkflows, { recursive: true });
    await Deno.writeTextFile(
      join(outsideWorkflows, "workflow-leaked.yaml"),
      "id: 0b6f1a52-3c3e-4f19-8d0b-6f6c2f4f8e21\nname: leaked\n",
    );
    await Deno.remove(join(repos.repoA, "workflows"), { recursive: true })
      .catch(() => {});
    await Deno.symlink(outsideWorkflows, join(repos.repoA, "workflows"), {
      type: "dir",
    });

    await cli(repos.repoA, "datastore", "config", "migrate");
    assertEquals(await vaultNames(repos.repoA), ["default"]);
    const tier = swampPath(repos.repoA, "config", "vaults", "local_encryption");
    for await (const entry of Deno.readDir(tier)) {
      assert(!entry.name.startsWith("leaked"), "the symlink was not adopted");
    }
    await assertRejects(() =>
      Deno.stat(swampPath(repos.repoA, "config", "workflows"))
    );
  });
});

Deno.test("v3 config migrate: a commit that fails writes no config-tier file, so a re-run still adopts", async () => {
  await withV3RowRepos({}, async (repos) => {
    await seedRepoLocalConfig(repos.repoA);
    const config = repos.a.datastoreConfig;
    if (isCustomDatastoreConfig(config)) throw new Error("v3 is filesystem");
    const store = v3DatastoreFor(repos.repoA, config).commitStore;
    const realAppend = store.append.bind(store);
    store.append = () => Promise.reject(new Error("injected append failure"));
    try {
      const error = await withMockedEnv(
        UNSET_ENV,
        () =>
          runCliRejecting({
            args: ["datastore", "config", "migrate", ...json(repos.repoA)],
          }),
      );
      assertInstanceOf(error, Error);
    } finally {
      store.append = realAppend;
    }
    assertEquals(await commitCount(repos), 0, "nothing landed");
    await assertRejects(() => Deno.stat(swampPath(repos.repoA, "config")));

    const migrated = await cli(
      repos.repoA,
      "datastore",
      "config",
      "migrate",
    ) as Record<string, unknown>;
    assertEquals(migrated.committed, 4);
    assertEquals(await vaultNames(repos.repoA), ["default", "v2"]);
  });
});

Deno.test("v3 config migrate: namespaced checkouts commit into their namespace", async () => {
  await withV3RowRepos({ namespace: "team" }, async (repos, datastorePath) => {
    await seedRepoLocalConfig(repos.repoA);
    const migrated = await cli(
      repos.repoA,
      "datastore",
      "config",
      "migrate",
    ) as Record<string, unknown>;
    assertEquals(migrated.committed, 4);
    assertEquals(await vaultNames(repos.repoA), ["default", "v2"]);
    await assertCheckoutsAgree(repos, datastorePath, "namespaced", "team");
  });
});

/** A repo-local lockfile naming one pulled extension, and its sources. */
async function seedPulledExtension(repoDir: string): Promise<void> {
  const lockfile = join(
    repoDir,
    "extensions",
    "models",
    "upstream_extensions.json",
  );
  await Deno.mkdir(join(lockfile, ".."), { recursive: true });
  await Deno.writeTextFile(
    lockfile,
    JSON.stringify(
      {
        "@test/ext": {
          version: "2026.01.01.1",
          pulledAt: "2026-01-01T00:00:00.000Z",
          files: [],
        },
      },
      null,
      2,
    ) + "\n",
  );
  const manifest = swampPath(
    repoDir,
    "pulled-extensions",
    "@test",
    "ext",
    "manifest.yaml",
  );
  await Deno.mkdir(join(manifest, ".."), { recursive: true });
  await Deno.writeTextFile(
    manifest,
    'name: "@test/ext"\nversion: 2026.01.01.1\n',
  );
}

async function lockfileEntries(repoDir: string): Promise<string[]> {
  const { lockfilePath } = await requireInitializedRepoReadOnly({
    repoDir,
    outputMode: "json",
  });
  return Object.keys(
    (await LockfileRepository.create(lockfilePath)).getAllEntries(),
  );
}

Deno.test("v3 config migrate: the repo's extension lockfile is committed and its pulled extensions move with it", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    await seedRepoLocalConfig(repos.repoA);
    await seedPulledExtension(repos.repoA);
    assertEquals(await lockfileEntries(repos.repoA), ["@test/ext"]);

    const migrated = await cli(
      repos.repoA,
      "datastore",
      "config",
      "migrate",
    ) as Record<string, unknown>;
    assertEquals(migrated.copiedLockfile, true);
    assertEquals(migrated.copiedPulledExtensions, true);

    // Managed config reads the lockfile and pulled sources from the tier.
    assertEquals(await lockfileEntries(repos.repoA), ["@test/ext"]);
    assert(
      (await Deno.stat(
        swampPath(
          repos.repoA,
          "config",
          "pulled-extensions",
          "@test",
          "ext",
          "manifest.yaml",
        ),
      )).isFile,
    );
    // The lockfile is committed: a second checkout catches it up. Pulled
    // sources are never committed (they have no v3 intent), so they stay in
    // this checkout, as an `extension pull` on v3 leaves them.
    await Deno.remove(swampPath(repos.repoA, "config", "pulled-extensions"), {
      recursive: true,
    });
    await assertCheckoutsAgree(repos, datastorePath, "lockfile adopted");
    await assertRejects(() =>
      Deno.stat(swampPath(repos.repoB, "config", "pulled-extensions"))
    );
    assert(
      (await Deno.stat(
        swampPath(repos.repoB, "config", "upstream_extensions.json"),
      ))
        .isFile,
    );

    const again = await cli(
      repos.repoA,
      "datastore",
      "config",
      "migrate",
    ) as Record<string, unknown>;
    assertEquals(again.alreadyMigrated, true);
  });
});

Deno.test("v3 managedConfig by hand: the first writing command adopts the extension lockfile too", async () => {
  await withV3RowRepos({}, async (repos) => {
    await seedPulledExtension(repos.repoA);
    await turnOnManagedConfigByHand(repos.repoA);
    await cli(repos.repoA, "model", "create", "command/shell", "m1");
    assertEquals(await lockfileEntries(repos.repoA), ["@test/ext"]);
  });
});

Deno.test("v3 managedConfig by hand: an unreadable leftover neither fails a command nor stops the rest", async () => {
  if (Deno.build.os === "windows") return;
  await withV3RowRepos({}, async (repos) => {
    await seedRepoLocalConfig(repos.repoA);
    const locked = join(repos.repoA, "workflows", "workflow-locked.yaml");
    await Deno.writeTextFile(
      locked,
      "id: 6f1d2c1e-8f4a-4c7e-9d55-0b3f3f6f0a11\nname: locked\n",
    );
    await Deno.chmod(locked, 0o000);
    try {
      await turnOnManagedConfigByHand(repos.repoA);
      // Read-only and writing commands both still run.
      assertEquals(await vaultNames(repos.repoA), []);
      await cli(repos.repoA, "model", "create", "command/shell", "m2");
      assertEquals(await vaultNames(repos.repoA), ["default", "v2"]);
      const migrated = await cli(
        repos.repoA,
        "datastore",
        "config",
        "migrate",
      ) as { skipped: { path: string; reason: string }[] };
      assertEquals(
        migrated.skipped.map((s) => s.reason),
        ["unreadable"],
      );
    } finally {
      await Deno.chmod(locked, 0o644);
    }
  });
});

Deno.test("v3 config migrate: a tier copy the commit log never held does not stop its name being committed", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    await seedRepoLocalConfig(repos.repoA);
    // A tier left behind by an earlier setup: files, but no commits.
    await copy(
      join(repos.repoA, "vaults"),
      swampPath(repos.repoA, "config", "vaults"),
    );
    const migrated = await cli(
      repos.repoA,
      "datastore",
      "config",
      "migrate",
    ) as Record<string, unknown>;
    assertEquals(migrated.committed, 4);
    await assertCheckoutsAgree(repos, datastorePath, "stray tier copy");
  });
});

/** Runs a command whose output the test does not read. */
async function run(repoDir: string, ...args: string[]): Promise<void> {
  await withMockedEnv(
    UNSET_ENV,
    () => runCli({ args: [...args, ...json(repoDir)] }),
  );
}

/**
 * Gives the seeded `m1` a command and `w1` a step that runs it, then runs
 * both: the workflow run stages its evaluated workflow into `w1`'s config
 * partition, and the method run stages `m1`'s evaluated definition.
 */
async function runSeededConfig(repoDir: string): Promise<void> {
  const modelPath = join(repoDir, "models", "command", "shell", "m1.yaml");
  const model = parseYaml(await Deno.readTextFile(modelPath)) as Record<
    string,
    unknown
  >;
  await Deno.writeTextFile(
    modelPath,
    stringifyYaml({ ...model, globalArguments: { run: "echo hi" } }),
  );
  const workflowPath = join(repoDir, "workflows", "workflow-w1.yaml");
  const workflow = parseYaml(await Deno.readTextFile(workflowPath)) as {
    jobs: { steps: { task: Record<string, unknown> }[] }[];
  };
  workflow.jobs[0].steps[0].task = {
    type: "model_method",
    modelIdOrName: "m1",
    methodName: "execute",
  };
  await Deno.writeTextFile(workflowPath, stringifyYaml(workflow));
  await run(repoDir, "workflow", "run", "w1");
  await run(repoDir, "model", "method", "run", "m1", "execute");
}

/** The v3 datastore of a row's checkout A. */
function datastoreOf(repos: RowRepos) {
  const config = repos.a.datastoreConfig;
  if (isCustomDatastoreConfig(config)) throw new Error("v3 is filesystem");
  return v3DatastoreFor(repos.repoA, config);
}

Deno.test("v3 config migrate: a workflow and a model that ran before it are committed, and the workflow runs after it (swamp-club#3760)", async () => {
  await withV3RowRepos({}, async (repos) => {
    await seedRepoLocalConfig(repos.repoA);
    await runSeededConfig(repos.repoA);

    const migrated = await cli(
      repos.repoA,
      "datastore",
      "config",
      "migrate",
    ) as Record<string, unknown>;
    assertEquals(migrated.skipped, []);
    assertEquals(migrated.committed, 4);
    assertEquals(migrated.copiedWorkflows, true);
    assertEquals(migrated.copiedModels, true);
    assertEquals(migrated.copiedVaults, true);

    const workflow = await workflowOf(repos.repoA, "w1") as { name: string };
    assertEquals(workflow.name, "w1");
    await run(repos.repoA, "workflow", "run", "w1");
    await run(repos.repoA, "model", "method", "run", "m1", "execute");
    assertEquals(await vaultNames(repos.repoA), ["default", "v2"]);
  });
});

Deno.test("v3 config migrate: a re-run commits the workflows an affected version skipped (swamp-club#3760)", async () => {
  await withV3RowRepos({}, async (repos) => {
    await seedRepoLocalConfig(repos.repoA);
    await runSeededConfig(repos.repoA);

    // What an affected version committed: every name whose partition had
    // no commit at all, so not the workflow that ran.
    const a = await requireInitializedRepoUnlocked({
      repoDir: repos.repoA,
      outputMode: "json",
    });
    const configBase = a.datastoreResolver.resolvePath("config");
    const store = datastoreOf(repos);
    const hasCommits = async (partition: PartitionKey) =>
      (await store.commitStore.head(store.namespace, partition)).seq > 0;
    const affected = await planConfigAdoption({
      repoDir: repos.repoA,
      configBase,
      partitionHasCommits: hasCommits,
      definitionCommitState: async (partition) =>
        await hasCommits(partition) ? "committed" : "none",
    });
    assertEquals(
      affected.skipped.map((s) => [s.name, s.reason]),
      [["w1", "name-committed"]],
    );
    await commitConfigAdoption(a.repoContext, configBase, affected);
    await turnOnManagedConfigByHand(repos.repoA);
    // Reads hide the repo-local copy and the tier has none.
    const missing = await withMockedEnv(
      UNSET_ENV,
      () =>
        runCliRejecting({
          args: ["workflow", "get", "w1", ...json(repos.repoA)],
        }),
    );
    assertInstanceOf(missing, Error);

    const again = await cli(
      repos.repoA,
      "datastore",
      "config",
      "migrate",
    ) as Record<string, unknown>;
    assertEquals(again.skipped, []);
    const workflow = await workflowOf(repos.repoA, "w1") as { name: string };
    assertEquals(workflow.name, "w1");
    await run(repos.repoA, "workflow", "run", "w1");
  });
});

Deno.test("v3 config migrate: a workflow deleted after it ran and was committed is not brought back", async () => {
  await withV3RowRepos({}, async (repos) => {
    await seedRepoLocalConfig(repos.repoA);
    await runSeededConfig(repos.repoA);
    await cli(repos.repoA, "datastore", "config", "migrate");
    await run(repos.repoA, "workflow", "run", "w1");
    await run(repos.repoA, "workflow", "delete", "w1", "--force");

    const again = await cli(
      repos.repoA,
      "datastore",
      "config",
      "migrate",
    ) as Record<string, unknown>;
    assertEquals(again.alreadyMigrated, true);
    assertEquals(
      (again.skipped as { name: string; reason: string }[]).map((
        s,
      ) => [s.name, s.reason]),
      [["w1", "name-committed"]],
    );
    const missing = await withMockedEnv(
      UNSET_ENV,
      () =>
        runCliRejecting({
          args: ["workflow", "get", "w1", ...json(repos.repoA)],
        }),
    );
    assertInstanceOf(missing, Error);
  });
});

/** Compacts every commit checkout A's datastore holds. */
async function compactAll(repos: RowRepos): Promise<void> {
  const store = datastoreOf(repos).commitStore;
  const changes = await store.changesSince(0, 10_000);
  const fence = store.writerFence();
  await store.compactHistory(changes[changes.length - 1].cursor, {
    ...(fence !== undefined ? { fence } : {}),
  });
}

Deno.test("v3 config migrate: a workflow whose compacted history shows no definition is skipped as history-compacted, with the way out", async () => {
  await withV3RowRepos({}, async (repos) => {
    await seedRepoLocalConfig(repos.repoA);
    await runSeededConfig(repos.repoA);
    await compactAll(repos);

    const migrated = await cli(
      repos.repoA,
      "datastore",
      "config",
      "migrate",
    ) as Record<string, unknown>;
    // Compaction keeps no tombstones, so a definition deleted before it
    // cannot be told from one never committed: the name is left out.
    assertEquals(
      (migrated.skipped as { name: string; reason: string }[]).map((
        s,
      ) => [s.name, s.reason]),
      [["w1", "history-compacted"]],
    );
    assertEquals(migrated.committed, 3);

    const warnings = await managedConfigWarnings(async () => {
      await withMockedEnv(
        UNSET_ENV,
        () =>
          runCli({
            args: ["datastore", "config", "migrate", "--repo-dir", repos.repoA],
          }),
      );
    }, ["cli"]);
    const skip = warnings.find((w) => w.includes("workflow-w1.yaml"));
    assert(skip !== undefined, warnings.join("\n"));
    assertStringIncludes(skip, "history for this name was compacted");
    assertStringIncludes(
      skip,
      "'swamp workflow create', then 'swamp workflow edit'",
    );
    assertStringIncludes(skip, "restore it from git");
  });
});

Deno.test("v3 config migrate: a compacted workflow whose definition is still live stays name-committed", async () => {
  await withV3RowRepos({}, async (repos) => {
    await seedRepoLocalConfig(repos.repoA);
    await runSeededConfig(repos.repoA);
    await cli(repos.repoA, "datastore", "config", "migrate");
    await compactAll(repos);
    // The repo-local file at a path the tier has no copy at, as another
    // checkout's file name would be: only the definition in the compacted
    // base shows that the name is committed.
    await Deno.rename(
      join(repos.repoA, "workflows", "workflow-w1.yaml"),
      join(repos.repoA, "workflows", "renamed-w1.yaml"),
    );

    const again = await cli(
      repos.repoA,
      "datastore",
      "config",
      "migrate",
    ) as Record<string, unknown>;
    assertEquals(
      (again.skipped as { name: string; reason: string }[]).map((
        s,
      ) => [s.name, s.reason]),
      [["w1", "name-committed"]],
    );
  });
});

Deno.test("v3 managedConfig by hand: the first writing command adopts a workflow that ran before it (swamp-club#3760)", async () => {
  await withV3RowRepos({}, async (repos) => {
    await seedRepoLocalConfig(repos.repoA);
    await runSeededConfig(repos.repoA);
    await turnOnManagedConfigByHand(repos.repoA);

    await cli(repos.repoA, "model", "create", "command/shell", "m2");
    const workflow = await workflowOf(repos.repoA, "w1") as { name: string };
    assertEquals(workflow.name, "w1");
    await run(repos.repoA, "workflow", "run", "w1");
  });
});

Deno.test("v3 config migrate: a workflow renamed after it ran and was committed is not brought back under its old name", async () => {
  await withV3RowRepos({}, async (repos) => {
    await seedRepoLocalConfig(repos.repoA);
    await runSeededConfig(repos.repoA);
    await cli(repos.repoA, "datastore", "config", "migrate");
    const { path: _path, ...current } = await cli(
      repos.repoA,
      "workflow",
      "get",
      "w1",
    ) as Record<string, unknown>;
    await edit(repos.repoA, ["workflow", "edit", "w1", "--allow-rename"], {
      ...current,
      name: "w1b",
    });
    await run(repos.repoA, "workflow", "run", "w1b");

    const again = await cli(
      repos.repoA,
      "datastore",
      "config",
      "migrate",
    ) as Record<string, unknown>;
    assertEquals(again.alreadyMigrated, true);
    assertEquals(
      (again.skipped as { name: string; reason: string }[]).map((
        s,
      ) => [s.name, s.reason]),
      [["w1", "name-committed"]],
    );
    const renamed = await workflowOf(repos.repoA, "w1b") as { name: string };
    assertEquals(renamed.name, "w1b");
    const missing = await withMockedEnv(
      UNSET_ENV,
      () =>
        runCliRejecting({
          args: ["workflow", "get", "w1", ...json(repos.repoA)],
        }),
    );
    assertInstanceOf(missing, Error);
  });
});
