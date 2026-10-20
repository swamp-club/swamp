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
 * An interrupted run on a v3 filesystem datastore (swamp-club#3299): a run
 * cancelled by its signal commits as cancelled, and the files a writer that
 * ended without tearing down left uncommitted are removed by the next
 * command in its checkout, so every checkout converges.
 */

import "../src/domain/models/models.ts";
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";
import { UserError } from "../src/domain/errors.ts";
import { dirname, join, SEPARATOR } from "@std/path";
import { walk } from "@std/fs";
import { parse as parseYaml } from "@std/yaml";
import { z } from "zod";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { Data } from "../src/domain/data/data.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { isCustomDatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { holdsV3WriterLock } from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import {
  plantV3WriterLease,
  type V3WriterLeaseHolder,
} from "../src/infrastructure/datastore_v3/v3_writer_lock_test_helpers.ts";
import {
  closeV3Datastores,
  holdV3Writer,
  keepV3WriterMarkers,
  v3DatastoreFor,
  v3RepositoryFactoryConfig,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { openV3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import {
  readWriterMarker,
  readWriterMarkerFile,
  writerMarkerPath,
} from "../src/infrastructure/datastore_v3/interrupted_writer_recovery.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { RUNS_INDEX_FILENAME } from "../src/infrastructure/persistence/workflow_run_index.ts";
import { libSwampContextForRepo } from "../src/cli/repo_context.ts";
import { modelMethodRun } from "../src/libswamp/models/run.ts";
import { createWorkerModelRunDeps } from "../src/libswamp/worker/run_deps.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import {
  createServeCtx,
  saveData,
  saveModel,
  sendRequest,
} from "./serve_request_harness.ts";
import { ActiveRunRegistry } from "../src/serve/active_run_registry.ts";
import {
  cacheDir,
  type RowRepos,
  withRowRepos,
} from "./usecase_sync_fixtures.ts";
import {
  assertCheckoutsAgree,
  datastoreRecords,
  withV3RowRepos,
} from "./usecase_v3_fixtures.ts";

await initializeLogging({});

/** A pid no process has: above every platform's pid limit. */
const GONE_PID = 99_999_999;

/**
 * Registers a model whose `write` method writes two part resources and a
 * payload file, calls `onWritten`, then waits on its signal, as swamp-uat's
 * write-then-wait fixture does. The type name is per run.
 */
function registerWriteThenWait(onWritten: () => void): ModelType {
  const type = ModelType.create(`test/write-then-wait-${crypto.randomUUID()}`);
  modelRegistry.register({
    type,
    version: "2026.10.12.1",
    resources: {
      part: {
        description: "One output written before the wait",
        schema: z.object({ part: z.string() }),
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    files: {
      payload: {
        description: "A file written before the wait",
        contentType: "text/plain",
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      write: {
        description: "Write outputs, then wait for the signal",
        kind: "update",
        arguments: z.object({}),
        execute: async (_args, context) => {
          const first = await context.writeResource!("part", "first", {
            part: "first",
          });
          const second = await context.writeResource!("part", "second", {
            part: "second",
          });
          const writer = context.createFileWriter!("payload", "payload");
          await Deno.writeTextFile(await writer.getFilePath(), "payload");
          const payload = await writer.finalize();
          onWritten();
          await new Promise<never>((_resolve, reject) => {
            const signal = context.signal;
            if (signal === undefined) return;
            if (signal.aborted) reject(signal.reason);
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
          return { dataHandles: [first, second, payload] };
        },
      },
    },
  });
  return type;
}

/** A promise `written` that settles when the returned callback runs. */
function writtenLatch(): { written: Promise<void>; onWritten: () => void } {
  let onWritten = () => {};
  const written = new Promise<void>((resolve) => {
    onWritten = resolve;
  });
  return { written, onWritten };
}

function inRoot<T>(repos: RowRepos, fn: () => Promise<T>): Promise<T> {
  return runInRootUnitOfWork(repos.a.repoContext, { flush: undefined }, fn);
}

/**
 * Runs `write` on a fresh write-then-wait model in A, inside a root as the
 * CLI runs it, and aborts the run's signal once its outputs are written, as
 * SIGTERM does. Resolves with the model's name.
 */
async function abortedMethodRun(repos: RowRepos): Promise<string> {
  const { written, onWritten } = writtenLatch();
  const type = registerWriteThenWait(onWritten);
  const name = `waiter-${crypto.randomUUID().slice(0, 8)}`;
  await inRoot(
    repos,
    () =>
      repos.a.repoContext.definitionRepo.save(
        type,
        Definition.create({ name, globalArguments: {} }),
      ),
  );
  const deps = await createWorkerModelRunDeps(repos.repoA, repos.a.repoContext);
  const abort = new AbortController();
  const aborting = written.then(() => abort.abort());
  const kinds: string[] = [];
  await inRoot(repos, async () => {
    for await (
      const event of modelMethodRun(
        libSwampContextForRepo(repos.a.repoContext, { signal: abort.signal }),
        deps,
        {
          modelIdOrName: name,
          methodName: "write",
          inputs: {},
          lastEvaluated: false,
          skipAllReports: true,
        },
      )
    ) {
      kinds.push(event.kind);
    }
  });
  await aborting;
  assertEquals(kinds.includes("error"), false, kinds.join(", "));
  return name;
}

/** The statuses of every method run record under the cache root `root`. */
async function outputStatuses(root: string): Promise<string[]> {
  const statuses: string[] = [];
  for (const path of await filesUnder(join(root, "outputs"), ".yaml")) {
    const record = parseYaml(await Deno.readTextFile(path)) as {
      status: string;
    };
    statuses.push(record.status);
  }
  return statuses.sort();
}

/** The data names held under the cache root `root`. */
async function dataNames(root: string): Promise<string[]> {
  const names = new Set<string>();
  for (const path of await filesUnder(join(root, "data"), ".yaml")) {
    const segments = path.split(SEPARATOR);
    if (segments.at(-1) === "metadata.yaml") names.add(segments.at(-3)!);
  }
  return [...names].sort();
}

async function filesUnder(dir: string, ext: string): Promise<string[]> {
  const paths: string[] = [];
  try {
    for await (
      const entry of walk(dir, { includeDirs: false, exts: [ext] })
    ) {
      paths.push(entry.path);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return paths;
}

function filesystemConfig(repos: RowRepos) {
  const config = repos.a.datastoreConfig;
  if (isCustomDatastoreConfig(config) || config.type !== "filesystem") {
    throw new Error("a v3 row runs on a filesystem datastore");
  }
  return config;
}

Deno.test("v3 interrupted run: a method run aborted after writing its outputs commits as cancelled, and the second checkout holds the same outputs", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    await abortedMethodRun(repos);
    assertEquals(await outputStatuses(swampPath(repos.repoA)), ["cancelled"]);
    assertEquals(await dataNames(swampPath(repos.repoA)), [
      "first",
      "payload",
      "second",
    ]);
    assert(await assertCheckoutsAgree(repos, datastorePath, "aborted run") > 0);
    assertEquals(await outputStatuses(swampPath(repos.repoB)), ["cancelled"]);
    assertEquals(await dataNames(swampPath(repos.repoB)), [
      "first",
      "payload",
      "second",
    ]);
  });
});

Deno.test("v3 interrupted run: the aborted method run ends in the state it ends in on v2", async () => {
  let v2: { statuses: string[]; names: string[] } | undefined;
  await withRowRepos({}, async (repos) => {
    await abortedMethodRun(repos);
    v2 = {
      statuses: await outputStatuses(cacheDir(repos.repoA)),
      names: await dataNames(cacheDir(repos.repoA)),
    };
  });
  await withV3RowRepos({}, async (repos) => {
    await abortedMethodRun(repos);
    assertEquals({
      statuses: await outputStatuses(swampPath(repos.repoA)),
      names: await dataNames(swampPath(repos.repoA)),
    }, v2);
  });
});

Deno.test("v3 interrupted run: a workflow run aborted after a step wrote its outputs commits as cancelled, and the checkouts agree", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const { written, onWritten } = writtenLatch();
    const type = registerWriteThenWait(onWritten);
    const name = `waiter-${crypto.randomUUID().slice(0, 8)}`;
    const workflow = Workflow.create({
      name: `wf-${crypto.randomUUID().slice(0, 8)}`,
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({
          name: "write",
          task: StepTask.modelMethod(name, "write"),
        })],
      })],
    });
    await inRoot(repos, async () => {
      await repos.a.repoContext.definitionRepo.save(
        type,
        Definition.create({ name, globalArguments: {} }),
      );
      await repos.a.repoContext.workflowRepo.save(workflow);
    });
    const abort = new AbortController();
    const aborting = written.then(() => abort.abort());
    const kinds: string[] = [];
    await executeWorkflowWithLocks(
      repos.repoA,
      repos.a.repoContext,
      repos.a.datastoreConfig,
      { workflowIdOrName: workflow.name },
      abort.signal,
      (event) => kinds.push(event.kind),
      undefined,
      undefined,
      { syncGate: undefined },
    ).catch(() => {});
    await aborting;
    assert(kinds.includes("cancelled"), kinds.join(", "));
    assert(
      await assertCheckoutsAgree(repos, datastorePath, "aborted workflow") > 0,
    );
    const runs = await repos.a.repoContext.workflowRunRepo
      .findSummariesByStatus(workflow.id, "cancelled");
    assertEquals(runs.length, 1);
  });
});

