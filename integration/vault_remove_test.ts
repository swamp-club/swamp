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
 * `swamp vault remove` (swamp-club#3597) wired to real repositories on a
 * temp repo: the default vault and referenced vaults are refused, a removal
 * deletes the config and then the local secrets, and a committed config
 * whose name escapes the secrets root removes nothing.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { RepoMarkerRepository } from "../src/infrastructure/persistence/repo_marker_repository.ts";
import type { DatastoreConfigData } from "../src/domain/datastore/datastore_config.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { VaultConfig } from "../src/domain/vaults/vault_config.ts";
import {
  localEncryptionSecretsDir,
  LocalEncryptionVaultProvider,
} from "../src/domain/vaults/local_encryption_vault_provider.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { collect } from "../src/libswamp/testing.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createVaultRemoveDeps,
  vaultRemove,
  type VaultRemoveEvent,
  vaultRemovePreview,
  vaultRemoveStoredSecrets,
} from "../src/libswamp/vaults/remove.ts";

interface TestRepo {
  repoDir: string;
  repoContext: ReturnType<typeof createRepositoryContext>;
}

async function withRepo(
  fn: (repo: TestRepo) => Promise<void>,
  options: { datastore?: DatastoreConfigData; defaultVault?: boolean } = {},
): Promise<void> {
  const withDefault = options.defaultVault ?? true;
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_vault_remove_" });
  try {
    await new RepoMarkerRepository().write(RepoPath.create(repoDir), {
      swampVersion: "test",
      initializedAt: new Date().toISOString(),
      defaultVault: withDefault ? "default" : undefined,
      datastore: options.datastore,
    });
    const repoContext = createRepositoryContext({
      repoDir,
      enableIndexing: false,
    });
    if (withDefault) await saveLocalVault(repoContext, "default");
    await fn({ repoDir, repoContext });
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

async function saveLocalVault(
  repoContext: TestRepo["repoContext"],
  name: string,
  config: Record<string, unknown> = { auto_generate: true },
  id: string = crypto.randomUUID(),
): Promise<VaultConfig> {
  const vault = VaultConfig.create(
    id,
    name,
    "local_encryption",
    config,
  );
  await repoContext.vaultConfigRepo.save(vault);
  return vault;
}

function depsFor({ repoDir, repoContext }: TestRepo) {
  return createVaultRemoveDeps(repoDir, {
    vaultConfigRepo: repoContext.vaultConfigRepo,
    definitionRepo: repoContext.definitionRepo,
    workflowRepo: repoContext.workflowRepo,
  });
}

/** Runs what the CLI runs: preview, the removal, then the secrets. */
async function removeVault(repo: TestRepo, vaultName: string, force = false) {
  const ctx = createLibSwampContext();
  const deps = depsFor(repo);
  const preview = await vaultRemovePreview(ctx, deps, { vaultName, force });
  const events = await collect<VaultRemoveEvent>(
    vaultRemove(ctx, deps, { vaultName, force }),
  );
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind !== "completed") {
    throw new Error(`vault remove did not complete: ${JSON.stringify(events)}`);
  }
  const secrets = await vaultRemoveStoredSecrets(ctx, deps, preview);
  return { preview, data: completed.data, secrets };
}

async function previewError(
  repo: TestRepo,
  vaultName: string,
  force = false,
): Promise<string> {
  try {
    await vaultRemovePreview(createLibSwampContext(), depsFor(repo), {
      vaultName,
      force,
    });
  } catch (error) {
    return (error as { message: string }).message;
  }
  throw new Error("Expected the preview to refuse");
}

Deno.test("vault remove: removes the config, then the vault's secrets and key", async () => {
  await withRepo(async (repo) => {
    await saveLocalVault(repo.repoContext, "trip-planner");
    const provider = new LocalEncryptionVaultProvider("trip-planner", {
      auto_generate: true,
      base_dir: repo.repoDir,
    });
    await provider.put("API_KEY", "s3cret");
    const directory = localEncryptionSecretsDir(repo.repoDir, "trip-planner");

    const { preview, secrets } = await removeVault(repo, "trip-planner");

    assertEquals(preview.localStorage?.secretCount, 1);
    assertEquals(secrets, { directory, removed: true, secretCount: 1 });
    assertEquals(
      await repo.repoContext.vaultConfigRepo.findByName("trip-planner"),
      null,
    );
    await assertRejects(() => Deno.lstat(directory), Deno.errors.NotFound);
    // The default vault is untouched.
    assertEquals(
      (await repo.repoContext.vaultConfigRepo.findByName("default"))?.name,
      "default",
    );
  });
});

Deno.test("vault remove: refuses the default vault, even with force", async () => {
  await withRepo(async (repo) => {
    for (const force of [false, true]) {
      assertStringIncludes(
        await previewError(repo, "default", force),
        "default vault",
      );
    }
    const events = await collect<VaultRemoveEvent>(
      vaultRemove(createLibSwampContext(), depsFor(repo), {
        vaultName: "default",
        force: true,
      }),
    );
    assertEquals(events.some((e) => e.kind === "error"), true);
    assertEquals(
      (await repo.repoContext.vaultConfigRepo.findByName("default"))?.name,
      "default",
    );
  });
});

Deno.test("vault remove: refuses a vault referenced by a definition, a workflow and the datastore config; force removes it", async () => {
  const datastore: DatastoreConfigData = {
    type: "@test/datastore",
    config: { secret: "${{ vault.get(trip-planner, DS_SECRET) }}" },
  };
  await withRepo(async (repo) => {
    await saveLocalVault(repo.repoContext, "trip-planner");
    await repo.repoContext.definitionRepo.save(
      ModelType.create("command/shell"),
      Definition.create({
        name: "app",
        globalArguments: { token: "${{ vault.get(trip-planner, KEY) }}" },
        resources: { state: { vaultName: "trip-planner" } },
      }),
    );
    await repo.repoContext.yamlWorkflowRepo.save(
      Workflow.create({
        name: "deploy",
        vaults: ["trip-planner"],
        jobs: [
          Job.create({
            name: "build",
            steps: [
              Step.create({
                name: "run",
                task: StepTask.model("app", "run"),
              }),
            ],
          }),
        ],
      }),
    );

    const message = await previewError(repo, "trip-planner");
    assertStringIncludes(message, "definition 'app' (vault.get)");
    assertStringIncludes(message, "definition 'app' (resource override)");
    assertStringIncludes(message, "workflow 'deploy' (vaults list)");
    assertStringIncludes(message, "datastore 'datastore' (vault.get)");
    assertEquals(
      (await repo.repoContext.vaultConfigRepo.findByName("trip-planner"))
        ?.name,
      "trip-planner",
    );

    const { data } = await removeVault(repo, "trip-planner", true);
    assertEquals(data.forcedReferences.length, 4);
    assertEquals(
      await repo.repoContext.vaultConfigRepo.findByName("trip-planner"),
      null,
    );
  }, { datastore });
});

Deno.test("vault remove: leaves a key file the config names outside the vault directory", async () => {
  await withRepo(async (repo) => {
    const keyFile = join(repo.repoDir, "keys", "trip.key");
    await Deno.mkdir(join(repo.repoDir, "keys"));
    const config = { auto_generate: true, key_file: keyFile };
    await saveLocalVault(repo.repoContext, "trip-planner", config);
    await new LocalEncryptionVaultProvider("trip-planner", {
      ...config,
      base_dir: repo.repoDir,
    }).put("API_KEY", "s3cret");

    await removeVault(repo, "trip-planner");

    assertEquals((await Deno.stat(keyFile)).isFile, true);
  });
});

Deno.test("vault remove: a committed config whose name escapes the secrets root removes nothing", async () => {
  await withRepo(async (repo) => {
    const data = join(repo.repoDir, ".swamp", "data");
    await Deno.mkdir(data, { recursive: true });
    await Deno.writeTextFile(join(data, "keep.yaml"), "kept");
    // The schema accepts any name on read; create refuses this one.
    const escaping = await saveLocalVault(repo.repoContext, "../../data");

    assertStringIncludes(
      await previewError(repo, escaping.name),
      "single path segment",
    );
    assertEquals(await Deno.readTextFile(join(data, "keep.yaml")), "kept");
    assertEquals(
      (await repo.repoContext.vaultConfigRepo.findByName(escaping.name))?.name,
      escaping.name,
    );
  });
});

Deno.test("vault remove: without defaultVault, refuses the first vault sensitive outputs fall back to", async () => {
  await withRepo(async (repo) => {
    // Vaults load in file order, so the ids fix which one is first.
    await saveLocalVault(
      repo.repoContext,
      "first",
      undefined,
      "00000000-0000-4000-8000-000000000000",
    );
    await saveLocalVault(
      repo.repoContext,
      "second",
      undefined,
      "ffffffff-ffff-4fff-bfff-ffffffffffff",
    );

    assertStringIncludes(
      await previewError(repo, "first", true),
      "names no existing defaultVault",
    );
    await removeVault(repo, "second");
    assertEquals(
      await repo.repoContext.vaultConfigRepo.findByName("second"),
      null,
    );
  }, { defaultVault: false });
});

Deno.test("vault remove: keeps secrets a base_dir from another checkout points at", async () => {
  await withRepo(async (repo) => {
    const other = await Deno.makeTempDir({ prefix: "swamp_other_checkout_" });
    try {
      const config = { auto_generate: true, base_dir: other };
      await saveLocalVault(repo.repoContext, "trip-planner", config);
      const provider = new LocalEncryptionVaultProvider("trip-planner", config);
      await provider.put("API_KEY", "s3cret");

      const { preview, secrets } = await removeVault(repo, "trip-planner");

      assertEquals(preview.localStorage?.removable, false);
      assertEquals(secrets?.keptOutsideRepository, true);
      assertEquals(secrets?.removed, false);
      assertEquals(
        await repo.repoContext.vaultConfigRepo.findByName("trip-planner"),
        null,
      );
      assertEquals(await provider.get("API_KEY"), "s3cret");
    } finally {
      await Deno.remove(other, { recursive: true }).catch(() => {});
    }
  });
});
