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
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { Definition } from "../src/domain/definitions/definition.ts";
import { DEFAULT_MODELS_DIR } from "../src/domain/terminology/behavior_aliases.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { SHELL_MODEL_TYPE } from "../src/domain/models/command/shell/shell_model.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import { resolvePulledExtensionsRoot } from "../src/infrastructure/persistence/paths.ts";
import { requireInitializedRepoReadOnly } from "../src/cli/repo_context.ts";
import { VERSION } from "../src/cli/commands/version.ts";
import { collect } from "../src/libswamp/testing.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { workflowsDirFor } from "../src/libswamp/workflows/broken_workflow.ts";
import {
  createWorkflowValidateDeps,
  isWorkflowValidateAllData,
  pulledExtensionWorkflowScope,
  workflowValidate,
  type WorkflowValidateData,
  type WorkflowValidateEvent,
} from "../src/libswamp/workflows/validate.ts";

await initializeLogging({});

const EXTENSION = "@someone/docker";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-validate-pulled-" });
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

function workflowCalling(
  name: string,
  modelIdOrName: string,
  method: string,
): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "call",
            task: StepTask.model(modelIdOrName, method),
          }),
        ],
      }),
    ],
  });
}

async function writeWorkflowFile(
  dir: string,
  workflow: Workflow,
): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, `${workflow.name}.yaml`),
    stringifyYaml(JSON.parse(JSON.stringify(workflow.toData()))),
  );
}

async function completed(
  events: AsyncIterable<WorkflowValidateEvent>,
): Promise<Extract<WorkflowValidateEvent, { kind: "completed" }>["data"]> {
  const all = await collect<WorkflowValidateEvent>(events);
  const last = all[all.length - 1];
  if (last.kind !== "completed") {
    throw new Error(`expected completed: ${last.kind}`);
  }
  return last.data;
}

Deno.test("workflow validate: without a workflow, a pulled extension's workflow is skipped and counted, and validated when named", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    await Deno.mkdir(repoDir, { recursive: true });
    const homeDir = join(repoDir, "test-home");
    await new RepoService(VERSION, {
      homeDir,
      configDir: join(homeDir, ".config", "swamp"),
    }).init(RepoPath.create(repoDir), { tools: [] });

    const pulledRoot = resolvePulledExtensionsRoot(repoDir);
    const pulledWorkflows = join(pulledRoot, EXTENSION, "workflows");
    await writeWorkflowFile(
      pulledWorkflows,
      workflowCalling("setup-docker", "fleet", "lookup"),
    );
    const lockfile = await LockfileRepository.create(
      join(repoDir, DEFAULT_MODELS_DIR, "upstream_extensions.json"),
    );
    await lockfile.writeEntry(EXTENSION, "2026.01.01.1", [
      `.swamp/pulled-extensions/${EXTENSION}/workflows/setup-docker.yaml`,
    ]);
    await writeWorkflowFile(
      join(repoDir, "extensions", "workflows"),
      workflowCalling("authored-ext", "fleet", "execute"),
    );

    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir,
      outputMode: "json",
    });
    try {
      await repoContext.definitionRepo.save(
        SHELL_MODEL_TYPE,
        Definition.create({
          name: "fleet",
          type: SHELL_MODEL_TYPE.normalized,
          globalArguments: {},
        }),
      );
      await repoContext.workflowRepo.save(
        workflowCalling("own", "fleet", "execute"),
      );
      await modelRegistry.ensureLoaded();

      const deps = {
        ...createWorkflowValidateDeps(
          repoContext.workflowRepo,
          repoContext.definitionRepo,
          workflowsDirFor(repoDir),
        ),
        ...pulledExtensionWorkflowScope(repoContext, pulledRoot),
      };

      const all = await completed(
        workflowValidate(createLibSwampContext(), deps, {}),
      );
      if (!isWorkflowValidateAllData(all)) throw new Error("expected all data");
      assertEquals(
        all.workflows.map((w) => w.workflowName).sort(),
        ["authored-ext", "own"],
      );
      assertEquals(all.pulledWorkflowsSkipped, 1);

      const named = await completed(
        workflowValidate(createLibSwampContext(), deps, {
          workflowIdOrName: "setup-docker",
        }),
      ) as WorkflowValidateData;
      assertEquals(named.passed, false);
      const failure = named.validations.find((v) => !v.passed && !v.warning);
      assertStringIncludes(
        String(failure?.error),
        "Method 'lookup' not found on behavior type 'command/shell'",
      );
    } finally {
      repoContext.catalogStore.close();
    }
  });
});
