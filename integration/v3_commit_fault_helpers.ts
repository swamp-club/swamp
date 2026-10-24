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
 * A v3 filesystem datastore whose commits fail on demand, for the cases of
 * swamp-club#3759: the chunk storage stops answering, as an unreachable
 * bucket does, or the commit's append fails.
 */

import "../src/domain/models/models.ts";
import { z } from "zod";
import { waitFor } from "@swamp-club/swamp-testing";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import type { DatastoreStorage } from "../src/domain/datastore/datastore_storage.ts";
import { isCustomDatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { setV3DatastoreFaultsForTesting } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { v3DatastoreFor } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import type { OutboxCommitSink } from "../src/infrastructure/datastore_v3/outbox_commit_sink.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import type { RowRepos } from "./usecase_sync_fixtures.ts";
import { withV3RowRepos } from "./usecase_v3_fixtures.ts";

/** The content each run writes: well past what a commit inlines. */
export const PAYLOAD = "x".repeat(64 * 1024);

/** What the faults below are doing now; reset by {@link withFaults}. */
export const faults = { storageDown: false, appendFails: false };

/** An S3-shaped connection refusal: a wrapper whose cause has the code. */
function refused(): Error {
  return new Error(
    "S3 headObject failed key=_blobs — connect ECONNREFUSED 127.0.0.1:9",
    {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), {
        code: "ECONNREFUSED",
      }),
    },
  );
}

/** The storage calls that reach the bucket on a bucket datastore. */
const NETWORK_CALLS = new Set([
  "has",
  "put",
  "get",
  "touch",
  "list",
  "delete",
  "statChunks",
]);

/** Chunk storage whose bucket calls are refused while `faults.storageDown`. */
function unreachableWhenDown(storage: DatastoreStorage): DatastoreStorage {
  return new Proxy(storage, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (typeof property !== "string" || !NETWORK_CALLS.has(property)) {
        return value.bind(target);
      }
      return (...args: unknown[]) => {
        if (!faults.storageDown) return value.apply(target, args);
        if (property === "list") {
          return {
            [Symbol.asyncIterator]: () => ({
              next: () => Promise.reject(refused()),
            }),
          };
        }
        return Promise.reject(refused());
      };
    },
  });
}

/** A commit sink whose append fails while `faults.appendFails`. */
function failingAppend(sink: OutboxCommitSink): OutboxCommitSink {
  return new Proxy(sink, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property !== "append") return value.bind(target);
      return (...args: unknown[]) =>
        faults.appendFails
          ? Promise.reject(new Error("the commit store refused the append"))
          : value.apply(target, args);
    },
  });
}

/** Runs `fn` against fresh v3 repos opened with the faults wrapped in. */
export async function withFaults(
  fn: (repos: RowRepos) => Promise<void>,
): Promise<void> {
  faults.storageDown = false;
  faults.appendFails = false;
  setV3DatastoreFaultsForTesting({
    wrapStorage: unreachableWhenDown,
    wrapSink: failingAppend,
  });
  try {
    await withV3RowRepos({}, (repos) => fn(repos));
  } finally {
    setV3DatastoreFaultsForTesting(undefined);
    faults.storageDown = false;
    faults.appendFails = false;
  }
}

/**
 * Registers a model whose `write` method writes {@link PAYLOAD} as a file
 * output and then takes the storage down, as the reporter's proxy cut did.
 */
