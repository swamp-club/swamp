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
import { stringify as stringifyYaml } from "@std/yaml";
import {
  RETENTION_CHECK_ITEM_LIMIT,
  retentionCheckFailed,
  type RetentionKindCheck,
  type RetentionScanSources,
  scanRetention,
} from "./retention_check.ts";
import { RetentionPolicy } from "../../domain/retention/retention_policy.ts";
import type {
  RetentionWatermark,
  RetentionWatermarkRepository,
} from "../../domain/retention/retention_watermark.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import { Data } from "../../domain/data/data.ts";
import { ModelType } from "../../domain/models/model_type.ts";

const DAY_MS = 86_400_000;
const NOW = new Date();
const OLD = new Date(NOW.getTime() - 40 * DAY_MS);
const RECENT = new Date(NOW.getTime() - DAY_MS);

const POLICY_30D = RetentionPolicy.fromConfig({ retention: "30d" });

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-retention-check-" });
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

const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";

async function writeRun(
  repoDir: string,
  runId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const dir = join(repoDir, ".swamp", "workflow-runs", WORKFLOW_ID);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, `workflow-run-${runId}.yaml`),
    stringifyYaml({ id: runId, workflowId: WORKFLOW_ID, ...fields }),
  );
}

async function writeSnapshot(
  repoDir: string,
  runId: string,
  modifiedAt: Date,
): Promise<void> {
  const dir = join(repoDir, ".swamp", "workflows-evaluated", "runs", runId);
  await Deno.mkdir(dir, { recursive: true });
  const path = join(dir, "evaluated-workflow.yaml");
  await Deno.writeTextFile(path, "name: wf\n");
  await Deno.utime(path, modifiedAt, modifiedAt);
}

async function writeOutput(
  repoDir: string,
  name: string,
  startedAt: Date,
  status: string,
): Promise<void> {
  const dir = join(repoDir, ".swamp", "outputs", "test", "thing", "create");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, `${name}.yaml`),
    stringifyYaml({ id: name, status, startedAt: startedAt.toISOString() }),
  );
}

async function writeAudit(repoDir: string, day: Date): Promise<void> {
  const dir = join(repoDir, ".swamp", "audit");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, `commands-${day.toISOString().split("T")[0]}.jsonl`),
    "{}\n",
  );
}

async function saveData(
  repo: FileSystemUnifiedDataRepository,
  repoDir: string,
  type: ModelType,
  name: string,
  createdAt: Date,
): Promise<void> {
  const data = Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 100,
    tags: { type: "resource" },
    ownerDefinition: { ownerType: "model-method", ownerRef: "ref" },
  });
  const { version } = await repo.save(
    type,
    "model-1",
    data,
    new TextEncoder().encode("{}"),
  );
  // Age the version on disk, as a version written long ago reads.
  const metadataPath = join(
    repoDir,
    ".swamp",
    "data",
    ...type.normalized.split("/"),
    "model-1",
    name,
    String(version),
    "metadata.yaml",
  );
  const text = await Deno.readTextFile(metadataPath);
  await Deno.writeTextFile(
    metadataPath,
    text.replace(/createdAt: .*/, `createdAt: '${createdAt.toISOString()}'`),
  );
}

function kind(
  kinds: readonly RetentionKindCheck[],
  name: string,
): RetentionKindCheck {
  return kinds.find((k) => k.kind === name)!;
}

function sources(
  repoDir: string,
  extra: Partial<RetentionScanSources> = {},
): RetentionScanSources {
  return {
    repoDir,
    dataRepo: new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(":memory:"),
    ),
    ...extra,
  };
}

Deno.test("scanRetention: passes with a not-configured summary when no retention is set", async () => {
  await withTempDir(async (dir) => {
    await writeRun(dir, "22222222-2222-4222-8222-222222222222", {
      status: "succeeded",
      startedAt: OLD.toISOString(),
      completedAt: OLD.toISOString(),
    });
    const summary = await scanRetention(
      sources(dir),
      RetentionPolicy.fromConfig(undefined),
      NOW,
    );
    assertEquals(summary.configured, false);
    assertEquals(summary.kinds.every((k) => !k.scanned), true);
    assertEquals(retentionCheckFailed(summary), false);
  });
});