/**
 * Leaves A as a writer killed mid-run leaves it: a committed record, a
 * record whose root never committed (its files and catalog rows stay), a
 * committed file overwritten in place, a marker and a writer lock naming a
 * pid that is gone, and checkout-local files that must survive. Resolves
 * with what the recovery must restore and keep.
 */
async function leaveInterruptedWriter(
  repos: RowRepos,
  datastorePath: string,
): Promise<{ kept: string[]; overwritten: string; committed: string }> {
  const since = Math.floor(Date.now() / 1000) * 1000 - 2_000;
  const model = await inRoot(repos, () => saveModel(repos.serveRepo, "m1"));
  await inRoot(repos, () => saveData(repos.serveRepo, model, "committed"));
  const committedFile = [...(await datastoreRecords(repos.repoA)).keys()]
    .find((key) => key.includes("/committed/") && key.endsWith("/raw"));
  assertExists(committedFile, "the committed record's content file");
  const committedPath = join(
    swampPath(repos.repoA),
    ...committedFile.split("/"),
  );
  const committed = await Deno.readTextFile(committedPath);

  // The writer's uncommitted work: a root that commits only on success,
  // whose operation was cut short, keeps its files and catalog rows.
  await runInRootUnitOfWork(repos.a.repoContext, {
    flush: undefined,
    pushWhen: "completed",
  }, async () => {
    await saveData(repos.serveRepo, model, "uncommitted");
    throw new Error("killed");
  }).catch(() => {});
  await Deno.writeTextFile(committedPath, "overwritten by the dead writer");
  const kept = [
    "outputs/test/run/dead-run.log",
    `workflow-runs/${RUNS_INDEX_FILENAME}`,
    "audit/commands.jsonl",
    "data/test/.lock",
  ];
  for (const key of kept) {
    const path = join(swampPath(repos.repoA), ...key.split("/"));
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, "local");
  }

  // The process ends without tearing down: its marker and lock stay behind.
  // Here it ends its hold, then restores what a killed writer leaves, naming
  // a pid that is gone. A killed writer never recovers its dropped work at
  // teardown (swamp-club#3553), so this one forgets it first.
  v3DatastoreFor(repos.repoA, filesystemConfig(repos)).forgetDroppedWork();
  await closeV3Datastores();
  await Deno.writeTextFile(
    writerMarkerPath(repos.repoA),
    JSON.stringify({ hostname: Deno.hostname(), pid: GONE_PID, since }),
  );
  await writeLock(datastorePath, GONE_PID, new Date());
  return { kept, overwritten: committedFile, committed };
}

