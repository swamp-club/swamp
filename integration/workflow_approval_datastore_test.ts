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
 * Integration test: manual_approval workflows must be approvable and resumable
 * when a non-repo-local datastore is configured. Regression test for
 * swamp-club#493 (dup swamp-club#496).
 *
 * The bug: `workflow approve` / `resume` / `approvals` / `reject` constructed
 * a repo-local `YamlWorkflowRunRepository(repoDir)`, so they looked in
 * `.swamp/workflow-runs/` while the suspended run state actually lives at the
 * datastore-resolved `<datastore>/workflow-runs/`. They reported "No suspended
 * runs found" (and an empty approvals list) even though `workflow run` had
 * suspended the run and `workflow history` could see it.
 *
 * This exercises the real CLI end-to-end against a FILESYSTEM datastore at an
 * external path — the same DatastorePathResolver routing the S3 datastore uses,
 * with no S3 dependency.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { ensureDir, exists } from "@std/fs";
import { stringify as stringifyYaml } from "@std/yaml";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";

const PROJECT_ROOT = join(dirname(fromFileUrl(import.meta.url)), "..");

const CLI_ARGS = [
  "run",
  "--config",
  join(PROJECT_ROOT, "deno.json"),
  "--unstable-bundle",
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-run",
  "--allow-sys",
  join(PROJECT_ROOT, "main.ts"),
];

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[]): Promise<CliResult> {
  const abort = new AbortController();
  const timeoutId = setTimeout(() => abort.abort(), 60_000);
  try {
    const command = new Deno.Command(Deno.execPath(), {
      args: [...CLI_ARGS, ...args],
      stdout: "piped",
      stderr: "piped",
      cwd: Deno.cwd(),
      signal: abort.signal,
    });
    const { code, stdout, stderr } = await command.output();
    return {
      code,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Whether a `workflow-run-*.yaml` state file exists directly under `dir`.
 * The run LOG (`*.log`) always stays repo-local; only the run STATE yaml is
 * routed to the datastore — so the state file is what distinguishes the two
 * tiers.
 */
async function hasRunStateFile(dir: string): Promise<boolean> {
  if (!(await exists(dir))) return false;
  for await (const entry of Deno.readDir(dir)) {
    if (
      entry.isFile && entry.name.startsWith("workflow-run-") &&
      entry.name.endsWith(".yaml")
    ) {
      return true;
    }
  }
  return false;
}

async function withTempDir(
  prefix: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix });
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

/**
 * Initialize a repo whose `.swamp.yaml` marker points `workflow-runs` (and the
 * other default datastore subdirs) at an external filesystem datastore path.
 */
async function initializeRepoWithDatastore(
  repoDir: string,
  datastorePath: string,
): Promise<void> {
  for (
    const subdir of [
      "models",
      ".swamp/outputs",
      ".swamp/data",
      ".swamp/workflow-runs",
      "workflows",
      "vaults",
      ".swamp/secrets",
    ]
  ) {
    await ensureDir(join(repoDir, subdir));
  }
  await ensureDir(datastorePath);

  const markerData = {
    swampVersion: "0.0.0",
    initializedAt: new Date().toISOString(),
    datastore: {
      type: "filesystem",
      path: datastorePath,
    },
  };
  await Deno.writeTextFile(
    join(repoDir, ".swamp.yaml"),
    stringifyYaml(markerData as Record<string, unknown>),
  );
}

Deno.test(
  "workflow approval: approve/resume/approvals find a suspended run on a configured datastore (regression #493)",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    await withTempDir("swamp-approval-ds-repo-", async (repoDir) => {
      await withTempDir(
        "swamp-approval-ds-store-",
        async (datastorePath) => {
          await initializeRepoWithDatastore(repoDir, datastorePath);

          // A manual_approval gate. The workflow DEFINITION stays repo-local
          // (workflows/ is not a datastore subdir); the RUN state is what gets
          // routed to the datastore.
          const workflowRepo = new YamlWorkflowRepository(repoDir);
          const workflow = Workflow.create({
            name: "approve-flow",
            jobs: [
              Job.create({
                name: "review",
                steps: [
                  Step.create({
                    name: "review-gate",
                    task: StepTask.manualApproval(
                      "Review before proceeding",
                      3600,
                    ),
                  }),
                ],
              }),
            ],
          });
          await workflowRepo.save(workflow);

          // 1. Run → the run suspends at the approval gate.
          const run = await runCli([
            "workflow",
            "run",
            "approve-flow",
            "--repo-dir",
            repoDir,
            "--json",
            "--skip-reports",
            "--skip-checks",
          ]);
          assertEquals(
            run.code,
            0,
            `workflow run should exit 0.\nstdout: ${run.stdout}\nstderr: ${run.stderr}`,
          );
          assertStringIncludes(
            run.stdout,
            "suspended",
            "workflow run should report the run as suspended",
          );

          // 2. The suspended run STATE yaml must live in the datastore, not
          // repo-local. This is the divergence the bug hinged on. (The run
          // .log stays repo-local, so the repo-local run dir may exist — we
          // assert specifically that the STATE file is not there.)
          const dsRunsDir = join(datastorePath, "workflow-runs", workflow.id);
          assertEquals(
            await hasRunStateFile(dsRunsDir),
            true,
            `expected run state yaml under the datastore at ${dsRunsDir}`,
          );
          assertEquals(
            await hasRunStateFile(
              join(repoDir, ".swamp", "workflow-runs", workflow.id),
            ),
            false,
            "run state yaml must NOT be written to repo-local .swamp/workflow-runs/",
          );

          // 3. `workflow approvals` must list the pending gate. Before the fix
          // this returned an empty list.
          const approvals = await runCli([
            "workflow",
            "approvals",
            "--repo-dir",
            repoDir,
            "--json",
          ]);
          assertEquals(
            approvals.code,
            0,
            `workflow approvals should exit 0.\nstderr: ${approvals.stderr}`,
          );
          const approvalsJson = JSON.parse(approvals.stdout) as {
            approvals: Array<{ workflowName: string; stepName: string }>;
          };
          assertEquals(
            approvalsJson.approvals.length,
            1,
            `expected one pending approval, got: ${approvals.stdout}`,
          );
          assertEquals(approvalsJson.approvals[0].stepName, "review-gate");

          // 4. `workflow approve` must find and approve the suspended run.
          // Before the fix this failed with "No suspended runs found".
          const approve = await runCli([
            "workflow",
            "approve",
            "approve-flow",
            "review-gate",
            "--repo-dir",
            repoDir,
            "--json",
          ]);
          assertEquals(
            approve.code,
            0,
            `workflow approve should exit 0.\nstdout: ${approve.stdout}\nstderr: ${approve.stderr}`,
          );

          // 5. `workflow resume` continues the run to completion.
          const resume = await runCli([
            "workflow",
            "resume",
            "approve-flow",
            "--repo-dir",
            repoDir,
            "--json",
          ]);
          assertEquals(
            resume.code,
            0,
            `workflow resume should exit 0.\nstdout: ${resume.stdout}\nstderr: ${resume.stderr}`,
          );

          // 6. Durability across process exit: a fresh `history get` (separate
          // process, reading the datastore) must show the approval persisted —
          // the gate is no longer waiting and the run is no longer suspended.
          const history = await runCli([
            "workflow",
            "history",
            "get",
            "approve-flow",
            "--repo-dir",
            repoDir,
            "--json",
          ]);
          assertEquals(
            history.code,
            0,
            `workflow history get should exit 0.\nstderr: ${history.stderr}`,
          );
          const historyJson = JSON.parse(history.stdout) as { status: string };
          assertEquals(
            historyJson.status === "suspended",
            false,
            `run should no longer be suspended after approve+resume, got status "${historyJson.status}"`,
          );
        },
      );
    });
  },
);