Deno.test("scanRetention: passes when nothing stored is older than its retention", async () => {
  await withTempDir(async (dir) => {
    const runId = "22222222-2222-4222-8222-222222222222";
    await writeRun(dir, runId, {
      status: "succeeded",
      startedAt: RECENT.toISOString(),
      completedAt: RECENT.toISOString(),
    });
    await writeSnapshot(dir, runId, RECENT);
    await writeOutput(dir, "fresh", RECENT, "succeeded");
    await writeAudit(dir, NOW);
    const repo = sources(dir);
    await saveData(
      repo.dataRepo as FileSystemUnifiedDataRepository,
      dir,
      ModelType.create("test/thing"),
      "fresh",
      RECENT,
    );

    const summary = await scanRetention(repo, POLICY_30D, NOW);
    assertEquals(summary.configured, true);
    for (
      const name of [
        "workflowRuns",
        "evaluatedSnapshots",
        "outputs",
        "data",
        "audit",
      ]
    ) {
      assertEquals(kind(summary.kinds, name).scanned, true, name);
      assertEquals(kind(summary.kinds, name).overdue, 0, name);
    }
    assertEquals(kind(summary.kinds, "bookkeeping").scanned, false);
    assertEquals(retentionCheckFailed(summary), false);
  });
});

Deno.test("scanRetention: lists every kind's items older than the cutoff, and keeps unfinished runs, their snapshots and exempt data", async () => {
  await withTempDir(async (dir) => {
    const oldDone = "33333333-3333-4333-8333-333333333333";
    const oldRunning = "44444444-4444-4444-8444-444444444444";
    const childOfRunning = "55555555-5555-4555-8555-555555555555";
    await writeRun(dir, oldDone, {
      status: "succeeded",
      startedAt: OLD.toISOString(),
      completedAt: OLD.toISOString(),
    });
    await writeRun(dir, oldRunning, {
      status: "running",
      startedAt: OLD.toISOString(),
    });
    await writeRun(dir, childOfRunning, {
      status: "failed",
      startedAt: OLD.toISOString(),
      completedAt: OLD.toISOString(),
      parentRun: {
        workflowId: WORKFLOW_ID,
        workflowName: "parent",
        runId: oldRunning,
        jobName: "j",
        stepName: "s",
        nestingDepth: 1,
        ancestorWorkflowNames: ["parent"],
      },
    });
    await writeSnapshot(dir, oldDone, OLD);
    await writeSnapshot(dir, oldRunning, OLD);
    await writeOutput(dir, "stale", OLD, "succeeded");
    await writeOutput(dir, "in-flight", OLD, "running");
    await writeOutput(dir, "fresh", RECENT, "succeeded");
    await writeAudit(dir, OLD);
    await writeAudit(dir, NOW);
    const repo = sources(dir);
    const dataRepo = repo.dataRepo as FileSystemUnifiedDataRepository;
    await saveData(dataRepo, dir, ModelType.create("test/thing"), "old", OLD);
    await saveData(
      dataRepo,
      dir,
      ModelType.create("test/thing"),
      "new",
      RECENT,
    );
    await saveData(dataRepo, dir, ModelType.create("swamp/grant"), "g", OLD);

    const summary = await scanRetention(
      repo,
      // Snapshots with their own key can be overdue ahead of their runs.
      RetentionPolicy.fromConfig({
        retention: "30d",
        evaluatedSnapshots: "30d",
      }),
      NOW,
    );

    const runs = kind(summary.kinds, "workflowRuns");
    assertEquals(runs.overdue, 1);
    assertEquals(runs.items.map((i) => i.id), [`${WORKFLOW_ID}/${oldDone}`]);
    // The running run, and the finished child its running parent reads.
    assertEquals(runs.kept, 2);

    const snapshots = kind(summary.kinds, "evaluatedSnapshots");
    assertEquals(snapshots.items.map((i) => i.id), [oldDone]);
    assertEquals(snapshots.kept, 1);

    const outputs = kind(summary.kinds, "outputs");
    assertEquals(outputs.overdue, 1);
    assertEquals(outputs.items[0].id.endsWith("stale.yaml"), true);
    assertEquals(outputs.kept, 1);

    const data = kind(summary.kinds, "data");
    assertEquals(data.items.map((i) => i.id), ["test/thing/model-1/old@1"]);
    assertEquals(data.kept, 1);

    const audit = kind(summary.kinds, "audit");
    assertEquals(audit.items.map((i) => i.id), [
      `commands-${OLD.toISOString().split("T")[0]}.jsonl`,
    ]);

    assertEquals(retentionCheckFailed(summary), true);
  });
});