export function registerBigWriter(cut = true): ModelType {
  const type = ModelType.create(`test/big-writer-${crypto.randomUUID()}`);
  modelRegistry.register({
    type,
    version: "2026.10.22.1",
    files: {
      payload: {
        description: "A file larger than a commit inlines",
        contentType: "text/plain",
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      write: {
        description: "Write the payload, then lose the storage",
        kind: "update",
        arguments: z.object({}),
        execute: async (_args, context) => {
          const writer = context.createFileWriter!("payload", "payload");
          await Deno.writeTextFile(await writer.getFilePath(), PAYLOAD);
          const payload = await writer.finalize();
          if (cut) faults.storageDown = true;
          return { dataHandles: [payload] };
        },
      },
    },
  });
  return type;
}

/**
 * Registers a model whose `write` method waits until a run checkpoint has
 * committed while it runs, then writes {@link PAYLOAD} and takes the
 * storage down (swamp-club#3882):
 * the run's committed record shows the step running, as a cut mid-step
 * leaves it. The step's start is saved before the method runs, inside the
 * checkpoint interval of the run's start, so a trailing checkpoint commits
 * it within that interval.
 */
export function registerMidStepCutter(repos: RowRepos): ModelType {
  const type = ModelType.create(`test/mid-step-cutter-${crypto.randomUUID()}`);
  modelRegistry.register({
    type,
    version: "2026.10.24.1",
    files: {
      payload: {
        description: "A file larger than a commit inlines",
        contentType: "text/plain",
        lifetime: "infinite",
        garbageCollection: 10,
      },
    },
    methods: {
      write: {
        description: "Wait for a checkpoint of the running step, then cut",
        kind: "update",
        arguments: z.object({}),
        execute: async (_args, context) => {
          const config = repos.a.datastoreConfig;
          if (isCustomDatastoreConfig(config)) {
            throw new Error("these cases run on a filesystem datastore");
          }
          const store = v3DatastoreFor(repos.repoA, config).commitStore;
          const entered = store.highWaterMark().cursor;
          await waitFor(
            () => store.highWaterMark().cursor > entered,
            "a checkpoint of the running step",
            { timeoutMs: 15_000 },
          );
          const writer = context.createFileWriter!("payload", "payload");
          await Deno.writeTextFile(await writer.getFilePath(), PAYLOAD);
          const payload = await writer.finalize();
          faults.storageDown = true;
          return { dataHandles: [payload] };
        },
      },
    },
  });
  return type;
}

export async function saveInRoot(
  repos: RowRepos,
  fn: () => Promise<void>,
): Promise<void> {
  await runInRootUnitOfWork(repos.a.repoContext, { flush: undefined }, fn);
}

/** Saves a big-writer model named `name` in A. */
export async function seedModel(
  repos: RowRepos,
  type: ModelType,
  name: string,
): Promise<void> {
  await saveInRoot(repos, async () => {
    await repos.a.repoContext.definitionRepo.save(
      type,
      Definition.create({ name, globalArguments: {} }),
    );
  });
}

/** Saves a workflow whose one step runs `write` on `model`. */
export async function seedWorkflow(
  repos: RowRepos,
  model: string,
  steps: Step[] = [Step.create({
    name: "write",
    task: StepTask.modelMethod(model, "write"),
  })],
): Promise<Workflow> {
  const workflow = Workflow.create({
    name: `wf-${crypto.randomUUID().slice(0, 8)}`,
    jobs: [Job.create({ name: "main", steps })],
  });
  await saveInRoot(
    repos,
    () => repos.a.repoContext.workflowRepo.save(workflow),
  );
  return workflow;
}

/**
 * Whether a payload of `type` was committed: whether any commit in the log
 * names one of its keys. A's own checkout keeps a given-up file as dropped
 * work until a write recovers it, so the checkout cannot say.
 */
export async function payloadCommitted(
  repos: RowRepos,
  type: ModelType,
): Promise<boolean> {
  faults.storageDown = false;
  const config = repos.a.datastoreConfig;
  if (isCustomDatastoreConfig(config)) {
    throw new Error("these cases run on a filesystem datastore");
  }
  const handle = v3DatastoreFor(repos.repoA, config);
  await handle.catchUp();
  for (const change of await handle.commitStore.changesSince(0, 100_000)) {
    for (const op of change.commit.ops) {
      if (!("key" in op)) continue;
      const key = op.key.toString();
      if (key.includes(type.normalized) && key.includes("payload")) {
        return true;
      }
    }
  }
  return false;
}
