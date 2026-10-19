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
 * A workflow run whose process is SIGKILLed mid-run on a v3 datastore
 * (swamp-club#3587). The run commits a checkpoint after every save, so the
 * next command's interrupted-writer recovery keeps the run at its last
 * checkpoint, with the data of the steps that finished, instead of deleting
 * it; `workflow recover` then settles it as interrupted, and a second
 * checkout sees the same run and data.
 *
 * SIGKILL cannot be delivered in-process, so each case spawns a child deno
 * program (not the swamp CLI) that opens the repository as the CLI does and
 * runs the workflow through serve's `executeWorkflowWithLocks`, as
 * `datastore_sync_sigint_test.ts` does for SIGINT.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertExists } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { fromFileUrl } from "@std/path";
import { walk } from "@std/fs";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { VERSION } from "../src/cli/commands/version.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { createWorkflowId } from "../src/domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import {
  reapOrphanedWorkflowRuns,
  settleDeadOwnerRun,
} from "../src/domain/workflows/orphaned_run_reaper.ts";
import { isProcessGone } from "../src/infrastructure/runtime/process.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { initializeV3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { closeV3Datastores } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import {
  DEFAULT_STALE_TTL_MS,
  localOwnerLiveness,
  RunTrackerStore,
} from "../src/infrastructure/persistence/run_tracker_store.ts";
import { flushDatastoreSync } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";

await initializeLogging({});

const REPO_ROOT = fromFileUrl(new URL("..", import.meta.url));

/** The module URL of `path`, relative to the repository root. */
function src(path: string): string {
  return toFileUrl(join(REPO_ROOT, ...path.split("/"))).href;
}

/** What the child prints with READY: the ids the parent asserts on. */
interface ChildIds {
  workflowId: string;
  /** The parent workflow's id, in the nested variant. */
  outerWorkflowId?: string;
  writerId: string;
  typeName: string;
  /** Whether a second checkout saw s2 running before READY (v3 only). */
  committed?: boolean;
}

/** The data name step s1 writes. */
const S1_DATA = "s1-out";

/**
 * A child that opens `repoDir` as `workflow run` opens it, saves a writer
 * model, a blocker model and the workflow `flow` (s1 writes `s1-out`, then
 * s2 blocks forever), and runs it through `executeWorkflowWithLocks` with
 * the real run tracker. It prints `READY <ids>` once s2 is running locally
 * and, with `probeDir`, once a fresh checkout of the datastore at that dir
 * sees the committed run with s2 running: the step_started checkpoint can
 * land after s2's body starts. With `nested`, `flow` is instead a single
 * step `call` that runs that workflow, named `inner`, as a child workflow.
 */
