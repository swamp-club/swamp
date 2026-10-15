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
 * Automatic retention end to end on a real repository (swamp-club#3473):
 * the end-of-command pass a CLI runs after a writing command, through the
 * same lock path as any writing command, against runs, snapshots, outputs,
 * data, and the agent command log on the default filesystem datastore; its
 * hourly gate and `automatic` switch; and batching and the time budget of
 * the shared pass.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import type { RetentionConfig } from "../src/domain/retention/retention_policy.ts";
import { RetentionPolicy } from "../src/domain/retention/retention_policy.ts";
import { RETENTION_KINDS } from "../src/domain/retention/retention_policy.ts";
import type { DatastorePathResolver } from "../src/domain/datastore/datastore_path_resolver.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { DefaultDatastorePathResolver } from "../src/infrastructure/persistence/default_datastore_path_resolver.ts";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";
import { ControlPlaneRetentionWatermarkRepository } from "../src/infrastructure/persistence/control_plane_retention_watermark_repository.ts";
import { flushDatastoreSync } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import { RepoMarkerRepository } from "../src/infrastructure/persistence/repo_marker_repository.ts";
import {
  catalogDbPath,
  removeCatalogDb,
} from "../src/infrastructure/persistence/repository_factory.ts";
import { SWAMP_SUBDIRS } from "../src/infrastructure/persistence/paths.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlEvaluatedWorkflowRepository } from "../src/infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { YamlOutputRepository } from "../src/infrastructure/persistence/yaml_output_repository.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { resolveDatastoreForRepo } from "../src/cli/repo_context.ts";
import { noteRetentionCandidate } from "../src/cli/retention_candidate.ts";
import { runRetentionAtCommandEnd } from "../src/cli/retention_teardown.ts";
import { VERSION } from "../src/cli/commands/version.ts";
import { runRepoRetention } from "../src/libswamp/retention/run.ts";
import {
  DAY_MS,
  fixtureWorkflow,
  pathExists,
  saveAgedDataVersions,
  saveAgedOutput,
  saveAgedRun,
  writeAuditDay,
} from "../src/libswamp/retention/retention_fixture_test_helpers.ts";

await initializeLogging({});

const OUTPUT_TYPE = ModelType.create("command/shell");
const DATA_TYPE = ModelType.create("test/retention-pass");
const EXEMPT_TYPE = ModelType.create("swamp/grant");

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-retention-pass-" });
  try {
    await fn(dir);
  } finally {
    await flushDatastoreSync().catch(() => {});
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

interface Repo {
  repoDir: string;
  datastorePath: string;
  resolver: DatastorePathResolver;
  runs: YamlWorkflowRunRepository;
  snapshots: YamlEvaluatedWorkflowRepository;
  snapshotsDir: string;
  outputs: YamlOutputRepository;
}

async function initRepo(
  dir: string,
  garbageCollection?: RetentionConfig,
): Promise<Repo> {
  const repoDir = join(dir, "repo");
  await Deno.mkdir(repoDir, { recursive: true });
  const homeDir = join(dir, "home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
  await setGarbageCollection(repoDir, garbageCollection);
  const { datastoreConfig } = await resolveDatastoreForRepo(repoDir);
  assertEquals(datastoreConfig.type, "filesystem");
  const resolver = new DefaultDatastorePathResolver(repoDir, datastoreConfig);
  const snapshotsDir = resolver.resolvePath(SWAMP_SUBDIRS.workflowsEvaluated);
  return {
    repoDir,
    datastorePath: (datastoreConfig as { path: string }).path,
    resolver,
    runs: new YamlWorkflowRunRepository(
      repoDir,
      undefined,
      resolver.resolvePath(SWAMP_SUBDIRS.workflowRuns),
    ),
    snapshots: new YamlEvaluatedWorkflowRepository(repoDir, snapshotsDir),
    snapshotsDir,
    outputs: new YamlOutputRepository(
      repoDir,
      resolver.resolvePath(SWAMP_SUBDIRS.outputs),
    ),
  };
}

async function setGarbageCollection(
  repoDir: string,
  garbageCollection: RetentionConfig | undefined,
): Promise<void> {
  const markers = new RepoMarkerRepository();
  const repoPath = RepoPath.create(repoDir);
  const marker = await markers.read(repoPath);
  assert(marker);
  const { garbageCollection: _old, ...rest } = marker;
  await markers.write(
    repoPath,
    garbageCollection ? { ...rest, garbageCollection } : rest,
  );
}

/** Writes data through the real repository, then drops the catalog. */
async function withDataRepo(
  repo: Repo,
  fn: (data: FileSystemUnifiedDataRepository) => Promise<void>,
): Promise<void> {
  const catalog = new CatalogStore(catalogDbPath(repo.repoDir, repo.resolver));
  try {
    await fn(
      new FileSystemUnifiedDataRepository(
        repo.repoDir,
        repo.resolver.resolvePath(SWAMP_SUBDIRS.data),
        catalog,
      ),
    );
  } finally {
    catalog.close();
  }
  // The saves recorded their own time; the pass rebuilds from the aged
  // metadata.
  await removeCatalogDb(repo.repoDir, repo.resolver);
}

function catalogVersions(
  repo: Repo,
  modelId: string,
  name: string,
): number[] {
  const db = new DatabaseSync(catalogDbPath(repo.repoDir, repo.resolver));
  try {
    return db.prepare(
      "SELECT version FROM catalog WHERE model_id = ? AND data_name = ? ORDER BY version",
    ).all(modelId, name).map((row) => Number(row.version));
  } finally {
    db.close();
  }
}

function dataVersionDir(
  repo: Repo,
  type: ModelType,
  modelId: string,
  name: string,
  version?: number,
): string {
  const nameDir = join(
    repo.resolver.resolvePath(SWAMP_SUBDIRS.data),
    type.normalized,
    modelId,
    name,
  );
  return version === undefined ? nameDir : join(nameDir, String(version));
}

const GATE_FILE = "retention-last-attempt.json";

Deno.test("runRetentionAtCommandEnd: reaps every kind past its retention and keeps everything else", async () => {
  await withTempDir(async (dir) => {
    const repo = await initRepo(dir, {
      retention: "7d",
      automatic: true,
      evaluatedSnapshots: "2d",
      audit: "3d",
    });
    const workflow = fixtureWorkflow();
    const snap = (ageMs: number) => ({
      repo: repo.snapshots,
      baseDir: repo.snapshotsDir,
      ageMs,
    });

    // Runs.
    const oldDone = await saveAgedRun(
      repo.runs,
      workflow,
      "succeeded",
      10 * DAY_MS,
      snap(10 * DAY_MS),
    );
    const oldRunning = await saveAgedRun(
      repo.runs,
      workflow,
      "running",
      10 * DAY_MS,
      snap(10 * DAY_MS),
    );
    const oldSuspended = await saveAgedRun(
      repo.runs,
      workflow,
      "suspended",
      10 * DAY_MS,
      snap(10 * DAY_MS),
    );
    const young = await saveAgedRun(
      repo.runs,
      workflow,
      "succeeded",
      1 * DAY_MS,
      snap(1 * DAY_MS),
    );
    // A finished run inside the run retention whose snapshot is past the
    // snapshot retention.
    const keptRunOldSnapshot = await saveAgedRun(
      repo.runs,
      workflow,
      "failed",
      3 * DAY_MS,
      snap(3 * DAY_MS),
    );

    // Outputs.
    const oldOutput = await saveAgedOutput(
      repo.outputs,
      OUTPUT_TYPE,
      10 * DAY_MS,
    );
    const youngOutput = await saveAgedOutput(
      repo.outputs,
      OUTPUT_TYPE,
      1 * DAY_MS,
    );

    // Data.
    let mixedVersions: number[] = [];
    await withDataRepo(repo, async (data) => {
      await saveAgedDataVersions(data, DATA_TYPE, "m-old", "only-old", [
        12 * DAY_MS,
      ]);
      mixedVersions = await saveAgedDataVersions(
        data,
        DATA_TYPE,
        "m-mixed",
        "mixed",
        [12 * DAY_MS, 9 * DAY_MS, 1 * DAY_MS],
      );
      await saveAgedDataVersions(data, EXEMPT_TYPE, "g-1", "grant", [
        30 * DAY_MS,
      ]);
    });

    // Agent command log.
    const auditDir = join(repo.repoDir, ".swamp", SWAMP_SUBDIRS.audit);
    const oldAudit = await writeAuditDay(auditDir, 5);
    const recentAudit = await writeAuditDay(auditDir, 1);

    noteRetentionCandidate(repo.repoDir);
    const result = await runRetentionAtCommandEnd();

    assert(result, "the pass ran");
    assertEquals(result.complete, true);
    assertEquals(
      result.kinds.map((k) => k.kind),
      ["workflowRuns", "evaluatedSnapshots", "outputs", "data", "audit"],
    );

    // Runs: the old finished one goes with its snapshot and log.
    assertEquals(await pathExists(oldDone.yamlPath), false);
    assertEquals(await pathExists(oldDone.logPath), false);
    assertEquals(await pathExists(oldDone.snapshotPath!), false);
    for (const kept of [oldRunning, oldSuspended, young]) {
      assertEquals(await pathExists(kept.yamlPath), true, kept.yamlPath);
      assertEquals(await pathExists(kept.snapshotPath!), true);
    }
    // The snapshot past its own retention goes; its run stays.
    assertEquals(await pathExists(keptRunOldSnapshot.yamlPath), true);
    assertEquals(await pathExists(keptRunOldSnapshot.snapshotPath!), false);
    assertEquals(
      await repo.runs.listRunIds(),
      new Set([
        oldRunning.runId,
        oldSuspended.runId,
        young.runId,
        keptRunOldSnapshot.runId,
      ]),
    );

    // Outputs.
    assertEquals(await pathExists(oldOutput.yamlPath), false);
    assertEquals(await pathExists(oldOutput.logPath), false);
    assertEquals(await pathExists(youngOutput.yamlPath), true);
    assertEquals(await pathExists(youngOutput.logPath), true);

    // Data: a name whose latest is old goes whole, catalog rows included.
    assertEquals(
      await pathExists(dataVersionDir(repo, DATA_TYPE, "m-old", "only-old")),
      false,
    );
    assertEquals(catalogVersions(repo, "m-old", "only-old"), []);
    // A name with a young latest keeps only it.
    const latest = mixedVersions[2];
    assertEquals(catalogVersions(repo, "m-mixed", "mixed"), [latest]);
    for (const version of mixedVersions) {
      assertEquals(
        await pathExists(
          dataVersionDir(repo, DATA_TYPE, "m-mixed", "mixed", version),
        ),
        version === latest,
        `version ${version}`,
      );
    }
    // Exempt access state is never touched.
    assertEquals(
      await pathExists(dataVersionDir(repo, EXEMPT_TYPE, "g-1", "grant", 1)),
      true,
    );
    assertEquals(catalogVersions(repo, "g-1", "grant"), [1]);

    // Audit, by whole day.
    assertEquals(await pathExists(oldAudit), false);
    assertEquals(await pathExists(recentAudit), true);

    // One watermark per kind the pass ran, in the datastore's control plane.
    const watermarkDir = join(
      repo.datastorePath,
      "_control",
      "retention",
      "watermarks",
    );
    const files: string[] = [];
    for await (const entry of Deno.readDir(watermarkDir)) {
      files.push(entry.name);
    }
    assertEquals(files.sort(), [
      "audit",
      "data",
      "evaluatedSnapshots",
      "outputs",
      "workflowRuns",
    ]);
    const watermarks = await new ControlPlaneRetentionWatermarkRepository(
      new FileSystemControlPlaneStore(repo.datastorePath),
    ).getAll();
    assertEquals(watermarks.length, 5);
    for (const watermark of watermarks) {
      assertEquals(watermark.complete, true, watermark.kind);
      assertEquals(
        watermark.retention,
        RetentionPolicy.fromConfig({
          retention: "7d",
          evaluatedSnapshots: "2d",
          audit: "3d",
        }).durationFor(watermark.kind),
      );
    }
    const byKind = new Map(watermarks.map((w) => [w.kind, w]));
    assertEquals(byKind.get("workflowRuns")?.deleted, 1);
    assertEquals(byKind.get("evaluatedSnapshots")?.deleted, 1);
    assertEquals(byKind.get("outputs")?.deleted, 1);
    assertEquals(byKind.get("data")?.deleted, 3);
    assertEquals(byKind.get("audit")?.deleted, 1);
    assert(RETENTION_KINDS.includes("bookkeeping"));
    assertEquals(byKind.has("bookkeeping"), false);
  });
});

Deno.test("runRetentionAtCommandEnd: runs at most once an hour per checkout, and never without automatic", async () => {
  await withTempDir(async (dir) => {
    const repo = await initRepo(dir, { retention: "7d", automatic: true });
    const workflow = fixtureWorkflow();
    const gatePath = join(repo.repoDir, ".swamp", GATE_FILE);

    const first = await saveAgedRun(
      repo.runs,
      workflow,
      "succeeded",
      10 * DAY_MS,
    );
    noteRetentionCandidate(repo.repoDir);
    assert(await runRetentionAtCommandEnd(), "the first pass ran");
    assertEquals(await pathExists(first.yamlPath), false);
    assertEquals(await pathExists(gatePath), true);

    // Within the hour: the repo-local gate stops the pass.
    const second = await saveAgedRun(
      repo.runs,
      workflow,
      "succeeded",
      10 * DAY_MS,
    );
    noteRetentionCandidate(repo.repoDir);
    assertEquals(await runRetentionAtCommandEnd(), undefined);
    assertEquals(await pathExists(second.yamlPath), true);

    // Nothing noted: nothing runs.
    assertEquals(await runRetentionAtCommandEnd(), undefined);

    // Without `automatic`, the pass never starts, gate or not.
    await Deno.remove(gatePath);
    await setGarbageCollection(repo.repoDir, { retention: "7d" });
    noteRetentionCandidate(repo.repoDir);
    assertEquals(await runRetentionAtCommandEnd(), undefined);
    assertEquals(await pathExists(second.yamlPath), true);
    assertEquals(await pathExists(gatePath), false);

    // `automatic: false` is the same.
    await setGarbageCollection(repo.repoDir, {
      retention: "7d",
      automatic: false,
    });
    noteRetentionCandidate(repo.repoDir);
    assertEquals(await runRetentionAtCommandEnd(), undefined);
    assertEquals(await pathExists(second.yamlPath), true);
    assertEquals(await pathExists(gatePath), false);
  });
});

Deno.test("runRepoRetention: small batches drain every old run; a spent budget stops before any batch and leaves watermarks incomplete", async () => {
  await withTempDir(async (dir) => {
    const repo = await initRepo(dir);
    const workflow = fixtureWorkflow();
    const oldRuns = [];
    for (let i = 0; i < 7; i++) {
      oldRuns.push(
        await saveAgedRun(repo.runs, workflow, "cancelled", 10 * DAY_MS),
      );
    }
    const keep = await saveAgedRun(repo.runs, workflow, "running", 10 * DAY_MS);
    const watermarks = new ControlPlaneRetentionWatermarkRepository(
      new FileSystemControlPlaneStore(join(dir, "control")),
    );
    const policy = RetentionPolicy.fromConfig({ workflowRuns: "7d" });
    let batches = 0;
    const deps = {
      repoDir: repo.repoDir,
      datastoreResolver: repo.resolver,
      watermarks,
      runBatch: <T>(fn: () => Promise<T>): Promise<T> => {
        batches++;
        return fn();
      },
    };

    // A spent budget: no batch starts, and the watermark says so.
    const stopped = await runRepoRetention(deps, {
      policy,
      batchSize: 2,
      budgetMs: 0,
    });
    assertEquals(stopped.complete, false);
    assertEquals(stopped.stoppedBy, "budget");
    assertEquals(batches, 0);
    assertEquals((await repo.runs.listRunIds()).size, 8);
    const incomplete = await watermarks.get("workflowRuns");
    assertEquals(incomplete?.complete, false);
    assertEquals(incomplete?.deleted, 0);

    // Stopping after two batches leaves the rest for the next pass.
    let checks = 0;
    const partial = await runRepoRetention(deps, {
      policy,
      batchSize: 2,
      isStopping: () => ++checks > 2,
    });
    assertEquals(partial.complete, false);
    assertEquals(partial.stoppedBy, "stopping");
    assertEquals(partial.kinds[0].deleted, 4);
    assertEquals((await repo.runs.listRunIds()).size, 4);
    assertEquals((await watermarks.get("workflowRuns"))?.complete, false);

    // An unbounded pass drains the rest across batches of two.
    batches = 0;
    const drained = await runRepoRetention(deps, { policy, batchSize: 2 });
    assertEquals(drained.complete, true);
    assertEquals(drained.kinds[0].deleted, 3);
    assertEquals(batches, 2);
    assertEquals(await repo.runs.listRunIds(), new Set([keep.runId]));
    for (const run of oldRuns) {
      assertEquals(await pathExists(run.yamlPath), false);
    }
    const complete = await watermarks.get("workflowRuns");
    assertEquals(complete?.complete, true);
    assertEquals(complete?.deleted, 3);
  });
});
