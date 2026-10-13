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
 * Datastore setup leaves repo-local files where their readers look
 * (swamp-club#3281). The command audit, the vault audit, a legacy
 * repo-local telemetry spool and a workflow run's log are written by the
 * production writers into a checkout's own `.swamp`. After
 * `datastore setup filesystem` moves the checkout's data to a new path, the
 * run record lives there, and the production readers still find the audit
 * entries and the run's log in `.swamp`. Deleting the moved run still
 * removes its log.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import { ensureDir, exists } from "@std/fs";
import { join } from "@std/path";
import { z } from "zod";
import { createBashCommandEntry } from "../src/domain/audit/audit_command_entry.ts";
import type { DatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { createVaultAuditEntry } from "../src/domain/vaults/vault_audit_entry.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { createWorkflowRunId } from "../src/domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { DefaultDatastorePathResolver } from "../src/infrastructure/persistence/default_datastore_path_resolver.ts";
import { JsonlAuditRepository } from "../src/infrastructure/persistence/jsonl_audit_repository.ts";
import { JsonlVaultAuditRepository } from "../src/infrastructure/persistence/jsonl_vault_audit_repository.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { RepoMarkerRepository } from "../src/infrastructure/persistence/repo_marker_repository.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createDatastoreSetupDeps,
  type DatastoreSetupEvent,
  datastoreSetupFilesystem,
} from "../src/libswamp/datastores/setup.ts";
import { workflowRun } from "../src/libswamp/workflows/run.ts";
import { readLogFile } from "../src/presentation/output/log_file_reader.ts";
import { createWorkflowRunDeps } from "../src/serve/deps.ts";

await initializeLogging({});

const WriteArgs = z.object({ text: z.string() });

/** A model type, registered once per test with a unique name. */
function registerWriter(): ModelType {
  const type = ModelType.create(`test/setup-local-${crypto.randomUUID()}`);
  modelRegistry.register({
    type,
    version: "2026.10.12.1",
    resources: {
      result: {
        description: "What the writer produced",
        schema: z.object({ text: z.string() }),
        lifetime: "infinite",
        garbageCollection: 20,
      },
    },
    methods: {
      write: {
        description: "Write a result resource",
        arguments: WriteArgs,
        execute: async (args, context) => ({
          dataHandles: [
            await context.writeResource!("result", "result", {
              text: WriteArgs.parse(args).text,
            }),
          ],
        }),
      },
    },
  });
  return type;
}

/** What a checkout in `repoDir` reads of its audit trail and `run`'s log. */
async function readsOf(
  repoDir: string,
  run: WorkflowRun,
): Promise<{ audit: number; vaultAudit: number; log: string | undefined }> {
  const from = new Date(Date.now() - 60 * 60 * 1000);
  const to = new Date(Date.now() + 60 * 60 * 1000);
  const logFile = run.logFile;
  return {
    audit: (await new JsonlAuditRepository(repoDir).findByTimeRange(from, to))
      .length,
    vaultAudit:
      (await new JsonlVaultAuditRepository(repoDir).findByTimeRange(from, to))
        .length,
    // The run's log as `workflow history logs` resolves and reads it.
    log: logFile !== undefined && await exists(logFile)
      ? (await readLogFile(logFile)).lines.join("\n")
      : undefined,
  };
}

Deno.test("datastore setup: the audit trail, telemetry spool and run logs stay readable in .swamp", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-setup-local-" });
  try {
    const repoDir = join(dir, "repo");
    const datastore = join(dir, "datastore");
    await ensureDir(repoDir);
    await new RepoMarkerRepository().write(RepoPath.create(repoDir), {
      swampVersion: "0.0.0",
      initializedAt: new Date().toISOString(),
      repoId: "repo-3281",
    });

    // The checkout's own writes, before setup.
    const type = registerWriter();
    const before = createRepositoryContext({ repoDir });
    await before.definitionRepo.save(
      type,
      Definition.create({ name: "writer" }),
    );
    const workflow = Workflow.create({
      name: "flow",
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({
          name: "s",
          task: StepTask.model("writer", "write", { text: "s" }),
        })],
      })],
    });
    await before.workflowRepo.save(workflow);
    await new JsonlAuditRepository(repoDir).append(
      createBashCommandEntry("session", "swamp model method run", repoDir),
    );
    await new JsonlVaultAuditRepository(repoDir).append(
      createVaultAuditEntry("get", "main", "local_encryption", "token", "test"),
    );
    const legacySpool = join(swampPath(repoDir), "telemetry", "legacy.json");
    await ensureDir(join(swampPath(repoDir), "telemetry"));
    await Deno.writeTextFile(legacySpool, "{}");

    const local: DatastoreConfig = {
      type: "filesystem",
      path: swampPath(repoDir),
    };
    let runId: string | undefined;
    for await (
      const event of workflowRun(
        createLibSwampContext(),
        await createWorkflowRunDeps(repoDir, before, local),
        { workflowIdOrName: "flow" },
      )
    ) {
      if (event.kind === "started" && runId === undefined) {
        runId = event.runId;
      }
    }
    assert(runId !== undefined, "the run started");
    const id = createWorkflowRunId(runId);
    const ownRun = await before.workflowRunRepo.findById(workflow.id, id);
    assert(ownRun !== null, "the run is readable before setup");
    assert(ownRun.logFile !== undefined, "the run records its log");
    await Deno.writeTextFile(ownRun.logFile, "step s wrote\n", {
      append: true,
    });
    const own = await readsOf(repoDir, ownRun);
    assertEquals(own.audit, 1);
    assertEquals(own.vaultAudit, 1);
    assert(own.log?.includes("step s wrote"), "the run wrote its log");

    // Setup deletes the catalog, which Windows refuses while it is open.
    before.catalogStore.close();

    // Setup moves the checkout's data to the new datastore.
    const events: DatastoreSetupEvent[] = [];
    for await (
      const event of datastoreSetupFilesystem(
        createLibSwampContext(),
        createDatastoreSetupDeps(repoDir, () => Promise.resolve(undefined)),
        { datastorePath: datastore, repoDir, skipMigration: false },
      )
    ) {
      events.push(event);
    }
    const completed = events.at(-1);
    assert(completed?.kind === "completed", `setup completed: ${completed}`);
    assertEquals(completed.data.errors, []);
    assert(completed.data.directoriesMigrated.includes("workflow-runs"));
    assertEquals(completed.data.directoriesMigrated.includes("audit"), false);
    assertEquals(
      completed.data.directoriesMigrated.includes("telemetry"),
      false,
    );

    // The run record moved; the audit trail, spool and log did not, and
    // the readers still find them.
    const after = createRepositoryContext({
      repoDir,
      datastoreResolver: new DefaultDatastorePathResolver(repoDir, {
        type: "filesystem",
        path: datastore,
      }),
    });
    const movedRun = await after.workflowRunRepo.findById(workflow.id, id);
    assert(movedRun !== null, "the run is readable from the new datastore");
    assertEquals(
      await exists(
        join(
          datastore,
          "workflow-runs",
          workflow.id,
          `workflow-run-${runId}.yaml`,
        ),
      ),
      true,
    );
    assertEquals(
      await exists(
        join(
          swampPath(repoDir),
          "workflow-runs",
          workflow.id,
          `workflow-run-${runId}.yaml`,
        ),
      ),
      false,
    );
    assertEquals(await readsOf(repoDir, movedRun), own);
    assertEquals(await Deno.readTextFile(legacySpool), "{}");
    if (await exists(join(datastore, "audit"))) {
      for await (const entry of Deno.readDir(join(datastore, "audit"))) {
        assert(false, `the datastore holds no audit file: ${entry.name}`);
      }
    }

    // Deleting the moved run still removes its repo-local log.
    const logFile = movedRun.logFile;
    assert(logFile !== undefined);
    await after.workflowRunRepo.deleteAllByWorkflowId(workflow.id);
    assertEquals(await exists(logFile), false);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