function workflowChild(
  repoDir: string,
  probe?: { dir: string; datastorePath: string },
  nested = false,
): string {
  return `
import ${JSON.stringify(src("src/domain/models/models.ts"))};
import { z } from "zod";
import { join } from "@std/path";
import { walk } from "@std/fs";
import { parse as parseYaml } from "@std/yaml";
import { waitFor } from "@swamp-club/swamp-testing";
import { initializeLogging } from ${
    JSON.stringify(src("src/infrastructure/logging/logger.ts"))
  };
import { modelRegistry } from ${
    JSON.stringify(src("src/domain/models/model.ts"))
  };
import { ModelType } from ${
    JSON.stringify(src("src/domain/models/model_type.ts"))
  };
import { Definition } from ${
    JSON.stringify(src("src/domain/definitions/definition.ts"))
  };
import { Workflow } from ${
    JSON.stringify(src("src/domain/workflows/workflow.ts"))
  };
import { Job } from ${JSON.stringify(src("src/domain/workflows/job.ts"))};
import { Step } from ${JSON.stringify(src("src/domain/workflows/step.ts"))};
import { StepTask } from ${
    JSON.stringify(src("src/domain/workflows/step_task.ts"))
  };
import { TriggerCondition } from ${
    JSON.stringify(src("src/domain/workflows/trigger_condition.ts"))
  };
import { requireInitializedRepoUnlocked } from ${
    JSON.stringify(src("src/cli/repo_context.ts"))
  };
import { runInRootUnitOfWork } from ${
    JSON.stringify(src("src/infrastructure/persistence/repo_unit_of_work.ts"))
  };
import { swampPath } from ${
    JSON.stringify(src("src/infrastructure/persistence/paths.ts"))
  };
import { RunTrackerStore } from ${
    JSON.stringify(src("src/infrastructure/persistence/run_tracker_store.ts"))
  };
import { openV3Datastore } from ${
    JSON.stringify(src("src/infrastructure/datastore_v3/v3_datastore.ts"))
  };
import { executeWorkflowWithLocks } from ${
    JSON.stringify(src("src/serve/deps.ts"))
  };

const REPO_DIR = ${JSON.stringify(repoDir)};
const PROBE = ${JSON.stringify(probe ?? null)};
const NESTED = ${JSON.stringify(nested)};

await initializeLogging({});
const type = ModelType.create("test/killed-run-" + crypto.randomUUID());
modelRegistry.register({
  type,
  version: "2026.10.19.1",
  resources: {
    out: {
      description: "What s1 writes",
      schema: z.object({ value: z.string() }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    write: {
      description: "Write one resource",
      kind: "update",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const handle = await context.writeResource("out", ${
    JSON.stringify(S1_DATA)
  }, {
          value: "hello-from-s1",
        });
        return { dataHandles: [handle] };
      },
    },
    block: {
      description: "Never return",
      kind: "update",
      arguments: z.object({}),
      execute: () => new Promise(() => {}),
    },
  },
});

const { repoContext, datastoreConfig } = await requireInitializedRepoUnlocked({
  repoDir: REPO_DIR,
  outputMode: "json",
});
const writer = Definition.create({ name: "writer", globalArguments: {} });
const blocker = Definition.create({ name: "blocker", globalArguments: {} });
const workflow = Workflow.create({
  name: NESTED ? "inner" : "flow",
  jobs: [Job.create({
    name: "main",
    steps: [
      Step.create({ name: "s1", task: StepTask.modelMethod("writer", "write") }),
      Step.create({
        name: "s2",
        task: StepTask.modelMethod("blocker", "block"),
        dependsOn: [{ step: "s1", condition: TriggerCondition.succeeded() }],
      }),
    ],
  })],
});
await runInRootUnitOfWork(repoContext, { flush: undefined }, async () => {
  await repoContext.definitionRepo.save(type, writer);
  await repoContext.definitionRepo.save(type, blocker);
  await repoContext.workflowRepo.save(workflow);
});
const outer = NESTED
  ? Workflow.create({
    name: "flow",
    jobs: [Job.create({
      name: "main",
      steps: [Step.create({ name: "call", task: StepTask.workflow("inner") })],
    })],
  })
  : undefined;
if (outer !== undefined) {
  await runInRootUnitOfWork(repoContext, { flush: undefined }, () =>
    repoContext.workflowRepo.save(outer));
}

const tracker = RunTrackerStore.fromSwampDir(swampPath(REPO_DIR));
const running = executeWorkflowWithLocks(
  REPO_DIR,
  repoContext,
  datastoreConfig,
  { workflowIdOrName: "flow" },
  new AbortController().signal,
  () => {},
  undefined,
  tracker,
  { syncGate: undefined },
);

function s2Running(run) {
  return run?.status === "running" &&
    run.jobs?.[0]?.steps?.find((s) => s.stepName === "s2")?.status ===
      "running";
}

await waitFor(async () => {
  const runs = await repoContext.workflowRunRepo.findAllByWorkflowId(
    workflow.id,
  );
  return runs.length === 1 && s2Running(runs[0].toData());
}, "s2 running locally", { timeoutMs: 30_000 });

let committed;
if (PROBE !== null) {
  // A fresh checkout of the datastore applies only committed state.
  committed = false;
  try {
    await waitFor(async () => {
      const probe = openV3Datastore({
        repoDir: PROBE.dir,
        datastorePath: PROBE.datastorePath,
      });
      try {
        await probe.catchUp();
      } finally {
        await probe.close();
      }
      const dir = join(swampPath(PROBE.dir), "workflow-runs", workflow.id);
      try {
        for await (const entry of walk(dir, { exts: [".yaml"] })) {
          if (!entry.name.startsWith("workflow-run-")) continue;
          if (s2Running(parseYaml(await Deno.readTextFile(entry.path)))) {
            return true;
          }
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      return false;
    }, "the committed run with s2 running", { timeoutMs: 15_000 });
    committed = true;
  } catch {
    // Without checkpoints the run is never committed mid-run: report it
    // and let the parent's assertions say what is lost.
  }
}

console.log("READY " + JSON.stringify({
  workflowId: workflow.id,
  outerWorkflowId: outer?.id,
  writerId: writer.id,
  typeName: type.normalized,
  committed,
}));

// s2 never returns: the parent's SIGKILL ends this process.
await running;
`;
}

