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
 * The orchestrator's step dispatcher (see design/remote-execution.md,
 * "Scheduling, fan-out, and provisioning" and "Failure, reconnection, and
 * retry").
 *
 * Implements the domain's RemoteStepDispatcher port: schedules a placed
 * step onto the pool (queueing while every eligible worker is busy),
 * acquires a step lease, ships the dispatch with the environment snapshot
 * and bundle fingerprint, and applies the grace-window failure semantics —
 * a no-write step whose worker drops is re-dispatched; a write-bearing one
 * fails the run.
 */

import {
  createLibSwampContext,
  createWorkerModelRunDeps,
  modelMethodRun,
} from "../libswamp/mod.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import type { ModelDefinition } from "../domain/models/model.ts";
import {
  STEP_LEASE_INSTANCE_NAME,
  STEP_LEASE_MODEL_TYPE,
} from "../domain/models/worker/step_lease_model.ts";
import {
  captureEnvironmentSnapshot,
} from "../domain/remote/environment_snapshot.ts";
import {
  type DispatchParams,
  type DispatchResult,
  REMOTE_PROTOCOL_VERSION,
  type RpcStreamEvent,
} from "../domain/remote/protocol.ts";
import { ChannelClosedError, RpcError } from "../domain/remote/rpc_channel.ts";
import {
  hasPlacement,
  type ScheduleDecision,
  scheduleStep,
  type StepPlacement,
} from "../domain/remote/scheduler.ts";
import type {
  RemoteStepRequest,
  RemoteStepResult,
} from "../domain/remote/remote_dispatch.ts";
import type { ModelMethodRunner } from "./worker_gateway.ts";
import type { WorkerSnapshot } from "./worker_gateway.ts";
import type { ActiveDispatch, DispatchRegistry } from "./dispatch_registry.ts";
import type { BundleRegistry } from "./bundle_registry.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

export { hasPlacement };

const logger = getSwampLogger(["serve", "dispatch"]);

/** Sentinel fingerprint for models compiled into the swamp binary. */
export const BUILTIN_BUNDLE_PREFIX = "builtin:";

/** Default ceiling on how long a step queues for a matching worker. */
export const DEFAULT_QUEUE_TIMEOUT_MS = 10 * 60 * 1000;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/** The slice of the worker gateway the dispatcher drives. */
export interface DispatchGateway {
  workers(): WorkerSnapshot[];
  worker(name: string): WorkerSnapshot | null;
  dispatch(
    name: string,
    params: DispatchParams,
    options?: {
      signal?: AbortSignal;
      onEvent?: (event: RpcStreamEvent) => void;
    },
  ): Promise<DispatchResult>;
}

export interface DispatchServiceOptions {
  repoDir: string;
  repoContext: RepositoryContext;
  dispatches: DispatchRegistry;
  bundles: BundleRegistry;
  queueTimeoutMs?: number;
  /** Test seam: overrides the modelMethodRun-backed lease transitions. */
  runModelMethod?: ModelMethodRunner;
  /** Test seam: overrides the shipped environment snapshot capture. */
  captureEnvironment?: () => Record<string, string>;
}

export class DispatchService {
  readonly #options: DispatchServiceOptions;
  readonly #queueTimeoutMs: number;
  readonly #runModelMethod: ModelMethodRunner;
  readonly #captureEnvironment: () => Record<string, string>;
  #gateway: DispatchGateway | null = null;
  #onDispatchEnd: ((dispatchId: string) => void) | null = null;
  /** Workers picked by a queued step but not yet marked busy. */
  readonly #reserved = new Set<string>();
  /** Dispatches that performed at least one durable write. */
  readonly #writesByDispatch = new Set<string>();
  /** Steps waiting for the pool to change (a worker idled or expired). */
  #poolWaiters: Array<() => void> = [];
  /** Serializes lease transitions (sole-writer rule, like the gateway). */
  #transitionTail: Promise<unknown> = Promise.resolve();