Deno.test("scanRetention: caps the listed items and counts the rest", async () => {
  await withTempDir(async (dir) => {
    const total = RETENTION_CHECK_ITEM_LIMIT + 5;
    for (let i = 0; i < total; i++) {
      await writeOutput(dir, `stale-${i}`, OLD, "succeeded");
    }
    const summary = await scanRetention(
      sources(dir),
      RetentionPolicy.fromConfig({ outputs: "30d" }),
      NOW,
    );
    const outputs = kind(summary.kinds, "outputs");
    assertEquals(outputs.overdue, total);
    assertEquals(outputs.items.length, RETENTION_CHECK_ITEM_LIMIT);
    assertEquals(kind(summary.kinds, "workflowRuns").scanned, false);
  });
});

Deno.test("scanRetention: shows each kind's watermark", async () => {
  await withTempDir(async (dir) => {
    const watermark: RetentionWatermark = {
      kind: "workflowRuns",
      cutoff: OLD.toISOString(),
      retention: "30d",
      lastPassAt: RECENT.toISOString(),
      complete: false,
      deleted: 3,
      bytesReclaimed: 10,
    };
    const watermarks: RetentionWatermarkRepository = {
      get: () => Promise.resolve(watermark),
      getAll: () => Promise.resolve([watermark]),
      put: () => Promise.resolve(),
      claimHourlyPass: () => Promise.resolve(true),
    };
    const summary = await scanRetention(
      sources(dir, { watermarks }),
      POLICY_30D,
      NOW,
    );
    assertEquals(kind(summary.kinds, "workflowRuns").watermark, {
      lastPassAt: watermark.lastPassAt,
      cutoff: watermark.cutoff,
      complete: false,
    });
    assertEquals(kind(summary.kinds, "data").watermark, null);
  });
});

Deno.test("scanRetention: fails v3 history only past the 7-day bound plus a day's grace", async () => {
  await withTempDir(async (dir) => {
    const at = (daysAgo: number) =>
      new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString();
    const scan = (oldest: string | null, policy = POLICY_30D) =>
      scanRetention(
        sources(dir, {
          v3History: (now) =>
            Promise.resolve({
              oldestCommitAt: oldest,
              compactionBound: new Date(now.getTime() - 7 * DAY_MS),
            }),
        }),
        policy,
        NOW,
      );

    const within = await scan(at(7.5));
    assertEquals(within.v3History?.overdue, false);
    assertEquals(retentionCheckFailed(within), false);
    assertEquals(
      within.v3History?.compactionBound,
      new Date(NOW.getTime() - 7 * DAY_MS).toISOString(),
    );

    const past = await scan(at(9));
    assertEquals(past.v3History?.overdue, true);
    assertEquals(retentionCheckFailed(past), true);

    assertEquals((await scan(null)).v3History?.overdue, false);
    // Without retention, history is never a failure.
    const unset = await scan(at(30), RetentionPolicy.fromConfig(undefined));
    assertEquals(unset.v3History?.overdue, false);
  });
});

Deno.test("scanRetention: no v3 history section without a commit log", async () => {
  await withTempDir(async (dir) => {
    const summary = await scanRetention(sources(dir), POLICY_30D, NOW);
    assertEquals(summary.v3History, undefined);
  });
});

Deno.test("scanRetention: with automatic retention, an item just past its cutoff waits for the next pass", async () => {
  await withTempDir(async (dir) => {
    const runId = "33333333-3333-4333-8333-333333333333";
    // One hour past a 30-day cutoff: inside one pass interval.
    const justPast = new Date(NOW.getTime() - 30 * DAY_MS - 60 * 60 * 1000);
    await writeRun(dir, runId, {
      status: "succeeded",
      startedAt: justPast.toISOString(),
      completedAt: justPast.toISOString(),
    });

    const automatic = await scanRetention(
      sources(dir),
      RetentionPolicy.fromConfig({ retention: "30d", automatic: true }),
      NOW,
    );
    assertEquals(kind(automatic.kinds, "workflowRuns").overdue, 0);

    const manual = await scanRetention(sources(dir), POLICY_30D, NOW);
    assertEquals(kind(manual.kinds, "workflowRuns").overdue, 1);
  });
});
