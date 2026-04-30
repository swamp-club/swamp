// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertRejects } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { ExtensionWorkflowRepository } from "./extension_workflow_repository.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { UserError } from "../../domain/errors.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({
    prefix: "swamp-ext-workflow-test-",
  });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function createWorkflowYaml(
  name: string,
  id?: string,
): Record<string, unknown> {
  return {
    id: id ?? crypto.randomUUID(),
    name,
    version: 1,
    jobs: [
      {
        name: "test-job",
        steps: [
          {
            name: "test-step",
            task: {
              type: "model_method",
              modelIdOrName: "test-model",
              methodName: "test-method",
            },
          },
        ],
      },
    ],
  };
}

Deno.test("ExtensionWorkflowRepository discovers YAML workflows from directory", async () => {
  await withTempDir(async (dir) => {
    const workflowData = createWorkflowYaml("my-extension-workflow");
    await Deno.writeTextFile(
      join(dir, "my-workflow.yaml"),
      stringifyYaml(workflowData),
    );

    const repo = new ExtensionWorkflowRepository(dir);
    const workflows = await repo.findAll();

    assertEquals(workflows.length, 1);
    assertEquals(workflows[0].name, "my-extension-workflow");
  });
});

Deno.test("ExtensionWorkflowRepository discovers workflows in subdirectories", async () => {
  await withTempDir(async (dir) => {
    const subdir = join(dir, "aws");
    await ensureDir(subdir);

    const workflowData = createWorkflowYaml("aws-deploy");
    await Deno.writeTextFile(
      join(subdir, "deploy.yaml"),
      stringifyYaml(workflowData),
    );

    const repo = new ExtensionWorkflowRepository(dir);
    const workflows = await repo.findAll();

    assertEquals(workflows.length, 1);
    assertEquals(workflows[0].name, "aws-deploy");
  });
});

Deno.test("ExtensionWorkflowRepository returns empty for empty directory", async () => {
  await withTempDir(async (dir) => {
    const repo = new ExtensionWorkflowRepository(dir);
    const workflows = await repo.findAll();

    assertEquals(workflows.length, 0);
  });
});

Deno.test("ExtensionWorkflowRepository returns empty for non-existent directory", async () => {
  const repo = new ExtensionWorkflowRepository("/nonexistent/path");
  const workflows = await repo.findAll();

  assertEquals(workflows.length, 0);
});

Deno.test("ExtensionWorkflowRepository skips broken YAML files", async () => {
  await withTempDir(async (dir) => {
    // Write a valid workflow
    const validData = createWorkflowYaml("valid-workflow");
    await Deno.writeTextFile(
      join(dir, "valid.yaml"),
      stringifyYaml(validData),
    );

    // Write an invalid YAML file
    await Deno.writeTextFile(
      join(dir, "broken.yaml"),
      "this is: not: valid: yaml: [",
    );

    const repo = new ExtensionWorkflowRepository(dir);
    const workflows = await repo.findAll();

    assertEquals(workflows.length, 1);
    assertEquals(workflows[0].name, "valid-workflow");
  });
});

Deno.test("ExtensionWorkflowRepository findByName returns matching workflow", async () => {
  await withTempDir(async (dir) => {
    const workflowData = createWorkflowYaml("find-me");
    await Deno.writeTextFile(
      join(dir, "findme.yaml"),
      stringifyYaml(workflowData),
    );

    const repo = new ExtensionWorkflowRepository(dir);
    const workflow = await repo.findByName("find-me");

    assertEquals(workflow?.name, "find-me");
  });
});

Deno.test("ExtensionWorkflowRepository findByName returns null for non-existent", async () => {
  await withTempDir(async (dir) => {
    const repo = new ExtensionWorkflowRepository(dir);
    const workflow = await repo.findByName("nonexistent");

    assertEquals(workflow, null);
  });
});

Deno.test("ExtensionWorkflowRepository findById returns matching workflow", async () => {
  await withTempDir(async (dir) => {
    const id = crypto.randomUUID();
    const workflowData = createWorkflowYaml("by-id-workflow", id);
    await Deno.writeTextFile(
      join(dir, "byid.yaml"),
      stringifyYaml(workflowData),
    );

    const repo = new ExtensionWorkflowRepository(dir);
    const workflow = await repo.findById(
      id as ReturnType<typeof repo.nextId>,
    );

    assertEquals(workflow?.name, "by-id-workflow");
  });
});

Deno.test("ExtensionWorkflowRepository save throws UserError", async () => {
  await withTempDir(async (dir) => {
    const repo = new ExtensionWorkflowRepository(dir);
    const workflow = Workflow.create({ name: "test" });

    await assertRejects(
      () => repo.save(workflow),
      UserError,
      "read-only",
    );
  });
});

Deno.test("ExtensionWorkflowRepository delete throws UserError", async () => {
  await withTempDir(async (dir) => {
    const repo = new ExtensionWorkflowRepository(dir);

    await assertRejects(
      () => repo.delete(repo.nextId()),
      UserError,
      "read-only",
    );
  });
});
