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
 * Integration tests for swamp data delete.
 *
 * Exercises the full slice against a real FileSystemUnifiedDataRepository:
 * (a) full-artifact delete removes directory + catalog row
 * (b) --version delete removes only that version, updates latest pointer
 * (c) missing artifact surfaces as a clear error
 * (d) --version against non-existent version names available versions
 */

import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { Data } from "../src/domain/data/data.ts";
import type { OwnerDefinition } from "../src/domain/data/data_metadata.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { DataDeleteService } from "../src/domain/data/data_delete_service.ts";
import { SHELL_MODEL_TYPE } from "../src/domain/models/command/shell/shell_model.ts";
import { CLI_ARGS } from "./test_helpers.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-data-delete-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native sqlite handles
      // yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function setupRepoDir(dir: string): Promise<void> {
  await ensureDir(join(dir, ".swamp", "data"));
  await ensureDir(join(dir, "models"));
}

function createOwner(ref: string): OwnerDefinition {
  return { ownerType: "model-method", ownerRef: ref };
}

interface Wired {
  service: DataDeleteService;
  dataRepo: FileSystemUnifiedDataRepository;
  type: ModelType;
  modelId: string;
}

async function wireService(repoDir: string): Promise<Wired> {
  const dataRepo = new FileSystemUnifiedDataRepository(
    repoDir,
    undefined,
    new CatalogStore(join(repoDir, "_catalog.db")),
  );
  const definitionRepo = new YamlDefinitionRepository(repoDir);
  const type = ModelType.create("test/delete");
  const definition = Definition.create({ name: "delete-target" });
  await definitionRepo.save(type, definition);
  const service = new DataDeleteService(dataRepo, definitionRepo);
  return { service, dataRepo, type, modelId: definition.id };
}

async function writeVersions(
  dataRepo: FileSystemUnifiedDataRepository,
  type: ModelType,
  modelId: string,
  dataName: string,
  count: number,
): Promise<void> {
  const data = Data.create({
    name: dataName,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "state" },
    ownerDefinition: createOwner("test/delete:writeVersions"),
  });
  for (let i = 1; i <= count; i++) {
    await dataRepo.save(
      type,
      modelId,
      data,
      new TextEncoder().encode(JSON.stringify({ v: i })),
    );
  }
}

Deno.test("Data Delete: full-artifact delete removes directory and catalog row", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const { service, dataRepo, type, modelId } = await wireService(repoDir);

    await writeVersions(dataRepo, type, modelId, "stale-state", 3);

    // Sanity: 3 versions, latest points to v3
    const before = await dataRepo.listVersions(type, modelId, "stale-state");
    assertEquals(before, [1, 2, 3]);
    const beforeLatest = await dataRepo.findByName(
      type,
      modelId,
      "stale-state",
    );
    assertEquals(beforeLatest?.version, 3);

    const result = await service.delete("delete-target", "stale-state");

    assertEquals(result.versionsDeleted, 3);
    assertEquals(result.version, undefined);

    // Directory gone
    const after = await dataRepo.listVersions(type, modelId, "stale-state");
    assertEquals(after, []);
    // Catalog reflects removal
    const afterLookup = await dataRepo.findByName(
      type,
      modelId,
      "stale-state",
    );
    assertEquals(afterLookup, null);
  });
});

Deno.test("Data Delete: --version removes only that version, latest follows", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const { service, dataRepo, type, modelId } = await wireService(repoDir);

    await writeVersions(dataRepo, type, modelId, "rollback", 3);

    const result = await service.delete("delete-target", "rollback", 2);

    assertEquals(result.versionsDeleted, 1);
    assertEquals(result.version, 2);

    // Versions 1 and 3 remain, version 2 is gone
    const remaining = await dataRepo.listVersions(type, modelId, "rollback");
    assertEquals(remaining.sort((a, b) => a - b), [1, 3]);

    // Latest still points to 3 (the highest remaining version)
    const latest = await dataRepo.findByName(type, modelId, "rollback");
    assertExists(latest);
    assertEquals(latest.version, 3);
  });
});

Deno.test("Data Delete: missing artifact throws a clear error", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const { service } = await wireService(repoDir);

    await assertRejects(
      () => service.delete("delete-target", "never-existed"),
      Error,
      'No data named "never-existed" exists for model delete-target',
    );
  });
});

