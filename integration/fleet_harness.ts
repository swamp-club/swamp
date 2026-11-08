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
 * Multi-worker serve harness for the fleet fan-out work (swamp-club#4271).
 *
 * One in-process serve assembly over a temp repo: a real WorkerGateway and
 * DispatchService (the gateway's notify hooks bound to it, as `swamp serve`
 * binds them) and the data plane on a port-0 localhost listener. Workers
 * connect in-process over paired RPC channels and enroll with real
 * enrollment tokens. Each worker answers its dispatches itself (succeed,
 * fail, or hold until the test releases it) and counts them, so a test pins
 * placement by how many dispatches each worker received.
 *
 * Workflow runs go through serve's own entry, `executeWorkflowWithLocks`,
 * and retries through the assembly `resume_launcher.ts` uses, so runs, the
 * per-model step lock and resume take the paths serve takes.
 *
 * Every worker enrolls through the gateway's verify-on-enroll path. A
 * worker added with `unverified: true` fails its probe and stays
 * `unverified`, exactly as a worker that failed the fleet probe does.
 */

import { waitFor } from "@swamp-club/swamp-testing";
import { z } from "zod";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { setRemoteStepDispatcher } from "../src/domain/remote/remote_dispatch.ts";
import { setWorkerPoolReader } from "../src/domain/remote/worker_pool.ts";
import { createServeWorkerPoolReader } from "../src/serve/worker_pool_reader.ts";
import type { StepPlacement } from "../src/domain/remote/scheduler.ts";
import { RpcChannel } from "../src/domain/remote/rpc_channel.ts";
import {
  type DispatchResult,
  type EnrollResult,
  REMOTE_PROTOCOL_VERSION,
  RemoteMethod,
  WorkerMethod,
} from "../src/domain/remote/protocol.ts";
import {
  WORKER_MODEL_TYPE,
  workerDefinitionName,
  type WorkerStatus,
} from "../src/domain/models/worker/worker_model.ts";
import type { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import type { WorkflowRunEvent } from "../src/libswamp/workflows/run.ts";
import type { WorkflowRunView } from "../src/libswamp/workflows/workflow_run_view.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { modelMethodRun } from "../src/libswamp/models/run.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createWorkerModelRunDeps } from "../src/libswamp/worker/run_deps.ts";
import {
  ENROLLMENT_TOKEN_MODEL_TYPE,
  tokenSecretKey,
} from "../src/domain/models/worker/enrollment_token_model.ts";
import { WorkflowRunCheckpointer } from "../src/infrastructure/persistence/workflow_run_checkpointer.ts";
import { CapabilityService } from "../src/serve/capability_service.ts";
import { WorkerGateway } from "../src/serve/worker_gateway.ts";
import { DispatchService } from "../src/serve/dispatch_service.ts";
import { DispatchRegistry } from "../src/serve/dispatch_registry.ts";
import { BundleRegistry } from "../src/serve/bundle_registry.ts";
import { DataPlane } from "../src/serve/data_plane.ts";
import { sweepStaleRecords } from "../src/serve/boot_reconciliation.ts";
import {
  createStepLockHook,
  createWorkflowRunDeps,
  executeWorkflowWithLocks,
} from "../src/serve/deps.ts";
import { BASELINE_VAULT, initRepo } from "./remote_secrets_baseline_harness.ts";

/** How a worker answers the dispatches it receives. */
export type DispatchBehavior =
  | { kind: "succeed" }
  | { kind: "fail"; error: string }
  /** Waits until the test calls `release()` on the worker, then succeeds. */
  | { kind: "hold" };

/** One dispatch a worker received, in arrival order. */
export interface ReceivedDispatch {
  dispatchId: string;
  workflowName?: string;
  jobName?: string;
  stepName?: string;
}

export interface FleetWorkerOptions {
  labels?: Record<string, string>;
  platform?: string;
  arch?: string;
  /** Concurrent dispatch slots advertised at enrollment. Default 1. */
  capacity?: number;
  /** Fail the enrollment probe, so the worker stays `unverified`. */
  unverified?: boolean;
}

/** A worker connected to the fleet's serve, in this process. */
export class FleetWorker {
  readonly name: string;
  #instanceUuid = crypto.randomUUID();
  readonly received: ReceivedDispatch[] = [];
  behavior: DispatchBehavior = { kind: "succeed" };
  #fleet: Fleet;
  #token: string;
  #options: FleetWorkerOptions;
  #channel: RpcChannel | null = null;
  #closeSocket: (() => void) | null = null;
  #held: Array<() => void> = [];
  #enrollResult: EnrollResult | null = null;

  constructor(
    fleet: Fleet,
    name: string,
    token: string,
    options: FleetWorkerOptions,
  ) {
    this.#fleet = fleet;
    this.name = name;
    this.#token = token;
    this.#options = options;
  }

  /** Dispatches this worker has received. */
  get dispatchCount(): number {
    return this.received.length;
  }

  /** Dispatches waiting on `release()`. */
  get heldCount(): number {
    return this.#held.length;
  }

  get enrollResult(): EnrollResult {
    if (!this.#enrollResult) throw new Error(`${this.name} never enrolled`);
    return this.#enrollResult;
  }

  /** The gateway's live status for this worker, or null when not in the pool. */
  status(): WorkerStatus | "busy" | null {
    return this.#fleet.gateway.worker(this.name)?.status ?? null;
  }

  /** Lets the oldest held dispatch finish (all of them with `all`). */
  release(all = false): void {
    const count = all ? this.#held.length : Math.min(1, this.#held.length);
    for (const resume of this.#held.splice(0, count)) resume();
  }

  get instanceUuid(): string {
    return this.#instanceUuid;
  }

  /** A restarted worker process: same machine and token, new instance UUID. */
  async restart(): Promise<void> {
    this.#instanceUuid = crypto.randomUUID();
    await this.connect();
  }

  /** Opens a control socket and enrolls (a reconnect after the first time). */
  async connect(): Promise<void> {
    const channel: RpcChannel = new RpcChannel({
      send: (data) => void Promise.resolve().then(() => attached.feed(data)),
    });
    const attached = this.#fleet.gateway.attachTransport({
      send: (data) =>
        void Promise.resolve().then(() => channel.handleRaw(data)),
    }, () => attached.closed());
    channel.register(
      WorkerMethod.dispatch,
      (raw) => this.#answer(raw as Record<string, unknown>),
    );
    this.#channel = channel;
    this.#closeSocket = () => attached.closed();
    this.#enrollResult = await channel.call<EnrollResult>(
      RemoteMethod.enroll,
      {
        token: this.#token,
        instanceUuid: this.#instanceUuid,
        machineId: `machine-${this.name}`,
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        swampVersion: "test",
        platform: this.#options.platform ?? "linux",
        arch: this.#options.arch ?? "x86_64",
        labels: this.#options.labels ?? {},
        resourceLimits: { capacity: this.#options.capacity ?? 1 },
      },
    );
    // Enrollment ends with the verify probe; wait for its verdict.
    const settledStatus = this.#options.unverified ? "unverified" : "idle";
    await waitFor(
      () => this.status() === settledStatus,
      `${this.name} to settle as ${settledStatus}`,
    );
    await this.#fleet.waitForRecordStatus(this.name, settledStatus);
  }

  /** Announces draining, as a worker does on SIGTERM. */
  async drain(): Promise<void> {
    if (!this.#channel) throw new Error(`${this.name} is not connected`);
    await this.#channel.call(RemoteMethod.drain, {});
    await waitFor(
      () => this.status() === "draining",
      `${this.name} to drain`,
    );
    await this.#fleet.waitForRecordStatus(this.name, "draining");
  }

  /**
   * Drops the control socket. Resolves once the worker's record reads
   * `disconnected`; the worker stays in the pool, not connected, for the
   * gateway's grace window. With `untilRemoved`, also waits out that window.
   */
  async disconnect(options: { untilRemoved?: boolean } = {}): Promise<void> {
    this.#closeSocket?.();
    this.#channel = null;
    this.#closeSocket = null;
    await this.#fleet.waitForRecordStatus(this.name, "disconnected");
    if (options.untilRemoved) {
      await waitFor(
        () => this.#fleet.gateway.worker(this.name) === null,
        `${this.name} to leave the pool`,
      );
    }
  }

  async #answer(frame: Record<string, unknown>): Promise<DispatchResult> {
    const step = frame.step as ReceivedDispatch | undefined;
    this.received.push({
      dispatchId: String(frame.dispatchId),
      workflowName: step?.workflowName,
      jobName: step?.jobName,
      stepName: step?.stepName,
    });
    const behavior = this.behavior;
    this.#fleet.enterDispatch();
    try {
      if (behavior.kind === "hold") {
        await new Promise<void>((resume) => this.#held.push(resume));
      }
      if (behavior.kind === "fail") {
        return {
          status: "error",
          error: behavior.error,
          outputs: [],
          logs: [],
          durationMs: 0,
        };
      }
      return { status: "success", outputs: [], logs: [], durationMs: 0 };
    } finally {
      this.#fleet.leaveDispatch();
    }
  }
}

export interface FleetOptions {
  /** Serve-level queue timeout. Default 15s; steps can set their own. */
  queueTimeoutMs?: number;
  /** How long a dropped worker stays in the pool. Default 1s. */
  graceWindowMs?: number;
}

/** Options for {@link Fleet.retryRun}, as `swamp workflow run --resume` takes them. */
export interface RetryOptions {
  fromStep?: string;
  fromJob?: string;
}

/**
 * The fleet: serve's dispatch path, its workers, and a run entry. Dispose it
 * with `await using`; disposal disconnects nothing explicitly but waits for
 * the gateway's and dispatch service's background writes, then removes the
 * temp repo.
 */
export class Fleet implements AsyncDisposable {
  readonly repoDir: string;
  readonly repoContext: Awaited<
    ReturnType<typeof requireInitializedRepoUnlocked>
  >["repoContext"];
  readonly gateway: WorkerGateway;
  readonly dispatchService: DispatchService;
  /** The model type every fleet step runs; registered per fleet. */
  readonly modelType: ModelType;
  readonly workers = new Map<string, FleetWorker>();
  /** The most dispatches that were in flight at once, across all workers. */
  maxInFlight = 0;
  #inFlight = 0;
  #repo: Awaited<ReturnType<typeof requireInitializedRepoUnlocked>>;
  #server: Deno.HttpServer;
  #unverified = new Set<string>();
  #tempDir: string;

  private constructor(
    tempDir: string,
    repo: Awaited<ReturnType<typeof requireInitializedRepoUnlocked>>,
    gateway: WorkerGateway,
    dispatchService: DispatchService,
    server: Deno.HttpServer,
    modelType: ModelType,
    unverified: Set<string>,
  ) {
    this.#tempDir = tempDir;
    this.#repo = repo;
    this.repoDir = repo.repoDir;
    this.repoContext = repo.repoContext;
    this.gateway = gateway;
    this.dispatchService = dispatchService;
    this.#server = server;
    this.modelType = modelType;
    this.#unverified = unverified;
  }

  static async start(options: FleetOptions = {}): Promise<Fleet> {
    const dir = await Deno.makeTempDir({ prefix: "swamp-fleet-" });
    // Whatever was set up before a failure is torn down with the temp dir,
    // so a failed start leaves no listener or open catalog behind.
    let repo:
      | Awaited<ReturnType<typeof requireInitializedRepoUnlocked>>
      | undefined;
    let gateway: WorkerGateway | undefined;
    let server: Deno.HttpServer | undefined;
    try {
      await initRepo(dir);
      repo = await requireInitializedRepoUnlocked({
        repoDir: dir,
        outputMode: "log",
      });
      const { repoContext } = repo;
      const dispatches = new DispatchRegistry();
      const bundles = new BundleRegistry();
      const capabilityService = new CapabilityService({
        repoDir: repo.repoDir,
        repoContext,
        dispatches,
      });
      const dispatchService = new DispatchService({
        repoDir: repo.repoDir,
        repoContext,
        dispatches,
        bundles,
        queueTimeoutMs: options.queueTimeoutMs ?? 15_000,
        captureEnvironment: () => ({}),
      });
      const unverified = new Set<string>();
      gateway = new WorkerGateway({
        repoDir: repo.repoDir,
        repoContext,
        capabilityService,
        graceWindowMs: options.graceWindowMs ?? 1_000,
        verifyOnEnroll: true,
        verifyWorker: (name) =>
          Promise.resolve(
            unverified.has(name)
              ? { ok: false, failureReason: "fleet harness: probe failed" }
              : { ok: true },
          ),
        onWorkerIdle: (worker) => dispatchService.notifyWorkerIdle(worker),
        onGraceExpired: (worker) => dispatchService.notifyGraceExpired(worker),
        onWorkerEnrolled: (worker) =>
          dispatchService.notifyWorkerEnrolled(worker),
        onWorkerDraining: (worker) =>
          dispatchService.notifyWorkerDraining(worker),
        onWorkerRemoved: (worker) =>
          dispatchService.notifyWorkerRemoved(worker),
      });
      dispatchService.bindGateway(gateway);
      const dataPlane = new DataPlane({
        repoDir: repo.repoDir,
        repoContext,
        sessions: gateway.sessions,
        dispatches,
        bundles,
        workerReads: capabilityService,
        onFirstWrite: (dispatch) => dispatchService.recordFirstWrite(dispatch),
      });
      dispatchService.setOnDispatchEnd((id) => dataPlane.releaseDispatch(id));
      await sweepStaleRecords({ repoContext });
      server = Deno.serve(
        { port: 0, hostname: "127.0.0.1", onListen: () => {} },
        async (req) =>
          (await dataPlane.handle(req)) ??
            new Response("Not found", { status: 404 }),
      );

      // A per-fleet type, so repeats never meet a registration an earlier
      // run left behind. Its method never runs here: every step that uses
      // it carries a placement and is dispatched to a fleet worker.
      const modelType = ModelType.create(`test/fleet-${crypto.randomUUID()}`);
      modelRegistry.register({
        type: modelType,
        version: "2026.11.02.1",
        methods: {
          run: {
            description: "Dispatched to a fleet worker",
            arguments: z.object({}),
            execute: () => Promise.resolve({ dataHandles: [] }),
          },
        },
      });
      setRemoteStepDispatcher(dispatchService);
      setWorkerPoolReader(createServeWorkerPoolReader({
        gateway,
        query: (predicate, options) =>
          repoContext.dataQueryService.query(predicate, options),
        namespace: repoContext.unifiedDataRepo.namespace,
      }));
      return new Fleet(
        dir,
        repo,
        gateway,
        dispatchService,
        server,
        modelType,
        unverified,
      );
    } catch (error) {
      setWorkerPoolReader(null);
      setRemoteStepDispatcher(null);
      gateway?.dispose();
      await server?.shutdown();
      await gateway?.settled();
      repo?.repoContext.catalogStore.close();
      await removeDir(dir);
      throw error;
    }
  }

  /** Mints a token for `name`, connects the worker, and waits for it to settle. */
  async addWorker(
    name: string,
    options: FleetWorkerOptions = {},
  ): Promise<FleetWorker> {
    if (options.unverified) this.#unverified.add(name);
    const worker = new FleetWorker(
      this,
      name,
      await this.#mintToken(name),
      options,
    );
    this.workers.set(name, worker);
    await worker.connect();
    return worker;
  }

  /** The named worker. */
  worker(name: string): FleetWorker {
    const worker = this.workers.get(name);
    if (!worker) throw new Error(`no fleet worker named ${name}`);
    return worker;
  }

  /** Dispatch counts per worker name, every fleet worker included. */
  dispatchCounts(): Record<string, number> {
    return Object.fromEntries(
      [...this.workers.values()].map((w) => [w.name, w.dispatchCount]),
    );
  }

  /** Saves a definition of the fleet's model type. */
  async saveDefinition(name: string): Promise<Definition> {
    const definition = Definition.create({ name });
    await this.repoContext.definitionRepo.save(this.modelType, definition);
    return definition;
  }

  /**
   * Sends one step straight to serve's dispatch service, as a workflow step
   * with this placement reaches it, and returns the worker that ran it.
   */
  async dispatchStep(
    definition: Definition,
    placement: StepPlacement,
    stepName = "step",
  ): Promise<string> {
    const result = await this.dispatchService.executeRemote({
      placeArguments: (args) => args,
      placement,
      modelDef: modelRegistry.get(this.modelType)!,
      modelType: this.modelType,
      modelId: definition.id,
      methodName: "run",
      definitionName: definition.name,
      definitionTags: {},
      definitionMeta: {
        id: definition.id,
        name: definition.name,
        version: definition.version,
        tags: {},
      },
      globalArgs: {},
      methodArgs: {},
      workflowName: "fleet",
      stepName,
    });
    if (!result.workerName) throw new Error(`${stepName} named no worker`);
    return result.workerName;
  }

  /** Saves a workflow given as its YAML data shape. */
  async saveWorkflow(
    data: Omit<Parameters<typeof Workflow.fromData>[0], "id">,
  ): Promise<Workflow> {
    const workflow = Workflow.fromData({ id: crypto.randomUUID(), ...data });
    await this.repoContext.workflowRepo.save(workflow);
    return workflow;
  }

  /** Runs a saved workflow through serve's run entry; returns the finished run. */
  async runWorkflow(
    name: string,
    options: { signal?: AbortSignal; lastEvaluated?: boolean } = {},
  ): Promise<WorkflowRunView> {
    let run: WorkflowRunView | undefined;
    let error: unknown;
    await executeWorkflowWithLocks(
      this.repoDir,
      this.repoContext,
      this.#repo.datastoreConfig,
      { workflowIdOrName: name, lastEvaluated: options.lastEvaluated },
      options.signal ?? new AbortController().signal,
      (event: WorkflowRunEvent) => {
        if (event.kind === "completed") run = event.run;
        if (event.kind === "error") error = event.error;
      },
      this.#repo.syncService,
      undefined,
      { syncGate: undefined },
    );
    if (!run) {
      throw new Error(
        `workflow ${name} did not complete: ${
          error instanceof Error ? error.message : JSON.stringify(error)
        }`,
      );
    }
    return run;
  }

  /**
   * Retries a run as serve's resume launcher does: a failed run with no
   * `fromStep` is a plain retry; `fromStep` re-enters at that step.
   */
  async retryRun(
    workflowName: string,
    runId: string,
    options: RetryOptions = {},
  ): Promise<WorkflowRun> {
    const stepLockHook = createStepLockHook(
      this.repoDir,
      this.repoContext,
      this.#repo.datastoreConfig,
      this.#repo.syncService,
      undefined,
    );
    const deps = await createWorkflowRunDeps(
      this.repoDir,
      this.repoContext,
      this.#repo.datastoreConfig,
      stepLockHook,
      undefined,
      { runCheckpointer: new WorkflowRunCheckpointer(this.repoContext) },
    );
    const service = deps.createExecutionService(
      this.repoContext.workflowRepo,
      this.repoContext.workflowRunRepo,
      this.repoDir,
      this.repoContext.catalogStore,
    );
    let finished: WorkflowRun | undefined;
    for await (
      const event of service.resume(workflowName, runId, {
        inputs: {},
        fromStep: options.fromStep,
        fromJob: options.fromJob,
      })
    ) {
      if (event.kind === "completed") finished = event.run;
    }
    if (!finished) throw new Error(`retry of run ${runId} did not complete`);
    return finished;
  }

  /** Waits until the worker's durable state record reads `status`. */
  async waitForRecordStatus(name: string, status: WorkerStatus): Promise<void> {
    await this.gateway.settled();
    await waitFor(
      async () => (await this.recordStatus(name)) === status,
      `${name}'s record to read ${status}`,
    );
  }

  /** The status in the worker's durable state record, which workers.connected() reads. */
  async recordStatus(name: string): Promise<string | undefined> {
    const records = await this.repoContext.dataQueryService.query(
      `modelType == "${WORKER_MODEL_TYPE.normalized}" && ` +
        `modelName == "${workerDefinitionName(name)}" && name == "state-main"`,
      { loadAttributes: true },
    ) as Array<{ attributes?: { status?: string } }>;
    return records[0]?.attributes?.status;
  }

  /** @internal Called by a worker as a dispatch starts. */
  enterDispatch(): void {
    this.#inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.#inFlight);
  }

  /** @internal Called by a worker as a dispatch ends. */
  leaveDispatch(): void {
    this.#inFlight--;
  }

  async #mintToken(name: string): Promise<string> {
    const deps = await createWorkerModelRunDeps(this.repoDir, this.repoContext);
    for await (
      const event of modelMethodRun(createLibSwampContext({}), deps, {
        modelIdOrName: name,
        methodName: "mint",
        inputs: { durationMs: 10 * 60 * 1000, vaultName: BASELINE_VAULT },
        lastEvaluated: false,
        typeArg: ENROLLMENT_TOKEN_MODEL_TYPE.normalized,
        definitionName: name,
      })
    ) {
      if (event.kind === "error") {
        const detail = event.error as { message?: unknown };
        throw new Error(String(detail?.message ?? "token mint failed"));
      }
    }
    const vault = await VaultService.fromRepository(this.repoDir);
    const plaintext = await vault.get(BASELINE_VAULT, tokenSecretKey(name));
    return `${name}.${plaintext}`;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    setWorkerPoolReader(null);
    setRemoteStepDispatcher(null);
    try {
      // Stop new dispatches first, then let any held one finish.
      this.gateway.dispose();
      for (const worker of this.workers.values()) worker.release(true);
      await this.#server.shutdown();
      await this.gateway.settled();
      await this.dispatchService.settled();
    } finally {
      this.repoContext.catalogStore.close();
      await removeDir(this.#tempDir);
    }
  }
}

async function removeDir(dir: string): Promise<void> {
  if (Deno.build.os === "windows") {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  } else {
    await Deno.remove(dir, { recursive: true });
  }
}
