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
 * Fixtures for retention tests (swamp-club#3473): runs, snapshots, outputs,
 * data versions and audit days written through the real repositories, then
 * aged on disk (record timestamps and file mtimes) so a retention pass run
 * at the real clock sees them as old.
 */

import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { ModelOutput } from "../../domain/models/model_output.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { createDefinitionId } from "../../domain/definitions/definition.ts";
import { Data } from "../../domain/data/data.ts";
import type { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import type { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import type { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import type { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";

export const DAY_MS = 86_400_000;

export type FixtureRunStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "running"
  | "suspended";

export const TERMINAL_FIXTURE_STATUSES: ReadonlySet<FixtureRunStatus> = new Set(
  ["succeeded", "failed", "cancelled"],
);

export function fixtureWorkflow(name = "retention-fixture"): Workflow {
  return Workflow.create({
    id: crypto.randomUUID(),
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

async function ageFile(path: string, ageMs: number): Promise<void> {
  const when = new Date(Date.now() - ageMs);
  await Deno.utime(path, when, when);
}

export interface AgedRun {
  runId: string;
  yamlPath: string;
  logPath: string;
  snapshotPath?: string;
}

/**
 * Saves a run with `status` that started (and, when finished, completed)
 * `ageMs` ago, with a run log next to its record. With `snapshotAgeMs`, an
 * evaluated snapshot is saved for it and aged that much.
 */
export async function saveAgedRun(
  runRepo: YamlWorkflowRunRepository,
  workflow: Workflow,
  status: FixtureRunStatus,
  ageMs: number,
  snapshot?: {
    repo: YamlEvaluatedWorkflowRepository;
    baseDir: string;
    ageMs: number;
  },
): Promise<AgedRun> {
  const base = WorkflowRun.create(workflow);
  base.start();
  const at = new Date(Date.now() - ageMs).toISOString();
  const run = WorkflowRun.fromData({
    ...base.toData(),
    status,
    startedAt: at,
    completedAt: TERMINAL_FIXTURE_STATUSES.has(status) ? at : undefined,
  });
  await runRepo.save(workflow.id, run);
  const yamlPath = runRepo.getPath(workflow.id, run.id);
  const logPath = yamlPath.replace(/\.yaml$/, ".log");
  await Deno.writeTextFile(logPath, "run log line\n");
  await ageFile(yamlPath, ageMs);
  await ageFile(logPath, ageMs);
  let snapshotPath: string | undefined;
  if (snapshot) {
    await snapshot.repo.saveForRun(run.id, workflow);
    snapshotPath = join(
      snapshot.baseDir,
      "runs",
      run.id,
      "evaluated-workflow.yaml",
    );
    await ageFile(snapshotPath, snapshot.ageMs);
  }
  return { runId: run.id, yamlPath, logPath, snapshotPath };
}

export interface AgedOutput {
  yamlPath: string;
  logPath: string;
}

/**
 * Saves a method output of `type`'s `run` method that started `ageMs` ago,
 * with its run log; `succeeded` unless `running` is set.
 */
export async function saveAgedOutput(
  outputRepo: YamlOutputRepository,
  type: ModelType,
  ageMs: number,
  options: { running?: boolean } = {},
): Promise<AgedOutput> {
  const startedAt = new Date(Date.now() - ageMs);
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "run",
    status: "running",
    startedAt,
    provenance: {
      definitionHash: "abc123",
      modelVersion: "2026.02.09.1",
      triggeredBy: "manual",
    },
  });
  const yamlPath = outputRepo.getPath(type, "run", output);
  const stamp = new Date(startedAt.getTime() - 4).toISOString()
    .replace(/[:.]/g, "-");
  const logPath = join(
    dirname(yamlPath),
    `${output.definitionId}-${stamp}.log`,
  );
  await ensureDir(dirname(logPath));
  await Deno.writeTextFile(logPath, "output log line\n");
  output.setLogFile(logPath);
  if (!options.running) output.markSucceeded();
  await outputRepo.save(type, "run", output);
  await ageFile(yamlPath, ageMs);
  await ageFile(logPath, ageMs);
  return { yamlPath, logPath };
}

/**
 * Saves one version of `name` per entry of `agesMs` (oldest first, so the
 * latest version is the last entry), then rewrites each version's recorded
 * creation time to its age. The catalog rows the saves wrote still carry
 * the save time: remove the catalog (`removeCatalogDb`) before a pass so it
 * is rebuilt from the rewritten metadata.
 */
export async function saveAgedDataVersions(
  dataRepo: FileSystemUnifiedDataRepository,
  type: ModelType,
  modelId: string,
  name: string,
  agesMs: readonly number[],
): Promise<number[]> {
  const versions: number[] = [];
  for (const ageMs of agesMs) {
    const data = Data.create({
      name,
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 100,
      tags: { type: "resource", specName: name, modelName: modelId },
      ownerDefinition: { ownerType: "model-method", ownerRef: "ref" },
    });
    const { version } = await dataRepo.save(
      type,
      modelId,
      data,
      new TextEncoder().encode(`{"v":${versions.length + 1}}`),
    );
    const metadataPath = dataRepo.getMetadataPath(
      type,
      modelId,
      name,
      version,
    );
    const metadata = parseYaml(await Deno.readTextFile(metadataPath)) as Record<
      string,
      unknown
    >;
    metadata.createdAt = new Date(Date.now() - ageMs).toISOString();
    await Deno.writeTextFile(metadataPath, stringifyYaml(metadata));
    versions.push(version);
  }
  return versions;
}

/** Writes the agent command log file of the UTC day `ageDays` ago. */
export async function writeAuditDay(
  auditDir: string,
  ageDays: number,
): Promise<string> {
  const day = new Date(Date.now() - ageDays * DAY_MS).toISOString()
    .split("T")[0];
  const path = join(auditDir, `commands-${day}.jsonl`);
  await ensureDir(auditDir);
  await Deno.writeTextFile(
    path,
    JSON.stringify({ timestamp: `${day}T12:00:00.000Z`, command: "x" }) +
      "\n",
  );
  return path;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