  constructor(options: DispatchServiceOptions) {
    this.#options = options;
    this.#queueTimeoutMs = options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
    this.#runModelMethod = options.runModelMethod ??
      ((input) => this.#defaultRunModelMethod(input));
    this.#captureEnvironment = options.captureEnvironment ??
      (() => captureEnvironmentSnapshot(Deno.env.toObject()));
  }

  bindGateway(gateway: DispatchGateway): void {
    this.#gateway = gateway;
  }

  /** Called by serve wiring so finished dispatches release writer sessions. */
  setOnDispatchEnd(callback: (dispatchId: string) => void): void {
    this.#onDispatchEnd = callback;
  }

  /** Gateway hook: a worker became idle — wake queued steps. */
  notifyWorkerIdle(_worker: WorkerSnapshot): void {
    this.#wakePoolWaiters();
  }

  /** Gateway hook: a worker's grace window expired — wake queued steps. */
  notifyGraceExpired(_worker: WorkerSnapshot): void {
    this.#wakePoolWaiters();
  }

  /**
   * Data-plane hook, awaited BEFORE the first durable write persists, so a
   * lease can never say "no writes" while a write exists. The converse
   * (lease marked, write failed) is safe — it only makes failure semantics
   * more conservative.
   */
  async recordFirstWrite(dispatch: ActiveDispatch): Promise<void> {
    if (this.#writesByDispatch.has(dispatch.dispatchId)) {
      return;
    }
    this.#writesByDispatch.add(dispatch.dispatchId);
    await this.#leaseTransition("mark_writes", { leaseId: dispatch.leaseId });
  }

  /**
   * Execute a placed step remotely. Re-dispatches across workers when a
   * no-write attempt is lost to a socket drop; fails the run when a
   * write-bearing attempt drops.
   */
  async executeRemote(request: RemoteStepRequest): Promise<RemoteStepResult> {
    if (this.#gateway === null) {
      throw new Error("DispatchService has no gateway bound");
    }
    const deadline = Date.now() + this.#queueTimeoutMs;

    while (true) {
      request.signal?.throwIfAborted();
      const workerName = await this.#acquireWorker(
        request.placement,
        request.signal,
        deadline,
      );
      try {
        return await this.#dispatchOnce(workerName, request);
      } catch (error) {
        if (error instanceof WorkerLostError) {
          if (error.hadWrites) {
            throw new Error(
              `Worker '${workerName}' disconnected after step '${
                request.stepName ?? request.methodName
              }' had written data — failing the run (write-then-drop)`,
            );
          }
          logger.warn(
            "Worker {worker} lost a no-write dispatch; re-scheduling",
            { worker: workerName },
          );
          continue;
        }
        if (error instanceof RpcError && error.code === "worker_busy") {
          // Transient orchestrator/worker view desync (e.g. a cancel grace
          // period elapsed before the worker freed its serial slot). The
          // worker IS busy — treat it like any busy worker and re-queue.
          logger.warn(
            "Worker {worker} reported busy on dispatch; re-queueing step",
            { worker: workerName },
          );
          await this.#waitForPoolChange(
            Math.max(deadline - Date.now(), 0),
            request.signal,
          );
          continue;
        }
        throw error;
      } finally {
        this.#reserved.delete(workerName);
      }
    }
  }

  async #dispatchOnce(
    workerName: string,
    request: RemoteStepRequest,
  ): Promise<RemoteStepResult> {
    const gateway = this.#gateway!;
    const dispatchId = crypto.randomUUID();
    const leaseId = dispatchId;
    let leaseSettled = false;

    const bundleFingerprint = await this.#ensureBundle(request.modelDef);

    await this.#leaseTransition("acquire", {
      leaseId,
      dispatchId,
      workerName,
      modelType: request.modelType.normalized,
      modelId: request.modelId,
      methodName: request.methodName,
      workflowName: request.workflowName,
      jobName: request.jobName,
      stepName: request.stepName,
    });

    this.#options.dispatches.register({
      workerName,
      dispatchId,
      leaseId,
      modelDef: request.modelDef,
      modelType: request.modelType,
      modelId: request.modelId,
      methodName: request.methodName,
      definitionName: request.definitionName,
      definitionTags: request.definitionTags,
      runtimeTags: request.runtimeTags,
    });

    const params: DispatchParams = {
      dispatchId,
      leaseId,
      execution: {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        modelType: request.modelType.normalized,
        modelId: request.modelId,
        methodName: request.methodName,
        globalArgs: request.globalArgs,
        methodArgs: request.methodArgs,
        definitionMeta: request.definitionMeta,
        resourceSpecs: request.resourceSpecs,
        fileSpecs: request.fileSpecs,
        traceHeaders: request.traceHeaders,
      },
      bundleFingerprint,
      reportBundleFingerprints: [],
      environmentSnapshot: this.#captureEnvironment(),
      step: {
        workflowName: request.workflowName,
        jobName: request.jobName,
        stepName: request.stepName,
      },
    };

    try {
      const result = await gateway.dispatch(workerName, params, {
        signal: request.signal,
        onEvent: request.onEvent,
      });
      if (result.status === "error") {
        leaseSettled = true;
        await this.#leaseTransition("fail", {
          leaseId,
          error: result.error ?? "remote execution failed",
        });
        throw new Error(result.error ?? "Remote execution failed");
      }
      leaseSettled = true;
      await this.#leaseTransition("complete", { leaseId });
      return {
        outputs: result.outputs,
        logs: result.logs,
        durationMs: result.durationMs,
        followUpActions: result.followUpActions,
        workerName,
      };
    } catch (error) {
      if (
        (error instanceof RpcError && error.code === "cancelled") ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        await this.#leaseTransition("fail", {
          leaseId,
          error: "dispatch cancelled",
        });
        throw new DOMException(
          `Dispatch of step '${
            request.stepName ?? request.methodName
          }' was cancelled`,
          "AbortError",
        );
      }
      if (error instanceof ChannelClosedError) {
        const hadWrites = this.#writesByDispatch.has(dispatchId);
        const fate = await this.#awaitWorkerFate(workerName, request.signal);
        if (hadWrites) {
          await this.#leaseTransition("fail", {
            leaseId,
            error: "worker disconnected after writing (write-then-drop)",
          });
        } else {
          await this.#leaseTransition("expire", {
            leaseId,
            error: `worker ${
              fate === "reconnected" ? "reconnected after drop" : "lost"
            }; no writes had occurred`,
          });
        }
        throw new WorkerLostError(workerName, hadWrites);
      }
      // Anything else (worker_busy desync, unexpected RPC failure): the
      // attempt is abandoned, not a method failure — end the lease so it
      // cannot leak as 'active', then let executeRemote decide. Leases the
      // try block already settled (fail/complete) are left alone.
      if (!leaseSettled) {
        await this.#leaseTransition("expire", {
          leaseId,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {});
      }
      throw error;
    } finally {
      this.#options.dispatches.unregister(workerName, dispatchId);
      this.#writesByDispatch.delete(dispatchId);
      this.#onDispatchEnd?.(dispatchId);
    }
  }

  /** Schedule against the live pool, queueing while eligible workers are busy. */
  async #acquireWorker(
    placement: StepPlacement,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<string> {
    while (true) {
      signal?.throwIfAborted();
      const decision: ScheduleDecision = scheduleStep(
        placement,
        this.#poolSnapshot(),
      );
      if (decision.kind === "dispatch") {
        this.#reserved.add(decision.worker.name);
        return decision.worker.name;
      }
      if (decision.kind === "unschedulable") {
        throw new Error(decision.reason);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          "Timed out waiting for a matching worker to become available",
        );
      }
      await this.#waitForPoolChange(remaining, signal);
    }
  }

  /** The live pool with steps' not-yet-busy reservations applied. */
  #poolSnapshot(): WorkerSnapshot[] {
    return this.#gateway!.workers().map((worker) =>
      this.#reserved.has(worker.name) && worker.status === "idle"
        ? { ...worker, status: "busy" as const }
        : worker
    );
  }

  #wakePoolWaiters(): void {
    const waiters = this.#poolWaiters;
    this.#poolWaiters = [];
    for (const wake of waiters) {
      wake();
    }
  }

  #waitForPoolChange(
    maxWaitMs: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(), Math.min(maxWaitMs, 5_000));
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new DOMException("Dispatch was aborted", "AbortError"));
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#poolWaiters.push(finish);
    });
  }

  /**
   * After a mid-dispatch socket drop, observe the worker's fate: it either
   * reconnects within the grace window or the gateway removes it.
   */
  async #awaitWorkerFate(
    workerName: string,
    signal?: AbortSignal,
  ): Promise<"reconnected" | "expired"> {
    while (true) {
      signal?.throwIfAborted();
      const current = this.#gateway!.worker(workerName);
      if (current === null) {
        return "expired";
      }
      if (current.connected) {
        return "reconnected";
      }
      await this.#waitForPoolChange(60_000, signal);
    }
  }

  async #ensureBundle(modelDef: ModelDefinition): Promise<string> {
    if (!modelDef.bundleSourceFactory) {
      // Built-in model: the worker's own binary carries it; enrollment
      // already guaranteed version lockstep.
      return `${BUILTIN_BUNDLE_PREFIX}${modelDef.type.normalized}`;
    }
    const js = await modelDef.bundleSourceFactory();
    const fingerprint = await sha256Hex(js);
    this.#options.bundles.register(fingerprint, {
      js,
      filesRoot: modelDef.extensionFilesRoot,
    });
    return fingerprint;
  }

  #leaseTransition(
    methodName: string,
    inputs: Record<string, unknown>,
  ): Promise<void> {
    const run = () =>
      this.#runModelMethod({
        typeArg: STEP_LEASE_MODEL_TYPE.normalized,
        definitionName: STEP_LEASE_INSTANCE_NAME,
        methodName,
        inputs,
      });
    const next = this.#transitionTail.then(run, run);
    this.#transitionTail = next.then(() => undefined, () => undefined);
    return next;
  }

  async #defaultRunModelMethod(input: {
    typeArg: string;
    definitionName: string;
    methodName: string;
    inputs: Record<string, unknown>;
  }): Promise<void> {
    const deps = await createWorkerModelRunDeps(
      this.#options.repoDir,
      this.#options.repoContext,
    );
    const libCtx = createLibSwampContext({});
    for await (
      const event of modelMethodRun(libCtx, deps, {
        modelIdOrName: input.definitionName,
        methodName: input.methodName,
        inputs: input.inputs,
        lastEvaluated: false,
        typeArg: input.typeArg,
        definitionName: input.definitionName,
        // Control-plane bookkeeping: skip per-run report artifacts so pool
        // churn stays bounded to the state records themselves.
        skipAllReports: true,
      })
    ) {
      if (event.kind === "error") {
        const detail = event.error;
        const message = typeof detail === "object" && detail !== null &&
            "message" in detail
          ? String((detail as { message: unknown }).message)
          : String(detail);
        throw new Error(message);
      }
    }
  }
}

/** A dispatch was lost to a control-socket drop. */
export class WorkerLostError extends Error {
  readonly workerName: string;
  readonly hadWrites: boolean;

  constructor(workerName: string, hadWrites: boolean) {
    super(
      `Worker '${workerName}' disconnected mid-dispatch (writes: ${hadWrites})`,
    );
    this.name = "WorkerLostError";
    this.workerName = workerName;
    this.hadWrites = hadWrites;
  }
}