/** The writer lease held by `pid` on this host, last renewed at `acquiredAt`. */
async function writeLock(
  datastorePath: string,
  pid: number,
  acquiredAt: Date,
): Promise<V3WriterLeaseHolder> {
  return await plantV3WriterLease(datastorePath, {
    pid,
    acquiredAt,
    ttlMs: 30_000,
  });
}

async function assertRecovered(
  repos: RowRepos,
  datastorePath: string,
  left: { kept: string[]; overwritten: string; committed: string },
): Promise<void> {
  const records = [...(await datastoreRecords(repos.repoA)).keys()];
  assertEquals(
    records.filter((key) => key.includes("/uncommitted/")),
    [],
    "the uncommitted record's files are removed",
  );
  assertEquals(
    await Deno.readTextFile(
      join(swampPath(repos.repoA), ...left.overwritten.split("/")),
    ),
    left.committed,
    "the overwritten committed file is restored",
  );
  for (const key of left.kept) {
    assertEquals(
      await Deno.readTextFile(join(swampPath(repos.repoA), ...key.split("/"))),
      "local",
      `${key} survives`,
    );
  }
  assertEquals(await readWriterMarker(repos.repoA), undefined);
  // The lock file is the checkout's own and no commit names it; drop it so
  // the checkouts compare record for record.
  await Deno.remove(join(swampPath(repos.repoA), "data", "test", ".lock"));
  assert(await assertCheckoutsAgree(repos, datastorePath, "recovered") > 0);
  const config = filesystemConfig(repos);
  const b = openV3Datastore({ repoDir: repos.repoB, datastorePath });
  try {
    await b.catchUp();
    assertEquals(
      v3DatastoreFor(repos.repoA, config).catalogStore.count(),
      b.catalogStore.count(),
      "the catalogs hold the same rows",
    );
  } finally {
    await b.close();
  }
}

