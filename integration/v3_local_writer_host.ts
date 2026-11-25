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

import { Data } from "../src/domain/data/data.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import type { DatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { processLockHolderMarker } from "../src/domain/datastore/lock_holder_marker.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../src/domain/workflows/workflow_id.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { ActiveRun } from "../src/domain/models/active_run.ts";
import {
  RunProgress,
  withRunProgress,
} from "../src/domain/remote/run_progress.ts";
import { ModelOutput } from "../src/domain/models/model_output.ts";
import { cancelOrphanedMethodRuns } from "../src/domain/workflows/orphaned_run_reaper.ts";
import {
  acquireModelLocks,
  createModelLock,
  createWorkflowRunLock,
  type ModelLockResult,
  type RepoValidationContext,
  requireInitializedRepo,
  requireInitializedRepoUnlocked,
  resolveDatastoreForRepo,
  runUnderModelLocks,
  tryBehaviorLockOf,
} from "../src/cli/repo_context.ts";
import {
  catchUpV3HandlesAt,
  closeV3Datastores,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { endWriterInstanceForTesting } from "../src/infrastructure/datastore_v3/writer_instance.ts";
import { isCustomDatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { flushDatastoreSync } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import {
  checkpointOpenUnitOfWork,
  runInRootUnitOfWork,
} from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import type { ProcessHost } from "./process_host.ts";

/** a method of the fixture's model type, so a cancel can name its output */
const OUTPUT_METHOD = "touch";

export type RunAction = "seed" | "resume" | "suspend" | "cancel";

export type LocalWriterRequest =
  | {
    readonly kind: "open";
    readonly repoDir: string;
    readonly type: string;
    /** under the datastore's global lock, as a structural command opens */
    readonly structural?: boolean;
    /** this process's own env, as a parent hands its child */
    readonly env?: Record<string, string>;
  }
  | {
    readonly kind: "write";
    readonly id: string;
    readonly model: string;
    readonly data: string;
    /** staged, then held open until resumed, as a slow step holds its unit */
    readonly pause?: boolean;
    /** under the behavior's own lock, as a method run takes it */
    readonly lock?: boolean;
    /** saved, committed by a checkpoint, then saved again in the same unit */
    readonly checkpointed?: boolean;
    /** padding past the inline limit, so the content is stored as chunks */
    readonly pad?: string;
  }
  /** a method run's output, saved as its owner would */
  | {
    readonly kind: "output";
    readonly id: string;
    readonly model: string;
    readonly status: "running" | "succeeded";
    readonly lock?: boolean;
  }
  /** settles a dead owner's output as a cancel does */
  | {
    readonly kind: "settleOrphan";
    readonly id: string;
    readonly model: string;
    readonly ownerPid: number;
  }
  | {
    readonly kind: "outputStatus";
    readonly id: string;
    readonly model: string;
  }
  /** what the open is doing, as a run's progress reports it */
  | { readonly kind: "phase" }
  | {
    readonly kind: "read";
    readonly id: string;
    /** by id: a definition lives in its own checkout, the data in the datastore */
    readonly modelId: string;
    readonly data: string;
  }
  /** the behavior's lock, held as a run holds it while its steps run */
  | { readonly kind: "hold"; readonly model: string }
  | { readonly kind: "unhold"; readonly model: string }
  /** one transition of a run record under the run's lock */
  | {
    readonly kind: "run";
    readonly id: string;
    readonly workflowId: string;
    readonly runId: string;
    readonly action: RunAction;
    readonly pause?: boolean;
  }
  | { readonly kind: "resume"; readonly id: string }
  /** catches every handle of the checkout up, as a reader's command does */
  | { readonly kind: "catchUp" }
  /** killed: its units never finish and its token is no longer live */
  | { readonly kind: "die" }
  | { readonly kind: "close" };

export type LocalWriterMessage =
  | { readonly opened: true }
  | { readonly paused: string }
  | {
    readonly written: string;
    readonly version: number;
    /** the count this write stored: one more than the latest it read */
    readonly count: number;
    readonly modelId: string;
  }
  | { readonly read: string; readonly content: string | null }
  | { readonly saved: string }
  | {
    readonly settled: string;
    readonly closed: number;
    readonly deferred: number;
  }
  | { readonly outputOf: string; readonly status: string | null }
  | { readonly phase: string; readonly resource?: string }
  | { readonly held: string; readonly env: Record<string, string> }
  | { readonly unheld: string }
  | {
    readonly turned: string;
    /** the status the turn read under the lock */
    readonly saw: string;
    /** every turn the record names, this one last */
    readonly turns: readonly string[];
  }
  | { readonly closed: true }
  | { readonly caughtUp: true }
  | { readonly failed: string; readonly id?: string };

/** one swamp process writing a checkout of a local filesystem v3 datastore */
export const localWriterHost: ProcessHost<
  LocalWriterRequest,
  LocalWriterMessage
> = (post) => {
  let context: RepoValidationContext;
  let datastoreConfig: DatastoreConfig;
  let type: ModelType;
  let env: Record<string, string> | undefined;
  const resumes = new Map<string, () => void>();
  const definitions = new Map<string, Promise<Definition>>();
  const held = new Map<string, ModelLockResult>();
  const progress = new RunProgress({ runId: crypto.randomUUID() });

  function within<T>(fn: () => Promise<T>): Promise<T> {
    return env === undefined ? fn() : withMockedEnv(env, fn);
  }

  async function paused(id: string): Promise<void> {
    const resumed = new Promise<void>((resolve) => resumes.set(id, resolve));
    post({ paused: id });
    await resumed;
  }

  // one lookup per name, shared, so concurrent writes never create it twice
  function definitionOf(name: string): Promise<Definition> {
    let known = definitions.get(name);
    if (known === undefined) {
      known = findOrCreate(name);
      definitions.set(name, known);
    }
    return known;
  }

  async function findOrCreate(name: string): Promise<Definition> {
    const found = await context.repoContext.definitionRepo.findByName(
      type,
      name,
    );
    if (found !== null) return found;
    const created = Definition.create({ name, globalArguments: {} });
    await runInRootUnitOfWork(
      context.repoContext,
      { flush: undefined },
      () => context.repoContext.definitionRepo.save(type, created),
    );
    return created;
  }

  async function open(
    request: Extract<LocalWriterRequest, { kind: "open" }>,
  ): Promise<void> {
    type = ModelType.create(request.type);
    const options = { repoDir: request.repoDir, outputMode: "json" as const };
    if (request.structural === true) {
      context = await withRunProgress(
        progress,
        () => requireInitializedRepo(options),
      );
      datastoreConfig =
        (await resolveDatastoreForRepo(request.repoDir)).datastoreConfig;
      return;
    }
    const opened = await requireInitializedRepoUnlocked(options);
    context = opened;
    datastoreConfig = opened.datastoreConfig;
  }

  async function write(
    request: Extract<LocalWriterRequest, { kind: "write" }>,
  ): Promise<{ version: number; count: number; modelId: string }> {
    let version = 0;
    let count = 0;
    let modelId = "";
    const body = async () => {
      await runInRootUnitOfWork(
        context.repoContext,
        { flush: undefined },
        async () => {
          const model = await definitionOf(request.model);
          modelId = model.id;
          const saveOnce = async () => {
            const latest = await context.repoContext.unifiedDataRepo.getContent(
              type,
              model.id,
              request.data,
            );
            count = latest === null
              ? 1
              : (JSON.parse(new TextDecoder().decode(latest)).count as number) +
                1;
            const data = Data.create({
              name: request.data,
              contentType: "application/json",
              lifetime: "infinite",
              garbageCollection: 1000,
              tags: { type: "resource", modelName: model.name },
              ownerDefinition: {
                ownerType: "model-method",
                ownerRef: `${type.normalized}:${model.id}`,
              },
            });
            const saved = await context.repoContext.unifiedDataRepo.save(
              type,
              model.id,
              data,
              new TextEncoder().encode(
                JSON.stringify({
                  by: request.id,
                  count,
                  ...(request.pad === undefined ? {} : { pad: request.pad }),
                }),
              ),
            );
            version = saved.version;
          };
          await saveOnce();
          if (request.checkpointed === true) {
            await checkpointOpenUnitOfWork(context.repoContext);
            await saveOnce();
          }
          if (request.pause === true) await paused(request.id);
        },
      );
    };
    if (request.lock !== true) {
      await body();
      return { version, count, modelId };
    }
    const model = await definitionOf(request.model);
    const lock = await createModelLock(
      datastoreConfig,
      type.normalized,
      model.id,
    );
    await lock.acquire();
    try {
      await body();
    } finally {
      await lock.release();
    }
    return { version, count, modelId };
  }

  async function saveOutput(
    request: Extract<LocalWriterRequest, { kind: "output" }>,
  ): Promise<void> {
    const model = await definitionOf(request.model);
    const output = ModelOutput.create({
      id: request.id,
      definitionId: model.id,
      methodName: OUTPUT_METHOD,
      status: request.status,
      provenance: {
        definitionHash: "hash",
        modelVersion: "2026.01.01.1",
        triggeredBy: "manual",
      },
    });
    const save = () =>
      runInRootUnitOfWork(
        context.repoContext,
        { flush: undefined },
        () => context.repoContext.outputRepo.save(type, OUTPUT_METHOD, output),
      );
    if (request.lock !== true) return await save();
    const lock = await createModelLock(
      datastoreConfig,
      type.normalized,
      model.id,
    );
    await lock.acquire();
    try {
      await save();
    } finally {
      await lock.release();
    }
  }

  async function settleOrphan(
    request: Extract<LocalWriterRequest, { kind: "settleOrphan" }>,
  ): Promise<{ closed: number; deferred: number }> {
    const model = await definitionOf(request.model);
    const now = new Date().toISOString();
    const row = ActiveRun.fromData({
      id: request.id,
      runKind: "model_method",
      modelType: type.normalized,
      definitionId: model.id,
      methodName: OUTPUT_METHOD,
      workflowName: null,
      pid: request.ownerPid,
      hostname: "host",
      startedAt: now,
      heartbeatAt: now,
      status: "running",
    });
    const result = await runInRootUnitOfWork(
      context.repoContext,
      { flush: undefined },
      () =>
        cancelOrphanedMethodRuns(
          context.repoContext.outputRepo,
          [row],
          "cancelled by a test",
          tryBehaviorLockOf(datastoreConfig),
        ),
    );
    if (result.errors.length > 0) throw result.errors[0];
    return { closed: result.closed.length, deferred: result.deferred.length };
  }

  async function outputStatus(
    request: Extract<LocalWriterRequest, { kind: "outputStatus" }>,
  ): Promise<string | null> {
    const outputs = await context.repoContext.outputRepo.findByIds(
      type,
      OUTPUT_METHOD,
      new Set([request.id]),
    );
    return outputs.get(request.id)?.status ?? null;
  }

  async function read(
    request: Extract<LocalWriterRequest, { kind: "read" }>,
  ): Promise<string | null> {
    const content = await context.repoContext.unifiedDataRepo.getContent(
      type,
      request.modelId,
      request.data,
    );
    return content === null ? null : new TextDecoder().decode(content);
  }

  async function hold(name: string): Promise<Record<string, string>> {
    const model = await definitionOf(name);
    const locks = await acquireModelLocks(datastoreConfig, [
      { modelType: type.normalized, modelId: model.id },
    ], context.repoDir);
    held.set(name, locks);
    return await runUnderModelLocks(
      locks,
      () => Promise.resolve(processLockHolderMarker.childLockEnv()),
    );
  }

  async function turn(
    request: Extract<LocalWriterRequest, { kind: "run" }>,
  ): Promise<{ saw: string; turns: string[] }> {
    const workflowId = createWorkflowId(request.workflowId);
    const lock = await createWorkflowRunLock(datastoreConfig, request.runId);
    return await lock.withLock(async () => {
      let saw = "none";
      let turns: string[] = [];
      await runInRootUnitOfWork(
        context.repoContext,
        { flush: undefined },
        async () => {
          const repo = context.repoContext.workflowRunRepo;
          const run = request.action === "seed"
            ? WorkflowRun.fromData({
              id: request.runId,
              workflowId: request.workflowId,
              workflowName: "turns",
              status: "suspended",
              startedAt: new Date().toISOString(),
              jobs: [],
              tags: {},
            })
            : await repo.findById(
              workflowId,
              createWorkflowRunId(request.runId),
            );
          if (run === null) throw new Error(`run ${request.runId} not found`);
          if (request.action !== "seed") saw = run.status;
          turns = [...(run.inputs.turns as string[] | undefined ?? [])];
          switch (request.action) {
            case "resume":
              run.resumeFromSuspended({ pid: Deno.pid });
              break;
            case "suspend":
              run.suspend();
              break;
            case "cancel":
              run.endAsCancelled("cancelled by a turn");
              break;
          }
          turns.push(request.id);
          run.captureInputs({ turns });
          await repo.save(workflowId, run);
          if (request.pause === true) await paused(request.id);
        },
      );
      return { saw, turns };
    });
  }

  async function close(): Promise<void> {
    for (const locks of held.values()) await locks.flush();
    held.clear();
    await closeV3Datastores();
    await flushDatastoreSync();
  }

  return (request) => {
    switch (request.kind) {
      case "open":
        env = request.env;
        within(() => open(request)).then(
          () => post({ opened: true }),
          (error) => post({ failed: String(error) }),
        );
        return;
      case "write":
        within(() => write(request)).then(
          ({ version, count, modelId }) =>
            post({ written: request.id, version, count, modelId }),
          (error) => post({ failed: String(error), id: request.id }),
        );
        return;
      case "output":
        within(() => saveOutput(request)).then(
          () => post({ saved: request.id }),
          (error) => post({ failed: String(error), id: request.id }),
        );
        return;
      case "settleOrphan":
        within(() => settleOrphan(request)).then(
          ({ closed, deferred }) =>
            post({ settled: request.id, closed, deferred }),
          (error) => post({ failed: String(error), id: request.id }),
        );
        return;
      case "phase": {
        const { phase, resource } = progress.snapshot();
        post({ phase, ...(resource === undefined ? {} : { resource }) });
        return;
      }
      case "outputStatus":
        within(() => outputStatus(request)).then(
          (status) => post({ outputOf: request.id, status }),
          (error) => post({ failed: String(error), id: request.id }),
        );
        return;
      case "read":
        within(() => read(request)).then(
          (content) => post({ read: request.id, content }),
          (error) => post({ failed: String(error), id: request.id }),
        );
        return;
      case "hold":
        within(() => hold(request.model)).then(
          (childEnv) => post({ held: request.model, env: childEnv }),
          (error) => post({ failed: String(error), id: request.model }),
        );
        return;
      case "unhold":
        within(async () => {
          await held.get(request.model)?.flush();
          held.delete(request.model);
        }).then(
          () => post({ unheld: request.model }),
          (error) => post({ failed: String(error), id: request.model }),
        );
        return;
      case "run":
        within(() => turn(request)).then(
          ({ saw, turns }) => post({ turned: request.id, saw, turns }),
          (error) => post({ failed: String(error), id: request.id }),
        );
        return;
      case "resume":
        resumes.get(request.id)?.();
        resumes.delete(request.id);
        return;
      case "catchUp": {
        const config = datastoreConfig;
        if (isCustomDatastoreConfig(config)) {
          post({
            failed: "a local writer host runs on a filesystem datastore",
          });
          return;
        }
        catchUpV3HandlesAt(config.path).then(
          () => post({ caughtUp: true }),
          (error) => post({ failed: String(error) }),
        );
        return;
      }
      case "die":
        endWriterInstanceForTesting();
        resumes.clear();
        return;
      case "close":
        within(close).then(
          () => post({ closed: true }),
          (error) => post({ failed: String(error) }),
        );
        return;
    }
  };
};
