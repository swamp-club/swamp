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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Command } from "@cliffy/command";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { requireInitializedRepoUnlocked } from "../repo_context.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoService } from "../../domain/repo/repo_service.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import {
  type ServeConfigFile,
  writeServeConfigFile,
} from "../../serve/serve_config.ts";
import type { WorkflowTriggerGetResult } from "../../serve/protocol.ts";
import { withMockedEnv } from "../../infrastructure/persistence/path_test_helpers.ts";
import { VERSION } from "../../infrastructure/runtime/build_info.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

Deno.test("workflowTriggerGetCommand: has correct name", async () => {
  const { workflowTriggerGetCommand } = await import(
    "./workflow_trigger_get.ts"
  );
  assertEquals(workflowTriggerGetCommand.getName(), "get");
});

Deno.test("workflowTriggerGetCommand: has repo-dir option", async () => {
  const { workflowTriggerGetCommand } = await import(
    "./workflow_trigger_get.ts"
  );
  const options = workflowTriggerGetCommand.getOptions();
  const repoDirOpt = options.find((o) => o.name === "repo-dir");
  assertEquals(repoDirOpt !== undefined, true);
});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-workflow-trigger-get-" });
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

async function initRepoWith(
  dir: string,
  trigger: {
    schedule: string;
    catchUp?: { policy: "none" | "latest"; maxDelay?: string };
  },
  serveConfig: ServeConfigFile,
): Promise<void> {
  // Keep the global skill install inside `dir`, away from the shared HOME.
  const homeDir = join(dir, "test-home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(dir), { tools: [] });
  const { repoContext } = await requireInitializedRepoUnlocked({
    repoDir: dir,
    outputMode: "json",
  });
  await repoContext.workflowRepo.save(Workflow.create({
    name: "scan-cves",
    trigger,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "scan",
            task: StepTask.model("scanner", "run"),
          }),
        ],
      }),
    ],
  }));
  await writeServeConfigFile(dir, serveConfig);
}

// with no serve URL in the environment the command reads the local repo
function triggerGet(dir: string): Promise<WorkflowTriggerGetResult> {
  return withMockedEnv(
    { SWAMP_SERVE_URL: undefined, SWAMP_SERVER_URL: undefined },
    async () => {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(msg);
      try {
        const { workflowTriggerGetCommand } = await import(
          "./workflow_trigger_get.ts"
        );
        await new Command()
          .throwErrors()
          .globalOption("--json", "JSON output")
          .command("get", workflowTriggerGetCommand)
          .parse(["get", "scan-cves", "--json", "--repo-dir", dir]);
      } finally {
        console.log = originalLog;
      }
      return JSON.parse(logs[logs.length - 1]) as WorkflowTriggerGetResult;
    },
  );
}

Deno.test("workflowTriggerGetCommand: the override's catch-up policy is the effective one", async () => {
  await withTempDir(async (dir) => {
    await initRepoWith(
      dir,
      { schedule: "0 6 * * *", catchUp: { policy: "latest", maxDelay: "2h" } },
      {
        triggers: {
          "scan-cves": { schedule: "0 3 * * *", catchUp: { policy: "none" } },
        },
      },
    );

    const result = await triggerGet(dir);

    assertEquals(result.builtIn?.catchUp, { policy: "latest", maxDelay: "2h" });
    assertEquals(result.override?.catchUp, { policy: "none" });
    assertEquals(result.effective.catchUp, { policy: "none" });
    assertEquals(result.effective.schedule, "0 3 * * *");
  });
});

Deno.test("workflowTriggerGetCommand: the built-in catch-up policy applies when the override sets none", async () => {
  await withTempDir(async (dir) => {
    await initRepoWith(
      dir,
      { schedule: "0 6 * * *", catchUp: { policy: "latest", maxDelay: "2h" } },
      { triggers: { "scan-cves": { schedule: "0 3 * * *" } } },
    );

    const result = await triggerGet(dir);

    assertEquals(result.effective.catchUp, {
      policy: "latest",
      maxDelay: "2h",
    });
    assertEquals(result.effective.schedule, "0 3 * * *");
  });
});

Deno.test("workflowTriggerGetCommand: effective catch-up is null when neither sets one", async () => {
  await withTempDir(async (dir) => {
    await initRepoWith(dir, { schedule: "0 6 * * *" }, {
      triggers: { "scan-cves": { schedule: "0 3 * * *" } },
    });

    const result = await triggerGet(dir);

    assertEquals(result.builtIn?.catchUp, null);
    assertEquals(result.effective.catchUp, null);
  });
});