Deno.test("v3 interrupted run: a read-only command recovers a checkout whose writer is gone", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const left = await leaveInterruptedWriter(repos, datastorePath);
    await v3RepositoryFactoryConfig(repos.repoA, filesystemConfig(repos), {
      readOnly: true,
    });
    await assertRecovered(repos, datastorePath, left);
  });
});

Deno.test("v3 interrupted run: a writing command recovers a checkout whose writer is gone, before it writes", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const left = await leaveInterruptedWriter(repos, datastorePath);
    const config = filesystemConfig(repos);
    await holdV3Writer(config, repos.repoA);
    const marker = await readWriterMarker(repos.repoA);
    assertEquals(marker?.pid, Deno.pid, "the new writer marks the checkout");
    await v3RepositoryFactoryConfig(repos.repoA, config);
    await closeV3Datastores();
    await assertRecovered(repos, datastorePath, left);
  });
});

Deno.test("v3 interrupted run: a marker naming a live process, or a lock its live holder let lapse, is never recovered", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const left = await leaveInterruptedWriter(repos, datastorePath);
    const config = filesystemConfig(repos);
    const residue = () =>
      datastoreRecords(repos.repoA).then((records) =>
        [...records.keys()].filter((key) => key.includes("/uncommitted/"))
      );
    const before = await residue();
    assert(before.length > 0);

    // The parent process is alive: its marker is never recovered.
    await Deno.writeTextFile(
      writerMarkerPath(repos.repoA),
      JSON.stringify({
        hostname: Deno.hostname(),
        pid: Deno.ppid,
        since: Date.now(),
      }),
    );
    await v3RepositoryFactoryConfig(repos.repoA, config, { readOnly: true });
    assertEquals(await residue(), before);

    // A gone marker, but the lock is held by a live process whose TTL
    // lapsed: the reader must not take the lock over and recover.
    await Deno.writeTextFile(
      writerMarkerPath(repos.repoA),
      JSON.stringify({
        hostname: Deno.hostname(),
        pid: GONE_PID,
        since: Date.now() - 60_000,
      }),
    );
    const lapsed = await writeLock(
      datastorePath,
      Deno.ppid,
      new Date(Date.now() - 600_000),
    );
    await v3RepositoryFactoryConfig(repos.repoA, config, { readOnly: true });
    assertEquals(await residue(), before);
    assertEquals((await readWriterMarker(repos.repoA))?.pid, GONE_PID);
    await lapsed.release();

    // Once the lock is free, the next read recovers.
    await v3RepositoryFactoryConfig(repos.repoA, config, { readOnly: true });
    await assertRecovered(repos, datastorePath, left);
  });
});