Deno.test("Data Delete: --version against non-existent version names available versions", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const { service, dataRepo, type, modelId } = await wireService(repoDir);

    await writeVersions(dataRepo, type, modelId, "partial", 3);

    const error = await assertRejects(
      () => service.delete("delete-target", "partial", 99),
      Error,
    );
    // Message must name the available versions so the user knows what to pick
    assertEquals(
      error.message.includes('Version 99 does not exist for "partial"'),
      true,
    );
    assertEquals(
      error.message.includes("available versions: 1, 2, 3"),
      true,
    );

    // No versions were removed by the failed attempt
    const after = await dataRepo.listVersions(type, modelId, "partial");
    assertEquals(after.sort((a, b) => a - b), [1, 2, 3]);
  });
});

// ============================================================================
// Concurrent writer / delete smoke test (regression for swamp-club#234)
// ============================================================================
//
// Smoke regression for the symmetric drain in `requireInitializedRepo`: a
// concurrent writer creating a new version directory between the deleter's
// pre-acquire drain and the rmdir caused
// `Deno.remove(dataNameDir, { recursive: true })` to fail with ENOTEMPTY
// (Linux: os error 39, macOS: os error 66). The architectural fix lives in
// src/cli/repo_context.ts; the deterministic regression for the polling
// primitive lives in src/cli/repo_context_test.ts.
//
// This test is non-deterministic by design — it spawns real CLI processes
// across N iterations and asserts no ENOTEMPTY error appears. The original
// bug reproduced in ~40 attempts under high writer pressure (4 parallel
// writers + tight delete loop), so N=50 single-writer iterations gives a
// margin large enough to catch a future regression with reasonable
// probability while staying within integration-suite wall-clock budgets.
// Do not silently shrink N below 50 — read swamp-club#234 first.

const RACE_ITERATIONS = 50;
const SHELL_SLEEP_MS = 300;

async function runSwamp(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: [...CLI_ARGS, ...args],
    stdout: "piped",
    stderr: "piped",
    cwd,
  }).output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

async function initializeShellRepo(repoDir: string): Promise<void> {
  for (
    const sub of [
      "models",
      ".swamp/outputs",
      ".swamp/data",
      ".swamp/logs",
    ]
  ) {
    await ensureDir(join(repoDir, sub));
  }
  await Deno.writeTextFile(
    join(repoDir, ".swamp.yaml"),
    stringifyYaml({
      swampVersion: "0.0.0",
      initializedAt: new Date().toISOString(),
    } as Record<string, unknown>),
  );

  // Shell model that holds the per-model lock for ~SHELL_SLEEP_MS, giving
  // the concurrent delete a window to race the writer.
  const definitionRepo = new YamlDefinitionRepository(repoDir);
  const definition = Definition.create({
    name: "race-writer",
    methods: {
      execute: {
        arguments: {
          run: `sleep ${SHELL_SLEEP_MS / 1000}; echo done`,
        },
      },
    },
  });
  await definitionRepo.save(SHELL_MODEL_TYPE, definition);
}

function assertNoEnoTempty(label: string, combined: string): void {
  for (
    const marker of [
      "Directory not empty",
      "os error 39",
      "os error 66",
    ]
  ) {
    assertEquals(
      combined.includes(marker),
      false,
      `${label} contains race marker "${marker}":\n${combined}`,
    );
  }
}

Deno.test({
  name:
    "Data Delete: 50 iterations of concurrent writer + delete leave no ENOTEMPTY (swamp-club#234)",
  // Subprocess spawn means file handles outlive the test scope on some
  // platforms; the existing CLI integration tests share this exemption.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withTempDir(async (repoDir) => {
      await initializeShellRepo(repoDir);

      // Seed one version so the first delete has something to remove.
      const seed = await runSwamp(
        ["model", "method", "run", "race-writer", "execute", "--json"],
        repoDir,
      );
      assertEquals(
        seed.code,
        0,
        `Seed write must succeed. stderr: ${seed.stderr}`,
      );

      for (let i = 0; i < RACE_ITERATIONS; i++) {
        const writer = runSwamp(
          ["model", "method", "run", "race-writer", "execute", "--json"],
          repoDir,
        );
        // Brief delay so the writer establishes its per-model lock before
        // the deleter runs its first drain.
        await new Promise((resolve) => setTimeout(resolve, 30));
        const deleter = runSwamp(
          ["data", "delete", "race-writer", "result", "--force", "--json"],
          repoDir,
        );

        const [w, d] = await Promise.all([writer, deleter]);

        assertNoEnoTempty(
          `iteration ${i} writer (code=${w.code})`,
          `${w.stdout}\n${w.stderr}`,
        );
        assertNoEnoTempty(
          `iteration ${i} deleter (code=${d.code})`,
          `${d.stdout}\n${d.stderr}`,
        );
      }
    });
  },
});
