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
 * The contract between swamp's evaluated-workflow snapshots and the
 * attestation's provenance check (swamp-club#2815): a committed verification
 * workflow, persisted the way a run persists it, must still match the
 * committed file. A new key the repository starts writing at the root of the
 * snapshot fails here rather than refusing every attestation after release.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { ROOT } from "./arch_fitness_helpers.ts";
import { checkWorkflowProvenance } from "../scripts/build_attestation.ts";
import {
  Workflow,
  type WorkflowInput,
} from "../src/domain/workflows/workflow.ts";
import { YamlEvaluatedWorkflowRepository } from "../src/infrastructure/persistence/yaml_evaluated_workflow_repository.ts";

const VERIFICATION_DIR = join(ROOT, "verification");

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-provenance-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native handles yet.
      // Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function committedWorkflowFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(VERIFICATION_DIR)) {
    if (
      entry.isFile && entry.name.startsWith("workflow-") &&
      entry.name.endsWith(".yaml")
    ) {
      files.push(entry.name);
    }
  }
  return files.sort();
}

Deno.test("checkWorkflowProvenance: a run snapshot of each committed verification workflow matches it", async () => {
  const files = await committedWorkflowFiles();
  assertEquals(files.length > 0, true, "no verification workflows found");

  for (const file of files) {
    await withTempDir(async (dir) => {
      const committed = parseYaml(
        await Deno.readTextFile(join(VERIFICATION_DIR, file)),
      );
      const repo = new YamlEvaluatedWorkflowRepository(dir);
      const runId = crypto.randomUUID();
      await repo.saveForRun(
        runId,
        Workflow.fromData(committed as WorkflowInput),
        [{
          path: ["jobs", 0, "steps", 0, "task", "inputs"],
          occurrence: 0,
          vaultName: "ci",
          key: "token",
          encoding: "raw",
          dataOrigin: false,
        }],
      );

      const snapshot = parseYaml(
        await Deno.readTextFile(
          join(
            dir,
            ".swamp",
            "workflows-evaluated",
            "runs",
            runId,
            "evaluated-workflow.yaml",
          ),
        ),
      );

      assertEquals(checkWorkflowProvenance(committed, snapshot), [], file);
    });
  }
});