Deno.test("v3 interrupted run: a writer that tears down, after a clean run or an error, leaves no marker", async () => {
  await withV3RowRepos({}, async (repos) => {
    const config = filesystemConfig(repos);
    assertEquals((await readWriterMarker(repos.repoA))?.pid, Deno.pid);
    await closeV3Datastores();
    assertEquals(await readWriterMarker(repos.repoA), undefined);

    await holdV3Writer(config, repos.repoA);
    await assertRejectsLike(() =>
      runInRootUnitOfWork(repos.a.repoContext, { flush: undefined }, () => {
        throw new Error("the command failed");
      })
    );
    await closeV3Datastores();
    assertEquals(await readWriterMarker(repos.repoA), undefined);
  });
});

async function assertRejectsLike(fn: () => Promise<unknown>): Promise<void> {
  let rejected = false;
  try {
    await fn();
  } catch {
    rejected = true;
  }
  assert(rejected, "expected a rejection");
}

Deno.test({
  name:
    "v3 interrupted run: a serve model run aborted as shutdown aborts it commits as cancelled before the writer lock is released",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withV3RowRepos({}, async (repos, datastorePath) => {
      const { written, onWritten } = writtenLatch();
      const type = registerWriteThenWait(onWritten);
      const name = `waiter-${crypto.randomUUID().slice(0, 8)}`;
      await inRoot(
        repos,
        () =>
          repos.a.repoContext.definitionRepo.save(
            type,
            Definition.create({ name, globalArguments: {} }),
          ),
      );
      const registry = new ActiveRunRegistry();
      // Serve's shutdown drain aborts every run still registered.
      const aborting = written.then(() => {
        for (const run of registry.list()) {
          run.controller.abort(new Error("server shutdown"));
        }
      });
      await sendRequest(
        createServeCtx(repos.serveRepo, undefined, {
          activeRunRegistry: registry,
        }),
        {
          type: "model.method.run",
          id: crypto.randomUUID(),
          payload: { modelIdOrName: name, methodName: "write" },
        },
        null,
      );
      await aborting;
      assertEquals(registry.size, 0);
      assertEquals(await outputStatuses(swampPath(repos.repoA)), [
        "cancelled",
      ]);
      assert(
        await assertCheckoutsAgree(repos, datastorePath, "serve abort") > 0,
      );
      assertEquals(await outputStatuses(swampPath(repos.repoB)), [
        "cancelled",
      ]);
    });
  },
});

Deno.test("v3 interrupted run: a close after keepV3WriterMarkers keeps the marker, and the next close does not", async () => {
  await withV3RowRepos({}, async (repos) => {
    const config = filesystemConfig(repos);
    keepV3WriterMarkers();
    await closeV3Datastores();
    assertEquals((await readWriterMarker(repos.repoA))?.pid, Deno.pid);

    await Deno.remove(writerMarkerPath(repos.repoA));
    await holdV3Writer(config, repos.repoA);
    await closeV3Datastores();
    assertEquals(await readWriterMarker(repos.repoA), undefined);
  });
});