/**
 * A child that runs the writer model's `write` method inside a root that
 * commits only on success, as `model method run` runs it, and prints READY
 * once the resource is written; the method then blocks, so the root never
 * commits before the parent's SIGKILL.
 */
function methodRunChild(repoDir: string): string {
  return `
import ${JSON.stringify(src("src/domain/models/models.ts"))};
import { z } from "zod";
import { initializeLogging } from ${
    JSON.stringify(src("src/infrastructure/logging/logger.ts"))
  };
import { modelRegistry } from ${
    JSON.stringify(src("src/domain/models/model.ts"))
  };
import { ModelType } from ${
    JSON.stringify(src("src/domain/models/model_type.ts"))
  };
import { Definition } from ${
    JSON.stringify(src("src/domain/definitions/definition.ts"))
  };
import {
  libSwampContextForRepo,
  requireInitializedRepoUnlocked,
} from ${JSON.stringify(src("src/cli/repo_context.ts"))};
import { runInRootUnitOfWork } from ${
    JSON.stringify(src("src/infrastructure/persistence/repo_unit_of_work.ts"))
  };
import { modelMethodRun } from ${
    JSON.stringify(src("src/libswamp/models/run.ts"))
  };
import { createWorkerModelRunDeps } from ${
    JSON.stringify(src("src/libswamp/worker/run_deps.ts"))
  };

const REPO_DIR = ${JSON.stringify(repoDir)};

await initializeLogging({});
const type = ModelType.create("test/killed-method-" + crypto.randomUUID());
const writer = Definition.create({ name: "writer", globalArguments: {} });
modelRegistry.register({
  type,
  version: "2026.10.19.1",
  resources: {
    out: {
      description: "What the method writes",
      schema: z.object({ value: z.string() }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    write: {
      description: "Write one resource, then never return",
      kind: "update",
      arguments: z.object({}),
      execute: async (_args, context) => {
        await context.writeResource("out", ${JSON.stringify(S1_DATA)}, {
          value: "uncommitted",
        });
        console.log("READY " + JSON.stringify({
          writerId: writer.id,
          typeName: type.normalized,
        }));
        return await new Promise(() => {});
      },
    },
  },
});

const { repoContext } = await requireInitializedRepoUnlocked({
  repoDir: REPO_DIR,
  outputMode: "json",
});
await runInRootUnitOfWork(repoContext, { flush: undefined }, () =>
  repoContext.definitionRepo.save(type, writer));
const deps = await createWorkerModelRunDeps(REPO_DIR, repoContext);
await runInRootUnitOfWork(repoContext, {
  flush: undefined,
  pushWhen: "completed",
}, async () => {
  for await (
    const _event of modelMethodRun(
      libSwampContextForRepo(repoContext, {
        signal: new AbortController().signal,
      }),
      deps,
      {
        modelIdOrName: "writer",
        methodName: "write",
        inputs: {},
        lastEvaluated: false,
        skipAllReports: true,
      },
    )
  ) {
    // Drain the events; the method never returns.
  }
});
`;
}

