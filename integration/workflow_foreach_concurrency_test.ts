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
 * Cross-component regression guard for issue #718.
 *
 * A forEach step with concurrency > 1 that fans out child workflow runs
 * (`task.type: workflow`) used to intermittently fail children with
 * "Bad resource ID": every concurrent run registered its log writer under the
 * same catch-all `[]` prefix, so one child's registration closed a sibling's
 * still-open file descriptor before any step executed. This test drives the
 * real `swamp workflow run` path (the same code used in production) and asserts
 * every fanned-out child succeeds and no run reports "Bad resource ID".
 *
 * The deterministic unit tests in
 * src/infrastructure/logging/run_file_sink_test.ts are the authoritative
 * regression guard; this exercises the end-to-end concurrent child-dispatch
 * path that the bug actually manifested on.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { CLI_ARGS } from "./test_helpers.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-foreach-conc-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native handles yet.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function initializeTestRepo(repoDir: string): Promise<void> {
  const subdirs = [
    "models",
    ".swamp/outputs",
    ".swamp/data",
    ".swamp/logs",
    "workflows",
    ".swamp/workflow-runs",
    ".swamp/workflows-evaluated",
  ];
  for (const subdir of subdirs) {
    await ensureDir(join(repoDir, subdir));
  }
  await Deno.writeTextFile(
    join(repoDir, ".swamp.yaml"),
    stringifyYaml(
      {
        swampVersion: "0.0.0",
        initializedAt: new Date().toISOString(),
      } as Record<string, unknown>,
    ),
  );
}

async function createShellModel(repoDir: string, name: string): Promise<void> {
  const modelData = {
    type: "command/shell",
    typeVersion: 1,
    id: crypto.randomUUID(),
    name,
    version: 1,
    tags: {},
    globalArguments: {},
    methods: { execute: { arguments: { run: "echo 'child ran'" } } },
  };
  const modelDir = join(repoDir, "models/command/shell");
  await ensureDir(modelDir);
  await Deno.writeTextFile(
    join(modelDir, `${modelData.id}.yaml`),
    stringifyYaml(modelData as Record<string, unknown>),
  );
}

async function writeWorkflow(
  repoDir: string,
  workflow: Record<string, unknown>,
): Promise<void> {
  const workflowDir = join(repoDir, "workflows");
  await ensureDir(workflowDir);
  await Deno.writeTextFile(
    join(workflowDir, `workflow-${workflow.id}.yaml`),
    stringifyYaml(workflow),
  );
}

async function runCliCommand(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [...CLI_ARGS, ...args],
    stdout: "piped",
    stderr: "piped",
    cwd: Deno.cwd(),
  });
  const { code, stdout, stderr } = await command.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

Deno.test("CLI: forEach concurrency>1 fanning out child workflows does not fail with Bad resource ID", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    await createShellModel(repoDir, "child-model");

    // Child workflow: one model_method step. Fanned out once per parent item.
    await writeWorkflow(repoDir, {
      id: crypto.randomUUID(),
      name: "issue-718-child",
      version: 1,
      inputs: {
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      jobs: [
        {
          name: "work",
          steps: [
            {
              name: "run-child",
              task: {
                type: "model_method",
                modelIdOrName: "child-model",
                methodName: "execute",
              },
              dependsOn: [],
              weight: 0,
            },
          ],
          dependsOn: [],
          weight: 0,
        },
      ],
    });

    // Parent workflow: forEach with concurrency 3 over 6 items, each item
    // triggering the child workflow concurrently — the exact shape from #718.
    const parentId = crypto.randomUUID();
    await writeWorkflow(repoDir, {
      id: parentId,
      name: "issue-718-parent",
      version: 1,
      inputs: {
        properties: {
          items: { type: "array", items: { type: "string" }, minItems: 1 },
        },
        required: ["items"],
      },
      jobs: [
        {
          name: "fan-out",
          steps: [
            {
              name: "child-${{self.item}}",
              forEach: {
                item: "item",
                in: "${{ inputs.items }}",
              },
              concurrency: 3,
              task: {
                type: "workflow",
                workflowIdOrName: "issue-718-child",
                inputs: { id: "${{ self.item }}" },
              },
              dependsOn: [],
              weight: 0,
            },
          ],
          dependsOn: [],
          weight: 0,
        },
      ],
    });

    const items = ["a", "b", "c", "d", "e", "f"];
    const result = await runCliCommand([
      "workflow",
      "run",
      "issue-718-parent",
      "--repo-dir",
      repoDir,
      "--input",
      JSON.stringify({ items }),
      "--json",
    ]);

    // The previously-failing race surfaced as "Bad resource ID" in a failed
    // child step; assert it never appears.
    assertEquals(
      (result.stdout + result.stderr).includes("Bad resource ID"),
      false,
      `Child run failed with "Bad resource ID":\n${result.stderr}\n${result.stdout}`,
    );

    assertEquals(
      result.code,
      0,
      `Workflow should succeed. stderr: ${result.stderr}`,
    );

    const output = JSON.parse(result.stdout);
    const job = output.jobs?.find(
      (j: { name: string }) => j.name === "fan-out",
    );
    const steps = (job?.steps ?? []) as { name: string; status: string }[];

    // Every fanned-out child step must have run and succeeded — none left
    // failed/pending by a dispatch-time crash.
    const expanded = steps.filter((s) => !s.name.includes("${{"));
    assertEquals(
      expanded.length,
      items.length,
      `Expected ${items.length} expanded child steps, got ${expanded.length}: ${
        JSON.stringify(expanded.map((s) => s.name))
      }`,
    );
    for (const step of expanded) {
      assertEquals(
        step.status,
        "succeeded",
        `Expected ${step.name} to succeed but got ${step.status}`,
      );
    }
  });
});