Deno.test({
  name:
    "v3 interrupted run: a recovery that fails refuses the write with a UserError naming the marker, releases the lock and keeps the marker",
  // A directory the sweep cannot read needs POSIX permissions.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withV3RowRepos({}, async (repos, datastorePath) => {
      await leaveInterruptedWriter(repos, datastorePath);
      const config = filesystemConfig(repos);
      const blocked = join(swampPath(repos.repoA), "data", "blocked");
      await Deno.mkdir(join(blocked, "inner"), { recursive: true });
      await Deno.chmod(blocked, 0o000);
      try {
        const error = await holdV3Writer(config, repos.repoA).then(
          () => undefined,
          (e: unknown) => e,
        );
        assert(error instanceof UserError, String(error));
        assertStringIncludes(error.message, writerMarkerPath(repos.repoA));
        assertEquals(holdsV3WriterLock(datastorePath), false);
        assertEquals((await readWriterMarker(repos.repoA))?.pid, GONE_PID);
      } finally {
        await Deno.chmod(blocked, 0o755);
      }
      // Once the cause is fixed, the next writer recovers.
      await holdV3Writer(config, repos.repoA);
      assertEquals((await readWriterMarker(repos.repoA))?.pid, Deno.pid);
    });
  },
});

Deno.test("v3 interrupted run: a writing command recovers another host's marker under its lease, and marks the checkout its own (swamp-club#3564)", async () => {
  await withV3RowRepos({}, async (repos) => {
    const config = filesystemConfig(repos);
    await closeV3Datastores();
    // Another host, or a container sharing this hostname: its writer writes
    // only under the lease, which this process now holds.
    const foreign = {
      hostname: `${Deno.hostname()}-elsewhere`,
      pid: 4242,
      process: { host: `${Deno.hostname()}-elsewhere` },
      since: 0,
    };
    await Deno.writeTextFile(
      writerMarkerPath(repos.repoA),
      JSON.stringify(foreign),
    );
    await holdV3Writer(config, repos.repoA);
    assertEquals((await readWriterMarker(repos.repoA))?.pid, Deno.pid);
    await closeV3Datastores();
    assertEquals(await readWriterMarker(repos.repoA), undefined);
  });
});

Deno.test("v3 interrupted run: a hold whose checkout record cannot be written releases the lock and leaves no marker after teardown", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const config = filesystemConfig(repos);
    await closeV3Datastores();
    // A directory where the writer's checkout record goes: its write fails.
    const sidecar = join(datastorePath, "_control", "writer.checkout.json");
    await Deno.mkdir(join(sidecar, "blocked"), { recursive: true });
    try {
      await assertRejectsLike(() => holdV3Writer(config, repos.repoA));
      assertEquals(holdsV3WriterLock(datastorePath), false);
      // Another hold in this process may rely on the marker: it stays until
      // teardown, which a failed command still runs.
      assertEquals((await readWriterMarker(repos.repoA))?.pid, Deno.pid);
      await closeV3Datastores();
      assertEquals(await readWriterMarker(repos.repoA), undefined);
    } finally {
      await Deno.remove(sidecar, { recursive: true });
    }
  });
});

Deno.test("v3 interrupted run: a restarted container's process recovers its predecessor's checkout, though both share a hostname and pid", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const left = await leaveInterruptedWriter(repos, datastorePath);
    // The killed predecessor had this process's hostname and pid.
    await Deno.writeTextFile(
      writerMarkerPath(repos.repoA),
      JSON.stringify({
        hostname: Deno.hostname(),
        pid: Deno.pid,
        instance: crypto.randomUUID(),
        since: (await readWriterMarker(repos.repoA))!.since,
      }),
    );
    const config = filesystemConfig(repos);
    await holdV3Writer(config, repos.repoA);
    await closeV3Datastores();
    await assertRecovered(repos, datastorePath, left);
  });
});

/**
 * Leaves an interrupted writer whose marker a crash left `text`
 * (swamp-club#3617), dated when that writer started.
 */
async function leaveUnreadableMarker(
  repos: RowRepos,
  datastorePath: string,
  text: string,
): Promise<{ kept: string[]; overwritten: string; committed: string }> {
  const started = new Date(Math.floor(Date.now() / 1000) * 1000);
  const left = await leaveInterruptedWriter(repos, datastorePath);
  await Deno.writeTextFile(writerMarkerPath(repos.repoA), text);
  await Deno.utime(writerMarkerPath(repos.repoA), started, started);
  return left;
}