/** Reads until a full `READY` line or the stream ends; returns what was read. */
async function readUntilReady(
  reader: ReadableStreamDefaultReader<string>,
): Promise<string> {
  let text = "";
  while (!/^READY [^\n]*\n/m.test(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += value;
  }
  return text;
}

/**
 * Spawns `program`, waits for its `READY <json>` line, SIGKILLs it and waits
 * for it to exit. Resolves with the JSON the child printed.
 */
async function runChildAndKill<T>(program: string): Promise<T> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "-"],
    // deno.json at the repo root resolves the program's bare imports.
    cwd: REPO_ROOT,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    // Hang guard, not a timing assertion: a child that never reaches READY
    // is killed, so the test fails on its output instead of stalling CI.
    signal: AbortSignal.timeout(120_000),
  }).spawn();
  const stderr = new Response(child.stderr).text();
  const writer = child.stdin.getWriter();
  try {
    await writer.write(new TextEncoder().encode(program));
  } finally {
    await writer.close();
  }
  const stdout = child.stdout.pipeThrough(new TextDecoderStream())
    .getReader();
  const text = await readUntilReady(stdout);
  const line = text.split("\n").find((l) => l.startsWith("READY "));
  if (line === undefined) {
    await stdout.cancel();
    const status = await child.status;
    throw new Error(
      `child exited ${status.code} before READY:\n${text}\n${await stderr}`,
    );
  }
  child.kill("SIGKILL");
  await stdout.cancel();
  const status = await child.status;
  await stderr;
  assertEquals(status.signal, "SIGKILL", "the child was killed");
  return JSON.parse(line.slice("READY ".length)) as T;
}

/** The run's status and each step's, by step name. */
function summary(run: WorkflowRun): {
  status: string;
  steps: Record<string, string>;
} {
  return {
    status: run.status,
    steps: Object.fromEntries(
      run.jobs.flatMap((job) =>
        job.steps.map((step) => [step.stepName, step.status])
      ),
    ),
  };
}

