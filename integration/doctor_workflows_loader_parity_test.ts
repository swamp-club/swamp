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

// Pins swamp doctor workflows to the files the workflow loader reads
// (swamp-club#2942): doctor takes its directories from the same repository
// context the loader uses and applies each loader's file rule, so a workflow
// doctor passes is one the loader loads, a loadable file the loader never
// reads is a warning, and nothing the loader skips as non-workflow YAML is
// reported.

import { assertEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { assertPathArrayEquals } from "../src/infrastructure/persistence/path_test_helpers.ts";
import {
  collect,
  doctorWorkflowDirs,
  doctorWorkflows,
  type DoctorWorkflowsEvent,
} from "../src/libswamp/mod.ts";

function workflowYaml(name: string, taskType = "model_method"): string {
  return `id: "${crypto.randomUUID()}"
name: ${name}
jobs:
  - name: job
    steps:
      - name: step
        task:
          type: ${taskType}
          modelIdOrName: my-model
          methodName: validate
`;
}

async function writeFile(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await Deno.writeTextFile(path, content);
}

Deno.test("doctor workflows: checks exactly the workflows the loader reads", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_doctor_parity_" });
  const repoDir = join(dir, "repo");
  // Stands in for a managed config base: the loader's primary dir is not
  // repoDir/workflows.
  const yamlWorkflowsDir = join(dir, "config-base", "workflows");
  const extensionDir = join(repoDir, "extensions", "workflows");
  const sourceDir = join(dir, "source", "workflows");

  await writeFile(
    join(yamlWorkflowsDir, "workflow-primary.yaml"),
    workflowYaml("primary"),
  );
  await writeFile(
    join(yamlWorkflowsDir, "deploy.yaml"),
    workflowYaml("deploy"),
  );
  await writeFile(join(extensionDir, "flat.yaml"), workflowYaml("ext-flat"));
  await writeFile(
    join(extensionDir, "ns", "nested.yml"),
    workflowYaml("ext-nested"),
  );
  await writeFile(
    join(extensionDir, "ns", "broken.yaml"),
    workflowYaml("ext-broken", "not_a_real_task"),
  );
  await writeFile(
    join(extensionDir, "ns", "manifest.yaml"),
    "manifestVersion: 1\nname: '@test/ext'\n",
  );
  await writeFile(join(sourceDir, "data.yaml"), "networks:\n  - default\n");
  await writeFile(join(sourceDir, "deep", "src.yml"), workflowYaml("source"));
  // A repo-local workflows dir the loader does not read here.
  await writeFile(
    join(repoDir, "workflows", "workflow-stale.yaml"),
    workflowYaml("stale", "not_a_real_task"),
  );

  const context = createRepositoryContext({
    repoDir,
    enableIndexing: false,
    yamlWorkflowsDir,
    workflowsDir: extensionDir,
    additionalWorkflowsDirs: [sourceDir],
  });
  try {
    const events = await collect<DoctorWorkflowsEvent>(
      doctorWorkflows({
        ...doctorWorkflowDirs(context),
        abortSignal: new AbortController().signal,
      }),
    );
    const report = (events.at(-1) as Extract<
      DoctorWorkflowsEvent,
      { kind: "completed" }
    >).report;

    const loaded = (await context.workflowRepo.findAll())
      .map((w) => w.name).sort();
    const passed = report.workflows
      .filter((w) => w.status === "pass")
      .map((w) => w.name ?? "").sort();
    assertEquals(passed, loaded);
    assertEquals(loaded, [
      "ext-flat",
      "ext-nested",
      "primary",
      "source",
    ]);

    assertPathArrayEquals(
      report.workflows.filter((w) => w.status === "fail").map((w) => w.file),
      [join(extensionDir, "ns", "broken.yaml")],
    );
    // A loadable workflow the loader never reads warns rather than fails.
    assertPathArrayEquals(
      report.workflows.filter((w) => w.status === "warn").map((w) => w.file),
      [join(yamlWorkflowsDir, "deploy.yaml")],
    );
  } finally {
    context.catalogStore.close();
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