Deno.test("v3 interrupted run: a writing command recovers a checkout whose marker a crash left empty, never writing over it first (swamp-club#3617)", async () => {
  for (const text of ["", "\0".repeat(64)]) {
    await withV3RowRepos({}, async (repos, datastorePath) => {
      const left = await leaveUnreadableMarker(repos, datastorePath, text);
      const config = filesystemConfig(repos);
      await holdV3Writer(config, repos.repoA);
      assertEquals((await readWriterMarker(repos.repoA))?.pid, Deno.pid);
      await v3RepositoryFactoryConfig(repos.repoA, config);
      await closeV3Datastores();
      await assertRecovered(repos, datastorePath, left);
    });
  }
});

Deno.test("v3 interrupted run: a read-only command recovers an unreadable marker only once no live process holds the lease (swamp-club#3617)", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const left = await leaveUnreadableMarker(repos, datastorePath, "");
    const config = filesystemConfig(repos);
    const residue = () =>
      datastoreRecords(repos.repoA).then((records) =>
        [...records.keys()].filter((key) => key.includes("/uncommitted/"))
      );
    const before = await residue();
    assert(before.length > 0);

    // A live process holds the lease: it may be the marker's writer.
    const live = await writeLock(datastorePath, Deno.ppid, new Date());
    await v3RepositoryFactoryConfig(repos.repoA, config, { readOnly: true });
    assertEquals(await residue(), before);
    assertEquals((await readWriterMarkerFile(repos.repoA)).kind, "unreadable");
    await live.release();

    // Once the lease is free, the next read recovers.
    await v3RepositoryFactoryConfig(repos.repoA, config, { readOnly: true });
    await assertRecovered(repos, datastorePath, left);
  });
});

Deno.test("v3 interrupted run: recovery stores a chunk a power cut tore again from the checkout file, so every checkout can read the record (swamp-club#3617)", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    // Content over the inline limit, stored as one chunk.
    const big = new TextEncoder().encode(
      JSON.stringify({ value: "x".repeat(20_000) }),
    );
    const model = await inRoot(repos, () => saveModel(repos.serveRepo, "m1"));
    await inRoot(repos, async () => {
      const data = Data.create({
        name: "big",
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        tags: { type: "resource", modelName: model.name },
        ownerDefinition: {
          ownerType: "model-method",
          ownerRef: `${repos.serveRepo.modelType.normalized}:${model.id}`,
        },
      });
      await repos.serveRepo.repoContext.unifiedDataRepo.save(
        repos.serveRepo.modelType,
        model.id,
        data,
        big,
      );
    });
    const key = [...(await datastoreRecords(repos.repoA)).keys()]
      .find((key) => key.includes("/big/") && key.endsWith("/raw"));
    assertExists(key, "the big record's content file");
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", big)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    const chunk = join(
      datastorePath,
      "_blobs",
      "_default",
      "sha256",
      digest.slice(0, 2),
      digest,
    );
    // The power went before the chunk reached the disk; the writer's
    // checkout file is its only good copy, and the writer is gone.
    v3DatastoreFor(repos.repoA, filesystemConfig(repos)).forgetDroppedWork();
    await closeV3Datastores();
    await Deno.truncate(chunk, 10);
    await Deno.writeTextFile(
      writerMarkerPath(repos.repoA),
      JSON.stringify({
        hostname: Deno.hostname(),
        pid: GONE_PID,
        since: Date.now() - 60_000,
      }),
    );
    await writeLock(datastorePath, GONE_PID, new Date());
    await v3RepositoryFactoryConfig(repos.repoA, filesystemConfig(repos), {
      readOnly: true,
    });
    assertEquals((await Deno.stat(chunk)).size, big.length);
    const b = openV3Datastore({ repoDir: repos.repoB, datastorePath });
    try {
      await b.catchUp();
    } finally {
      await b.close();
    }
    assertEquals(
      await Deno.readFile(join(swampPath(repos.repoB), ...key.split("/"))),
      big,
    );
  });
});
