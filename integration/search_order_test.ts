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
 * Model, workflow and vault search list a repository in the same order on
 * every filesystem (swamp-club#3067). The search generators do not sort, so
 * the order they emit is the order the filesystem repositories walk their
 * directories in; readdir order is hash order on ext4 and creation order on
 * tmpfs. Each test saves out of name order through the real repositories and
 * asserts the generator's result order without sorting it first.
 */

import "../src/domain/models/models.ts";
import { assertEquals, assertExists } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { VaultConfig } from "../src/domain/vaults/vault_config.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { CompositeWorkflowRepository } from "../src/infrastructure/persistence/composite_workflow_repository.ts";
import { ExtensionWorkflowRepository } from "../src/infrastructure/persistence/extension_workflow_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { YamlVaultConfigRepository } from "../src/infrastructure/persistence/yaml_vault_config_repository.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { modelSearch } from "../src/libswamp/models/search.ts";
import { collect } from "../src/libswamp/testing.ts";
import { vaultSearch } from "../src/libswamp/vaults/search.ts";
import { workflowSearch } from "../src/libswamp/workflows/search.ts";

await initializeLogging({});

const UNORDERED = ["mango", "zebra", "apple", "kiwi", "banana"];
const ORDERED = ["apple", "banana", "kiwi", "mango", "zebra"];

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-search-order-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function workflowNamed(name: string): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("test-model", "run"),
          }),
        ],
      }),
    ],
  });
}

async function completedNames<
  E extends { kind: string },
>(events: AsyncIterable<E>): Promise<string[]> {
  const completed = (await collect(events)).find((e) => e.kind === "completed");
  assertExists(completed, "search emitted no completed event");
  const data = (completed as unknown as {
    data: { results: Array<{ name: string }> };
  }).data;
  return data.results.map((r) => r.name);
}

Deno.test("model search: lists definitions in type then name order", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDefinitionRepository(dir);
    const zeta = ModelType.create("test/search-order-zeta");
    const alpha = ModelType.create("test/search-order-alpha");
    for (const name of UNORDERED) {
      await repo.save(zeta, Definition.create({ name: `z-${name}` }));
      await repo.save(alpha, Definition.create({ name: `a-${name}` }));
    }

    const fresh = new YamlDefinitionRepository(dir);
    const names = await completedNames(
      modelSearch(
        createLibSwampContext(),
        { findAllGlobal: () => fresh.findAllGlobal() },
        {},
      ),
    );

    assertEquals(names, [
      ...ORDERED.map((n) => `a-${n}`),
      ...ORDERED.map((n) => `z-${n}`),
    ]);
  });
});

Deno.test("workflow search: lists repository workflows then extension workflows, each in name order", async () => {
  await withTempDir(async (dir) => {
    const primary = new YamlWorkflowRepository(dir);
    for (const name of UNORDERED) await primary.save(workflowNamed(name));
    const extensionDir = join(dir, "extension-workflows");
    await ensureDir(extensionDir);
    for (const name of UNORDERED) {
      await Deno.writeTextFile(
        join(extensionDir, `ext-${name}.yaml`),
        stringifyYaml(
          JSON.parse(JSON.stringify(workflowNamed(`ext-${name}`).toData())),
        ),
      );
    }

    const repo = new CompositeWorkflowRepository(
      new YamlWorkflowRepository(dir),
      new ExtensionWorkflowRepository(extensionDir),
    );
    const names = await completedNames(
      workflowSearch(
        createLibSwampContext(),
        { findAllWorkflows: () => repo.findAll() },
        {},
      ),
    );

    assertEquals(names, [...ORDERED, ...ORDERED.map((n) => `ext-${n}`)]);
  });
});

Deno.test("vault search: lists vaults in type then id order", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlVaultConfigRepository(dir);
    // Vault files are named by id, so ids that sort like the names make the
    // expected order readable.
    for (const name of UNORDERED) {
      await repo.save(VaultConfig.create(`id-${name}`, name, "mock", {}));
    }

    const names = await completedNames(
      vaultSearch(
        createLibSwampContext(),
        { findAllVaults: () => repo.findAll() },
        {},
      ),
    );

    assertEquals(names, ORDERED);
  });
});