async function initRepo(
  repoDir: string,
  datastoreLines: string[],
): Promise<void> {
  await Deno.mkdir(repoDir, { recursive: true });
  const homeDir = join(repoDir, "test-home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
  if (datastoreLines.length === 0) return;
  const markerPath = join(repoDir, ".swamp.yaml");
  const marker = await Deno.readTextFile(markerPath);
  await Deno.writeTextFile(
    markerPath,
    marker.trimEnd() + "\n" + datastoreLines.join("\n") + "\n",
  );
}

interface KilledRepos {
  dir: string;
  repoA: string;
  repoB: string;
  probe: string;
  datastorePath: string;
}

/**
 * A fresh v3 filesystem datastore with checkouts A (the killed writer's), B
 * and a probe dir for the child, none opened in this process. Everything is
 * closed and removed in a `finally`.
 */
async function withKilledRepos(
  format: 2 | 3,
  fn: (repos: KilledRepos) => Promise<void>,
): Promise<void> {
  // The CLI resolves a --repo-dir through a symlink (swamp-club#3552), and
  // the macOS temp dir is one, so the repos are spelled that way too.
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-killed-run-" }),
  );
  try {
    const datastorePath = join(dir, "datastore");
    const lines = format === 3
      ? [
        "datastore:",
        "  type: filesystem",
        `  path: ${JSON.stringify(datastorePath)}`,
        "  format: 3",
      ]
      : [];
    if (format === 3) await initializeV3Datastore(datastorePath, "test");
    const repos = {
      dir,
      repoA: join(dir, "a"),
      repoB: join(dir, "b"),
      probe: join(dir, "probe"),
      datastorePath,
    };
    await initRepo(repos.repoA, lines);
    if (format === 3) await initRepo(repos.repoB, lines);
    await fn(repos);
  } finally {
    await closeV3Datastores();
    await flushDatastoreSync();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** Opens `repoDir` as a writing command does: recovery runs first. */
async function openWriting(repoDir: string) {
  return await requireInitializedRepoUnlocked({ repoDir, outputMode: "json" });
}

/** The runs of `workflowId` and s1's data content, read through `repoDir`. */
async function observe(
  repoDir: string,
  ids: ChildIds,
): Promise<{ runs: ReturnType<typeof summary>[]; s1: string | null }> {
  const { repoContext } = await openWriting(repoDir);
  const runs = await repoContext.workflowRunRepo.findAllByWorkflowId(
    createWorkflowId(ids.workflowId),
  );
  const content = await repoContext.unifiedDataRepo.getContent(
    ids.typeName,
    ids.writerId,
    S1_DATA,
  );
  return {
    runs: runs.map(summary),
    s1: content === null ? null : new TextDecoder().decode(content),
  };
}

const KILLED = {
  status: "running",
  steps: { s1: "succeeded", s2: "running" },
};

const IGNORE_WINDOWS = Deno.build.os === "windows";

Deno.test({
  name:
    "v3 killed workflow run: recovery keeps the run at its last checkpoint with s1's data, recover settles it, and a second checkout agrees (POSIX)",
  // Windows has no SIGKILL to send to a child process.
  ignore: IGNORE_WINDOWS,
  fn: async () => {
    await withKilledRepos(3, async (repos) => {
      const ids = await runChildAndKill<ChildIds>(
        workflowChild(repos.repoA, {
          dir: repos.probe,
          datastorePath: repos.datastorePath,
        }),
      );
      assertEquals(
        ids.committed,
        true,
        "a second checkout saw the run with s2 running before the kill",
      );

      // 1, 2: the next writing command recovers the checkout and keeps the
      // checkpointed run and s1's data.
      const recovered = await observe(repos.repoA, ids);
      assertEquals(recovered.runs, [KILLED]);
      assertExists(recovered.s1, "s1's data survives recovery");
      assert(recovered.s1.includes("hello-from-s1"), recovered.s1);

      // 3: workflow recover's dead-owner settling marks it interrupted.
      const { repoContext } = await openWriting(repos.repoA);
      const workflowId = createWorkflowId(ids.workflowId);
      const [run] = await repoContext.workflowRunRepo.findAllByWorkflowId(
        workflowId,
      );
      const tracker = RunTrackerStore.fromSwampDir(swampPath(repos.repoA));
      try {
        const settled = await runInRootUnitOfWork(
          repoContext,
          { flush: undefined },
          () =>
            settleDeadOwnerRun(
              repoContext.workflowRunRepo,
              tracker,
              workflowId,
              run.id,
              localOwnerLiveness(),
              repoContext.outputRepo,
            ),
        );
        assertEquals(settled, true, "the dead owner's run is settled");
      } finally {
        tracker.close();
      }
      await closeV3Datastores();
      const interrupted = {
        status: "interrupted",
        steps: { s1: "succeeded", s2: "unknown" },
      };
      const reopened = await observe(repos.repoA, ids);
      assertEquals(reopened.runs, [interrupted], "the settled run committed");
      await closeV3Datastores();

      // 4: a second checkout over the same datastore sees the same.
      const b = await observe(repos.repoB, ids);
      assertEquals(b.runs, [interrupted]);
      assertEquals(b.s1, recovered.s1);
    });
  },
});

Deno.test({
  name:
    "v3 killed workflow run: a v2 filesystem datastore keeps the killed run running with s1's data (POSIX)",
  ignore: IGNORE_WINDOWS,
  fn: async () => {
    await withKilledRepos(2, async (repos) => {
      const ids = await runChildAndKill<ChildIds>(workflowChild(repos.repoA));
      const observed = await observe(repos.repoA, ids);
      assertEquals(observed.runs, [KILLED]);
      assertExists(observed.s1);
      assert(observed.s1.includes("hello-from-s1"), observed.s1);
    });
  },
});

/** The data files under `root` whose path names `dataName`. */
async function dataFiles(root: string, dataName: string): Promise<string[]> {
  const paths: string[] = [];
  try {
    for await (
      const entry of walk(join(root, "data"), { includeDirs: false })
    ) {
      if (entry.path.includes(dataName)) paths.push(entry.path);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return paths;
}

Deno.test({
  name:
    "v3 killed workflow run: a killed method run's uncommitted data is still removed by recovery (POSIX)",
  ignore: IGNORE_WINDOWS,
  fn: async () => {
    await withKilledRepos(3, async (repos) => {
      const ids = await runChildAndKill<
        Pick<ChildIds, "writerId" | "typeName">
      >(methodRunChild(repos.repoA));
      assert(
        (await dataFiles(swampPath(repos.repoA), S1_DATA)).length > 0,
        "the killed method left its uncommitted data",
      );
      const { repoContext } = await openWriting(repos.repoA);
      assertEquals(
        await dataFiles(swampPath(repos.repoA), S1_DATA),
        [],
        "recovery removed the uncommitted data",
      );
      assertEquals(
        await repoContext.unifiedDataRepo.getContent(
          ids.typeName,
          ids.writerId,
          S1_DATA,
        ),
        null,
      );
    });
  },
});

Deno.test({
  name:
    "v3 killed workflow run: a killed nested run keeps both the parent and the child run at their last checkpoint (POSIX)",
  ignore: IGNORE_WINDOWS,
  fn: async () => {
    await withKilledRepos(3, async (repos) => {
      const ids = await runChildAndKill<ChildIds>(
        workflowChild(repos.repoA, {
          dir: repos.probe,
          datastorePath: repos.datastorePath,
        }, true),
      );
      assertExists(ids.outerWorkflowId);
      const inner = await observe(repos.repoA, ids);
      assertEquals(inner.runs, [KILLED]);
      assertExists(inner.s1);
      assert(inner.s1.includes("hello-from-s1"), inner.s1);
      const outer = await observe(repos.repoA, {
        ...ids,
        workflowId: ids.outerWorkflowId,
      });
      assertEquals(outer.runs, [{
        status: "running",
        steps: { call: "running" },
      }]);
    });
  },
});

Deno.test({
  name:
    "v3 killed workflow run: a restarted serve's boot reaper settles the killed serve's run as interrupted, and the settled record is committed (POSIX)",
  ignore: IGNORE_WINDOWS,
  fn: async () => {
    await withKilledRepos(3, async (repos) => {
      // The run carries no serve instance id: a restarted serve has a new
      // one, and its boot reaps dead-pid rows only when they are local to
      // it, so a row tagged with the killed serve's id is skipped here.
      const ids = await runChildAndKill<ChildIds>(
        workflowChild(repos.repoA, {
          dir: repos.probe,
          datastorePath: repos.datastorePath,
        }),
      );

      // The restarted serve opens the repo and reaps as its boot does, with
      // an instance id of its own.
      const { repoContext } = await openWriting(repos.repoA);
      const instanceId = crypto.randomUUID();
      const tracker = RunTrackerStore.fromSwampDir(swampPath(repos.repoA));
      try {
        tracker.reapStaleRuns(DEFAULT_STALE_TTL_MS, instanceId);
        tracker.reapDeadProcessRuns(instanceId);
        const runningRuns = await repoContext.workflowRunRepo
          .findGlobalByStatus("running");
        const result = await runInRootUnitOfWork(
          repoContext,
          { flush: undefined },
          () =>
            reapOrphanedWorkflowRuns(
              runningRuns,
              async (workflowId, run) => {
                await repoContext.workflowRunRepo.save(workflowId, run);
                tracker.markSettled(run.id, "server_crash");
              },
              (runId) => {
                const tracked = tracker.findById(runId);
                return tracked ? { status: tracked.status } : null;
              },
              isProcessGone,
              instanceId,
            ),
        );
        assertEquals(result, { reaped: 1, skipped: 0 });
      } finally {
        tracker.close();
      }
      await closeV3Datastores();

      const reopened = await openWriting(repos.repoA);
      const runs = await reopened.repoContext.workflowRunRepo
        .findAllByWorkflowId(createWorkflowId(ids.workflowId));
      assertEquals(runs.map(summary), [{
        status: "interrupted",
        steps: { s1: "succeeded", s2: "unknown" },
      }], "the settled run committed");
      assertEquals(runs[0].tags["interrupt_reason"], "server_crash");
    });
  },
});
