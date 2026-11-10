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

import { currentRunProgress } from "../domain/remote/run_progress.ts";
import {
  currentVaultAccess,
  runGeneratorWithoutVaultAccess,
  withoutVaultAccess,
} from "../domain/vaults/run_vault_access.ts";
import { isAbsolute, join, relative, SEPARATOR } from "@std/path";
import {
  dispatchTraceCarrier,
  observeExecutionWork,
} from "../domain/remote/observability.ts";
import { createLibSwampContext } from "../libswamp/context.ts";
import { createWorkerModelRunDeps } from "../libswamp/worker/run_deps.ts";
import { ModelType } from "../domain/models/model_type.ts";
import { modelMethodRun } from "../libswamp/models/run.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import { repoUnitOfWorkFactory } from "../infrastructure/persistence/repo_unit_of_work.ts";
import type { ModelDefinition } from "../domain/models/model.ts";
import type { EndedLeaseState } from "../domain/models/worker/step_lease_model.ts";
import { PENDING_DISPATCH_END_METHODS } from "../domain/models/worker/pending_dispatch_model.ts";
import {
  captureEnvironmentSnapshot,
} from "../domain/remote/environment_snapshot.ts";
import { markErrorPaths, UserError } from "../domain/errors.ts";
import {
  ARGUMENTS_VALIDATED_EVENT,
  type DispatchParams,
  type DispatchResult,
  REMOTE_PROTOCOL_VERSION,
  type RpcStreamEvent,
  shipsReferencesOnly,
  type WithheldAsset,
} from "../domain/remote/protocol.ts";
import { ChannelClosedError, RpcError } from "../domain/remote/rpc_channel.ts";
import {
  describePlacement,
  hasPlacement,
  laneDispatchVerdict,
  type ScheduleDecision,
  scheduleStep,
  type StepPlacement,
  unmetPlacement,
} from "../domain/remote/scheduler.ts";
import {
  type RemoteStepRequest,
  type RemoteStepResult,
  withRemoteOutputs,
} from "../domain/remote/remote_dispatch.ts";
import type { ModelMethodRunner } from "./worker_gateway.ts";
import type { WorkerSnapshot } from "./worker_gateway.ts";
import { WorkerNotDispatchableError } from "./worker_gateway.ts";
import {
  type ActiveDispatch,
  bagReferenceSet,
  type DispatchRegistry,
} from "./dispatch_registry.ts";
import { type BundleRegistry, hashAssetBytes } from "./bundle_registry.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { RemoteLockHolder } from "../domain/datastore/lock_holder_marker.ts";
import {
  extractVaultReferences,
  withVaultReferences,
} from "../domain/expressions/vault_reference_extractor.ts";
import { SecretRedactor } from "../domain/secrets/secret_redactor.ts";
import type { WrittenVersion } from "../domain/datastore/datastore_sync_service.ts";
import { writtenVersionsOf } from "../domain/models/method_execution_service.ts";
import { TransitionTail } from "./transition_tail.ts";
import {
  LEASE_END_METHODS,
  methodRunnerLeaseStore,
  StepLeaseLedger,
  type StepLeaseStore,
} from "./step_lease_ledger.ts";
import {
  methodRunnerPendingDispatchStore,
  PendingDispatchLedger,
  type PendingDispatchStore,
  type ServePendingDispatchEnd,
} from "./pending_dispatch_ledger.ts";

export { hasPlacement };

const logger = getSwampLogger(["serve", "dispatch"]);

export const BUILTIN_BUNDLE_PREFIX = "builtin:";

export const DEFAULT_QUEUE_TIMEOUT_MS = 600 * 1000;

/**
 * never takes effect: the 5s backstop in #waitForPoolChange always wins; the
 * real wake signal is onWorkerEnrolled/onWorkerIdle
 */
const WAIT_FOREVER_POLL_CAP_MS = 60 * 1000;

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

type AssetRefusal = WithheldAsset["reason"];

/**
 * the containment check runs on real paths, so a declared file reached through
 * a symlinked directory is refused like a symlinked file
 */
async function readShippableAsset(
  filesRoot: string,
  realRoot: string | undefined,
  relPath: string,
): Promise<Uint8Array | AssetRefusal> {
  const path = join(filesRoot, relPath);
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch {
    return "missing";
  }
  if (info.isSymlink) return "a symlink";
  if (!info.isFile) return "not a regular file";
  let real: string;
  try {
    real = await Deno.realPath(path);
  } catch {
    return "missing";
  }
  if (realRoot === undefined || !isWithin(realRoot, real)) {
    return "outside the extension directory";
  }
  try {
    return await Deno.readFile(real);
  } catch {
    return "missing";
  }
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel.length > 0 && !isAbsolute(rel) && rel !== ".." &&
    !rel.startsWith(`..${SEPARATOR}`);
}

export interface DispatchGateway {
  workers(): WorkerSnapshot[];
  worker(name: string): WorkerSnapshot | null;
  dispatch(
    name: string,
    params: DispatchParams,
    options?: {
      signal?: AbortSignal;
      onEvent?: (event: RpcStreamEvent) => void;
      /**
       * Called synchronously once the dispatch is listed in the worker's
       * `activeDispatchIds`, i.e. from then on the pool itself counts the
       * slot as taken.
       */
      onRegistered?: () => void;
    },
  ): Promise<DispatchResult>;
}

interface DispatchFrame {
  protocolVersion: number;
  globalArgs: Record<string, unknown>;
  methodArgs: Record<string, unknown>;
  secrets: Pick<
    DispatchParams,
    "referenceBag" | "secretValues" | "unresolvedMethodArgs" | "secretBag"
  >;
  redactorSeeds: string[] | undefined;
}

function scrubbedOutputEvent(
  event: RpcStreamEvent,
  redactor: SecretRedactor,
): RpcStreamEvent {
  const inner = event.event;
  if (typeof inner !== "object" || inner === null) return event;
  const { type, line } = inner as Record<string, unknown>;
  if (type !== "output" || typeof line !== "string") return event;
  return { ...event, event: { ...inner, line: redactor.redact(line) } };
}

export interface DispatchServiceOptions {
  repoDir: string;
  repoContext: RepositoryContext;
  dispatches: DispatchRegistry;
  bundles: BundleRegistry;
  queueTimeoutMs?: number;
  runModelMethod?: ModelMethodRunner;
  /**
   * Serve's `dispatch-env-allow`: the only variables the environment
   * snapshot ships. Unset ships the full snapshot (minus the denylist).
   */
  dispatchEnvAllow?: readonly string[];
  captureEnvironment?: () => Record<string, string>;
}

/**
 * carries the versions a failed dispatch wrote as writtenVersions, for the
 * step's lock push; an error that cannot take the property is returned
 * unchanged
 */
export function withWrittenVersions(
  error: unknown,
  versions: readonly WrittenVersion[],
): unknown {
  if (versions.length === 0) return error;
  if (typeof error !== "object" || error === null) return error;
  try {
    Object.defineProperty(error, "writtenVersions", {
      value: [...versions],
      configurable: true,
      writable: true,
    });
  } catch {
    // A frozen error keeps what it has.
  }
  return error;
}

export class DispatchService {
  readonly #options: DispatchServiceOptions;
  #queueTimeoutMs: number;
  readonly #runModelMethod: ModelMethodRunner;
  readonly #stepLeases: StepLeaseStore;
  readonly #pendingDispatches: PendingDispatchStore;
  readonly #captureEnvironment: () => Record<string, string>;
  #gateway: DispatchGateway | null = null;
  #onDispatchEnd: ((dispatchId: string) => void) | null = null;
  #writtenVersionsOf:
    | ((dispatchId: string) => Promise<readonly WrittenVersion[]>)
    | null = null;
  /**
   * steps placed but not yet registered by the gateway; a reservation ends when
   * the dispatch appears in activeDispatchIds, so exactly one of the two counts
   * it
   */
  readonly #reserved = new Map<string, number>();
  readonly #writesByDispatch = new Set<string>();
  #poolWaiters: Array<() => void> = [];
  /**
   * orders transitions of each lease and pending dispatch (sole-writer rule,
   * like the gateway); different records do not wait on each other
   */
  readonly #transitions = new TransitionTail("dispatch");
  /**
   * affinity key to the worker that ran the group's first step; if that worker
   * disconnects or drains, later steps fail with WorkerAffinityLostError
   */
  readonly #affinityPins = new Map<string, string>();
  readonly #affinityInflight = new Map<string, Promise<string | undefined>>();
  constructor(options: DispatchServiceOptions) {
    this.#options = options;
    this.#queueTimeoutMs = options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
    this.#runModelMethod = options.runModelMethod ??
      ((input) => this.#defaultRunModelMethod(input));
    this.#stepLeases = options.runModelMethod
      ? methodRunnerLeaseStore(options.runModelMethod)
      : new StepLeaseLedger(
        options.repoContext,
        methodRunnerLeaseStore(this.#runModelMethod),
      );
    this.#pendingDispatches = options.runModelMethod
      ? methodRunnerPendingDispatchStore(options.runModelMethod)
      : new PendingDispatchLedger(
        options.repoContext,
        methodRunnerPendingDispatchStore(this.#runModelMethod),
      );
    this.#captureEnvironment = options.captureEnvironment ??
      (() =>
        captureEnvironmentSnapshot(
          Deno.env.toObject(),
          options.dispatchEnvAllow,
        ));
  }

  #buildDispatchRedactor(
    secretValues: string[] | undefined,
  ): SecretRedactor | undefined {
    if (!secretValues || secretValues.length === 0) return undefined;
    const redactor = new SecretRedactor();
    for (const value of secretValues) {
      redactor.addSecret(value);
    }
    return redactor;
  }

  bindGateway(gateway: DispatchGateway): void {
    this.#gateway = gateway;
  }

  async settled(): Promise<void> {
    await this.#transitions.settled();
  }

  setOnDispatchEnd(callback: (dispatchId: string) => void): void {
    this.#onDispatchEnd = callback;
  }

  setWrittenVersionsSource(
    source: (dispatchId: string) => Promise<readonly WrittenVersion[]>,
  ): void {
    this.#writtenVersionsOf = source;
  }

  notifyWorkerIdle(_worker: WorkerSnapshot): void {
    this.#wakePoolWaiters();
  }

  notifyGraceExpired(_worker: WorkerSnapshot): void {
    this.#wakePoolWaiters();
  }

  notifyWorkerRemoved(_worker: WorkerSnapshot): void {
    this.#wakePoolWaiters();
  }

  notifyWorkerEnrolled(_worker: WorkerSnapshot): void {
    this.#wakePoolWaiters();
  }

  notifyWorkerDraining(_worker: WorkerSnapshot): void {
    this.#wakePoolWaiters();
  }

  releaseAffinity(key: string): void {
    this.#affinityPins.delete(key);
    this.#affinityInflight.delete(key);
  }

  /**
   * awaited before the first durable write persists, so a lease never says no
   * writes while one exists; the converse is safe, only more conservative
   */
  async recordFirstWrite(dispatch: ActiveDispatch): Promise<void> {
    if (this.#writesByDispatch.has(dispatch.dispatchId)) {
      return;
    }
    this.#writesByDispatch.add(dispatch.dispatchId);
    await this.#leaseTransition(
      "mark_writes",
      dispatch.leaseId,
      (leases) => leases.markWrites(dispatch.leaseId),
    );
  }

  async executeRemote(request: RemoteStepRequest): Promise<RemoteStepResult> {
    return await observeExecutionWork("dispatch.logical", {
      "swamp.logical_dispatch.id": crypto.randomUUID(),
      ...(request.workflowRunId
        ? { "workflow.run_id": request.workflowRunId }
        : {}),
      ...(request.jobName ? { "job.name": request.jobName } : {}),
      ...(request.stepName ? { "step.name": request.stepName } : {}),
    }, () => this.#executeRemote(request));
  }

  /** a dispatch already waiting keeps the deadline it started with */
  setQueueTimeoutMs(queueTimeoutMs: number | undefined): void {
    this.#queueTimeoutMs = queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
  }

  async #executeRemote(request: RemoteStepRequest): Promise<RemoteStepResult> {
    if (this.#gateway === null) {
      throw new Error("DispatchService has no gateway bound");
    }
    const effectiveTimeoutMs = request.placement.queueTimeoutMs ??
      this.#queueTimeoutMs;
    const deadline = effectiveTimeoutMs === 0
      ? null
      : Date.now() + effectiveTimeoutMs;

    let currentQueueId: string | null = null;
    let lastDispatchId: string | null = null;
    const emitQueued = () => {
      if (currentQueueId !== null) return;
      request.onEvent?.({
        kind: "queued",
        requirement: describePlacement(request.placement),
      });
      const queueId = crypto.randomUUID();
      currentQueueId = queueId;
      this.#pendingTransition("enqueue", queueId, (pending) =>
        pending.enqueue({
          queueId,
          target: request.placement.target,
          labels: request.placement.labels,
          platform: request.placement.platform,
          workflowName: request.workflowName,
          jobName: request.jobName,
          stepName: request.stepName,
          modelType: request.modelType.normalized,
          methodName: request.methodName,
          queuedAt: new Date().toISOString(),
        }));
    };

    const endQueue = (
      end:
        | { state: "dispatched"; dispatchId: string }
        | { state: "timed_out" | "cancelled" },
    ) => {
      if (currentQueueId === null) return;
      const queueId = currentQueueId;
      currentQueueId = null;
      const ended: ServePendingDispatchEnd = {
        ...end,
        endedAt: new Date().toISOString(),
      };
      this.#pendingTransition(
        PENDING_DISPATCH_END_METHODS[end.state],
        queueId,
        (pending) => pending.end(queueId, ended),
      );
    };

    const onAbort = () => endQueue({ state: "cancelled" });
    request.signal?.addEventListener("abort", onAbort, { once: true });

    let affinitySlot: Promise<string | undefined> | null = null;
    let affinityResolve: ((name: string | undefined) => void) | null = null;
    let affinityReject: ((err: Error) => void) | null = null;
    let attemptWorker: string | undefined;
    let failure: unknown;
    try {
      const affinityKey = request.placement.affinityKey;
      let effectivePlacement = request.placement;
      let pinnedWorker: string | undefined;

      if (affinityKey) {
        // a first step that ends without binding the group hands its place to
        // the next waiting step
        while (!pinnedWorker && !affinityResolve) {
          pinnedWorker = this.#affinityPins.get(affinityKey);
          if (pinnedWorker) break;
          const inflight = this.#affinityInflight.get(affinityKey);
          if (inflight) {
            pinnedWorker = await observeExecutionWork(
              "dispatch.affinity",
              {},
              () => inflight,
            );
          } else {
            const { promise, resolve, reject } = Promise.withResolvers<
              string | undefined
            >();
            promise.catch(() => {});
            this.#affinityInflight.set(affinityKey, promise);
            affinitySlot = promise;
            affinityResolve = resolve;
            affinityReject = reject;
          }
        }
        if (pinnedWorker) {
          effectivePlacement = { ...request.placement, target: pinnedWorker };
        }
      }
      // a pin whose worker left or is draining fails the step rather than
      // queueing; a pinned worker not meeting placement also fails it, never
      // sent elsewhere, to keep co-location
      const assertPinHeld = () => {
        if (!affinityKey || !pinnedWorker) return;
        const worker = this.#gateway!.worker(pinnedWorker);
        if (worker === null || this.#pinnedWorkerLost(worker)) {
          throw new WorkerAffinityLostError(pinnedWorker, affinityKey);
        }
        const unmet = unmetPlacement(request.placement, worker);
        if (unmet !== null) {
          throw new AffinityPlacementMismatchError(
            pinnedWorker,
            affinityKey,
            unmet,
          );
        }
      };
      // a lane is never sent to its worker once it may not take it
      const lane = request.placement.lane;
      const assertPlaceable = () => {
        assertPinHeld();
        if (!lane) return;
        const verdict = laneDispatchVerdict(
          this.#gateway!.worker(lane.worker),
        );
        if (verdict.kind === "ineligible") {
          throw new WorkerIneligibleError(lane.worker, verdict.reason);
        }
      };
      assertPlaceable();

      if (effectivePlacement.target) {
        const pool = this.#poolSnapshot();
        const targetWorker = pool.find(
          (w) =>
            w.name === effectivePlacement.target ||
            w.instanceUuid === effectivePlacement.target,
        );
        if (targetWorker && !targetWorker.connected) {
          if (affinityKey) {
            throw new WorkerAffinityLostError(
              effectivePlacement.target,
              affinityKey,
            );
          }
          request.onEvent?.({
            kind: "target_disconnected",
            target: effectivePlacement.target,
          });
          logger.warn(
            "Step targets worker {target} which is disconnected " +
              "(within grace window); use workers.connected() to " +
              "filter dispatchable workers",
            { target: effectivePlacement.target },
          );
        }
      }

      while (true) {
        request.signal?.throwIfAborted();
        const scheduled = !(request.skipScheduler && effectivePlacement.target);
        const workerName = scheduled
          ? await observeExecutionWork(
            "dispatch.queue",
            {},
            () =>
              this.#acquireWorker(
                effectivePlacement,
                request.signal,
                deadline,
                emitQueued,
                assertPlaceable,
              ),
          )
          : effectivePlacement.target!;
        attemptWorker = workerName;
        let reservationHeld = scheduled;
        const releaseReservation = () => {
          if (!reservationHeld) return;
          reservationHeld = false;
          const count = this.#reserved.get(workerName) ?? 0;
          if (count <= 1) {
            this.#reserved.delete(workerName);
          } else {
            this.#reserved.set(workerName, count - 1);
          }
        };
        try {
          // built before anything is acquired, so a version 5 load failure
          // fails the step with only the reservation to unwind, not as a lost
          // worker
          const frame = await this.#frameFor(workerName, request);
          const result = await this.#dispatchOnce(
            workerName,
            request,
            frame,
            releaseReservation,
          );
          lastDispatchId = result.dispatchId;
          endQueue({ state: "dispatched", dispatchId: result.dispatchId });
          return result;
        } catch (error) {
          if (error instanceof WorkerLostError) {
            // before the pin binds, no other step of the group ran on the lost
            // worker, so a no-write first step re-dispatches below
            if (affinityKey && (pinnedWorker || error.hadWrites)) {
              endQueue({
                state: "dispatched",
                dispatchId: error.dispatchId ?? "unknown",
              });
              throw withWrittenVersions(
                new WorkerAffinityLostError(workerName, affinityKey),
                writtenVersionsOf(error),
              );
            }
            if (error.hadWrites) {
              endQueue({
                state: "dispatched",
                dispatchId: error.dispatchId ?? "unknown",
              });
              throw withWrittenVersions(
                new Error(
                  `Worker '${workerName}' disconnected after step '${
                    request.stepName ?? request.methodName
                  }' had written data — failing the run (write-then-drop)`,
                ),
                writtenVersionsOf(error),
              );
            }
            logger.warn(
              "Worker {worker} lost a no-write dispatch; re-scheduling",
              { worker: workerName },
            );
            endQueue({
              state: "dispatched",
              dispatchId: error.dispatchId ?? "unknown",
            });
            attemptWorker = undefined;
            continue;
          }
          // the attempt never ran; a probe names one worker with no fallback,
          // so the gateway's refusal fails it
          const refusal = error instanceof WorkerNotDispatchableError
            ? (request.skipScheduler ? null : error.reason)
            : error instanceof RpcError &&
                (error.code === "worker_busy" ||
                  error.code === "worker_draining")
            ? error.code
            : null;
          if (refusal !== null) {
            attemptWorker = undefined;
            assertPlaceable();
            if (
              refusal === "not_in_pool" || refusal === "disconnected" ||
              refusal === "draining" || refusal === "version_changed"
            ) {
              // the scheduler does not offer this worker, so retry it directly
              // rather than wait for a pool change; a re-enrolled worker is
              // offered again and gets a frame built for it
              logger.warn(
                "Worker {worker} was {code} on dispatch; re-scheduling step",
                { worker: workerName, code: refusal },
              );
              endQueue({
                state: "dispatched",
                dispatchId: lastDispatchId ?? "unknown",
              });
              continue;
            }
            const remaining = deadline !== null
              ? deadline - Date.now()
              : WAIT_FOREVER_POLL_CAP_MS;
            if (remaining <= 0) {
              throw new Error(
                `Timed out waiting for a worker matching ${
                  describePlacement(effectivePlacement)
                } to become available`,
              );
            }
            logger.warn(
              "Worker {worker} reported {code} on dispatch; re-queueing step",
              { worker: workerName, code: refusal },
            );
            endQueue({
              state: "dispatched",
              dispatchId: lastDispatchId ?? "unknown",
            });
            await observeExecutionWork(
              "dispatch.queue",
              { "swamp.queue.reason": "worker_refused" },
              () => this.#waitForPoolChange(remaining, request.signal),
            );
            continue;
          }
          throw error;
        } finally {
          releaseReservation();
        }
      }
    } catch (error) {
      failure = error;
      if (currentQueueId !== null) {
        if (
          error instanceof Error &&
          error.message.startsWith("Timed out waiting for a worker")
        ) {
          endQueue({ state: "timed_out" });
        } else {
          endQueue({ state: "cancelled" });
        }
      }
      throw error;
    } finally {
      // The first step of an affinity group settles waiting steps: a
      // lost-worker error fails them naming it, otherwise the group binds to
      // the last worker.
      const key = request.placement.affinityKey;
      if (affinityResolve && affinityReject && key) {
        const held = this.#affinityInflight.get(key) === affinitySlot;
        if (held) this.#affinityInflight.delete(key);
        if (failure instanceof WorkerAffinityLostError) {
          affinityReject(new WorkerAffinityLostError(failure.workerName, key));
        } else if (attemptWorker && held) {
          this.#affinityPins.set(key, attemptWorker);
          affinityResolve(attemptWorker);
        } else {
          affinityResolve(undefined);
        }
      }
      request.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * hands off the step's locks for one attempt and ends the hand-off however
   * the attempt ends, before any retry or write; locks are re-keyed so a retry
   * carries new nonces
   */
  async #dispatchOnce(
    workerName: string,
    request: RemoteStepRequest,
    frame: DispatchFrame,
    onRegistered: () => void,
  ): Promise<RemoteStepResult & { dispatchId: string }> {
    return await observeExecutionWork("dispatch.attempt", {
      "swamp.attempt.id": crypto.randomUUID(),
      "swamp.worker.id": workerName,
    }, () => this.#dispatchObserved(workerName, request, frame, onRegistered));
  }

  async #frameFor(
    workerName: string,
    request: RemoteStepRequest,
  ): Promise<DispatchFrame> {
    const worker = this.#gateway!.worker(workerName);
    // a worker that left the pool after being chosen goes back to the
    // scheduler, as the gateway's own refusal would send it
    if (!worker) {
      throw new WorkerNotDispatchableError(workerName, "not_in_pool");
    }
    const protocolVersion = worker.protocolVersion ?? REMOTE_PROTOCOL_VERSION;
    // placed for this worker's shell on every attempt, since a re-dispatch can
    // choose a worker of another platform
    const place = (args: Pick<DispatchFrame, "globalArgs" | "methodArgs">) =>
      request.placeArguments(args, worker.platform);
    if (shipsReferencesOnly(protocolVersion)) {
      const placed = place(request);
      return {
        protocolVersion,
        globalArgs: placed.globalArgs,
        methodArgs: placed.methodArgs,
        secrets: request.referenceBag
          ? { referenceBag: request.referenceBag }
          : {},
        redactorSeeds: request.redactorSeeds,
      };
    }
    // placed on the sentinel form first, so a refusal comes before the version
    // 5 frame reads any vault value
    place(request);
    const legacy = await request.legacyDelivery?.();
    // a version 5 frame holds values in place of sentinels; the placer refuses
    // one whose data-bearing text does not match
    const placed = place({
      globalArgs: legacy?.globalArgs ?? request.globalArgs,
      methodArgs: legacy?.methodArgs ?? request.methodArgs,
    });
    const unresolvedMethodArgs = legacy?.unresolvedMethodArgs &&
      place({ globalArgs: {}, methodArgs: legacy.unresolvedMethodArgs })
        .methodArgs;
    return {
      protocolVersion,
      globalArgs: placed.globalArgs,
      methodArgs: placed.methodArgs,
      secrets: {
        ...(legacy?.secretValues ? { secretValues: legacy.secretValues } : {}),
        ...(unresolvedMethodArgs ? { unresolvedMethodArgs } : {}),
        ...(legacy?.secretBag ? { secretBag: legacy.secretBag } : {}),
      },
      redactorSeeds: legacy?.secretValues ?? request.redactorSeeds,
    };
  }

  async #dispatchObserved(
    workerName: string,
    request: RemoteStepRequest,
    frame: DispatchFrame,
    onRegistered: () => void,
  ): Promise<RemoteStepResult & { dispatchId: string }> {
    const handOff = await observeExecutionWork(
      "dispatch.lock_handoff",
      {},
      async () => await request.beginLockHandOff?.(),
    );
    let outcome:
      | { ok: true; result: RemoteStepResult & { dispatchId: string } }
      | { ok: false; error: unknown };
    try {
      outcome = {
        ok: true,
        result: await this.#dispatchLent(
          workerName,
          request,
          frame,
          handOff?.lent,
          onRegistered,
        ),
      };
    } catch (error) {
      outcome = { ok: false, error };
    }
    try {
      // a failed attempt has nothing to write, so a cancel ends the wait for a
      // structural command; a succeeded one waits so its result is not
      // discarded
      await observeExecutionWork(
        "dispatch.lock_reclaim",
        {},
        async () => await handOff?.end(outcome.ok ? undefined : request.signal),
      );
    } catch (error) {
      // the locks could not be taken back, so the step must not write; a
      // succeeded attempt fails here even if cancelled meanwhile, else its
      // result would be written
      if (outcome.ok || !request.signal?.aborted) {
        if (!outcome.ok) {
          logger.warn(
            "Dispatch attempt of step {step} ended with {attemptError}, and its locks could not be taken back",
            {
              step: request.stepName ?? request.methodName,
              attemptError: outcome.error instanceof Error
                ? outcome.error.message
                : String(outcome.error),
            },
          );
        }
        throw outcome.ok
          ? error
          : withWrittenVersions(error, writtenVersionsOf(outcome.error));
      }
      // a cancelled attempt that failed writes nothing to the model, so the
      // step stays cancelled rather than failing on a structural command it did
      // not wait out
      logger.warn(
        "Could not take back the locks of cancelled step {step}: {error}",
        {
          step: request.stepName ?? request.methodName,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.result;
  }

  async #dispatchLent(
    workerName: string,
    request: RemoteStepRequest,
    frame: DispatchFrame,
    lockHolder: RemoteLockHolder | undefined,
    onRegistered: () => void,
  ): Promise<RemoteStepResult & { dispatchId: string }> {
    const gateway = this.#gateway!;
    const dispatchId = crypto.randomUUID();
    const leaseId = dispatchId;
    let leaseSettled = false;

    const bundleFingerprint = await observeExecutionWork("dispatch.prepare", {
      "swamp.dispatch.id": dispatchId,
    }, () => this.#ensureBundle(request.modelDef));

    await this.#leaseTransition("acquire", leaseId, (leases) =>
      leases.acquire({
        leaseId,
        dispatchId,
        workerName,
        modelType: request.modelType.normalized,
        modelId: request.modelId,
        methodName: request.methodName,
        workflowName: request.workflowName,
        workflowRunId: request.workflowRunId,
        jobName: request.jobName,
        stepName: request.stepName,
      }));

    if (request.declaredWrites) {
      this.#writesByDispatch.add(dispatchId);
      await this.#leaseTransition(
        "mark_writes",
        leaseId,
        (leases) => leases.markWrites(leaseId),
      );
    }

    this.#options.dispatches.register({
      progress: currentRunProgress(),
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
      tagOverrides: request.tagOverrides,
      dataOutputOverrides: request.dataOutputOverrides,
      dataRepo: request.dataRepo,
      // a workflow step's arguments arrive resolved, so its references come
      // from its secret bag; a direct caller's literal expressions are read
      // from the arguments
      allowedSecrets: withVaultReferences(
        extractVaultReferences(frame.globalArgs, frame.methodArgs),
        request.secretReferences,
      ),
      bagReferences: bagReferenceSet(request.secretReferences),
      redactor: this.#buildDispatchRedactor(frame.redactorSeeds),
      protocolVersion: frame.protocolVersion,
      traceHeaders: request.traceHeaders,
      // the dispatching run's vault scope, so the worker's secret reads and
      // sensitive writes are held to it
      vaultAccess: currentVaultAccess(),
    });

    const params: DispatchParams = {
      dispatchId,
      leaseId,
      execution: {
        protocolVersion: frame.protocolVersion,
        modelType: request.modelType.normalized,
        modelId: request.modelId,
        methodName: request.methodName,
        globalArgs: frame.globalArgs,
        methodArgs: frame.methodArgs,
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
      probeMarker: request.probeMarker,
      ...frame.secrets,
      // copied only to drop `readonly` for the schema's inferred type
      lockHolder: lockHolder
        ? { ...lockHolder, lockIds: [...lockHolder.lockIds] }
        : undefined,
    };

    // a v6 worker parse event stands for serve parse on v5: calls the hook at
    // most once, before the result, never forwarded. A failing hook must not
    // fail a step whose method ran, or a retry reruns it.
    let validation: Promise<void> | undefined;
    let resultArrived = false;
    const referencesOnly = shipsReferencesOnly(frame.protocolVersion);
    // read per line so it holds every value the load route and resolveSecret
    // served so far; a v6 run's own redactor never sees them, so this is the
    // scrub after the worker's own
    const dispatchRedactor = () => {
      const redactor = this.#options.dispatches.forDispatch(
        workerName,
        dispatchId,
      )?.redactor;
      return redactor?.hasSecrets ? redactor : undefined;
    };
    const onEvent = (event: RpcStreamEvent) => {
      if (event.kind === ARGUMENTS_VALIDATED_EVENT) {
        if (referencesOnly && !resultArrived && validation === undefined) {
          validation = Promise.resolve()
            .then(() => request.onArgumentsValidated?.())
            .catch((error: unknown) => {
              const message = error instanceof Error
                ? error.message
                : String(error);
              logger.warn(
                "Recording the validated arguments of {dispatchId} failed: {error}",
                {
                  dispatchId,
                  error: dispatchRedactor()?.redact(message) ?? message,
                },
              );
            });
        }
        return;
      }
      const redactor = dispatchRedactor();
      request.onEvent?.(
        redactor && event.kind === "method_event"
          ? scrubbedOutputEvent(event, redactor)
          : event,
      );
    };

    try {
      const result = await observeExecutionWork("dispatch.send", {
        "swamp.dispatch.id": dispatchId,
        "swamp.lease.id": leaseId,
        "swamp.worker.id": workerName,
      }, (observation) => {
        const traceHeaders = observation.carrier
          ? { ...observation.carrier }
          : request.traceHeaders;
        params.execution.traceHeaders = traceHeaders;
        const registration = this.#options.dispatches.forDispatch(
          workerName,
          dispatchId,
        );
        if (registration) registration.traceHeaders = traceHeaders;
        return gateway.dispatch(workerName, params, {
          signal: request.signal,
          onEvent,
          onRegistered,
        });
      });
      resultArrived = true;
      await validation;
      // console output travels in the result, not the stream: forward it as
      // output on success or failure, all as stdout since the capture does not
      // record the method. A throwing listener must not fail the dispatch.
      for (const line of result.logs) {
        try {
          request.onEvent?.({
            kind: "method_event",
            event: {
              type: "output",
              line: dispatchRedactor()?.redact(line) ?? line,
              stream: "stdout",
              level: "info",
            },
          });
        } catch (error) {
          logger.warn(
            "Forwarding console output of {dispatchId} failed: {error}",
            {
              dispatchId,
              error: error instanceof Error ? error.message : String(error),
            },
          );
          break;
        }
      }
      if (result.status === "error") {
        // Scrub the worker's result error again with the registration's
        // redactor, which also holds values resolveSecret delivered
        // mid-dispatch.
        const redactor = this.#options.dispatches.forDispatch(
          workerName,
          dispatchId,
        )?.redactor;
        const scrub = (text: string) => redactor?.redact(text) ?? text;
        leaseSettled = true;
        await this.#endLease(
          leaseId,
          "failed",
          scrub(result.error ?? "remote execution failed"),
        );
        // a coded UserError the worker's method threw comes back as one, its
        // code scrubbed like the message
        const message = scrub(result.error ?? "Remote execution failed");
        throw withRemoteOutputs(
          markErrorPaths(
            result.errorCode !== undefined
              ? new UserError(message, scrub(result.errorCode))
              : new Error(message),
            result.errorPaths ?? [],
          ),
          result.outputs,
        );
      }
      leaseSettled = true;
      await observeExecutionWork(
        "dispatch.settle",
        {
          "swamp.dispatch.id": dispatchId,
          "swamp.lease.id": leaseId,
        },
        () => this.#endLease(leaseId, "completed"),
        dispatchTraceCarrier(params.execution.traceHeaders, result.trace),
      );
      return {
        outputs: result.outputs,
        logs: result.logs,
        durationMs: result.durationMs,
        workerName,
        dispatchId,
      };
    } catch (dispatchError) {
      resultArrived = true;
      await validation;
      // every way out throws; the versions the dispatch wrote go with the
      // error, read before the finally releases the dispatch
      let failure: unknown;
      try {
        failure = await this.#failedDispatchError(
          dispatchError,
          workerName,
          dispatchId,
          leaseId,
          leaseSettled,
          request,
        );
      } catch (error) {
        failure = error;
      }
      const versions = await this.#writtenVersionsOf?.(dispatchId) ?? [];
      throw withWrittenVersions(failure, versions);
    } finally {
      this.#options.dispatches.unregister(workerName, dispatchId);
      this.#writesByDispatch.delete(dispatchId);
      this.#onDispatchEnd?.(dispatchId);
    }
  }

  async #failedDispatchError(
    error: unknown,
    workerName: string,
    dispatchId: string,
    leaseId: string,
    leaseSettled: boolean,
    request: RemoteStepRequest,
  ): Promise<unknown> {
    if (
      (error instanceof RpcError && error.code === "cancelled") ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      await this.#endLease(leaseId, "failed", "dispatch cancelled");
      return new DOMException(
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
        await this.#endLease(
          leaseId,
          "failed",
          "worker disconnected after writing (write-then-drop)",
        );
      } else {
        await this.#endLease(
          leaseId,
          "expired",
          `worker ${
            fate === "reconnected" ? "reconnected after drop" : "lost"
          }; no writes had occurred`,
        );
      }
      return new WorkerLostError(workerName, hadWrites, dispatchId);
    }
    // anything else is an abandoned attempt, not a method failure: end the
    // lease so it cannot leak as active, then let executeRemote decide
    if (!leaseSettled) {
      await this.#endLease(
        leaseId,
        "expired",
        error instanceof Error ? error.message : String(error),
      ).catch(() => {});
    }
    return error;
  }

  async #acquireWorker(
    placement: StepPlacement,
    signal: AbortSignal | undefined,
    deadline: number | null,
    onQueued?: () => void,
    assertPlaceable?: () => void,
  ): Promise<string> {
    while (true) {
      signal?.throwIfAborted();
      assertPlaceable?.();
      const decision: ScheduleDecision = scheduleStep(
        placement,
        this.#poolSnapshot(),
      );
      if (decision.kind === "dispatch") {
        const current = this.#reserved.get(decision.worker.name) ?? 0;
        this.#reserved.set(decision.worker.name, current + 1);
        return decision.worker.name;
      }
      onQueued?.();
      if (deadline !== null) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(
            `Timed out waiting for a worker matching ${
              describePlacement(placement)
            } to become available`,
          );
        }
        await this.#waitForPoolChange(remaining, signal);
      } else {
        await this.#waitForPoolChange(WAIT_FOREVER_POLL_CAP_MS, signal);
      }
    }
  }

  /**
   * pass the gateway's own snapshot: the reservation overlay reports a full
   * draining worker as busy
   */
  #pinnedWorkerLost(worker: WorkerSnapshot): boolean {
    return !worker.connected || worker.status === "draining";
  }

  /** reservations cover only dispatches the gateway has not registered yet */
  #poolSnapshot(): WorkerSnapshot[] {
    return this.#gateway!.workers().map((worker) => {
      const reservations = this.#reserved.get(worker.name) ?? 0;
      if (reservations === 0) return worker;
      const virtualIds = [
        ...worker.activeDispatchIds,
        ...Array.from({ length: reservations }, (_, i) => `__reserved_${i}`),
      ];
      return {
        ...worker,
        activeDispatchIds: virtualIds,
        status: virtualIds.length >= worker.capacity
          ? "busy" as const
          : worker.status,
      };
    });
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

  /**
   * the declared list and assets are read at each dispatch so a change ships
   * under a new fingerprint; recorded hashes let the data plane refuse bytes
   * changed since
   */
  async #ensureBundle(modelDef: ModelDefinition): Promise<string> {
    if (!modelDef.bundleSourceFactory) {
      // built-in model: the worker's own binary carries it; enrollment already
      // guaranteed version lockstep
      return `${BUILTIN_BUNDLE_PREFIX}${modelDef.type.normalized}`;
    }
    const js = await modelDef.bundleSourceFactory();
    const filesRoot = modelDef.extensionFilesRoot;
    const declared = await modelDef.readExtensionDeclaredAssets?.();
    const additionalFiles = declared?.additionalFiles;
    const binaries = declared?.binaries;
    if (
      !filesRoot || (!additionalFiles?.length && !binaries?.length)
    ) {
      const fingerprint = await sha256Hex(js);
      this.#options.bundles.register(fingerprint, {
        js,
        filesRoot,
        additionalFiles,
        binaries,
      });
      return fingerprint;
    }
    const binarySet = new Set(binaries);
    const realRoot = await Deno.realPath(filesRoot).catch(() => undefined);
    const assetHashes = new Map<string, string>();
    const refused: WithheldAsset[] = [];
    // additionalFiles keep the relPath:hash part so a bundle without binaries
    // keeps its fingerprint; bin: makes moving a file between fields a new one
    const parts: string[] = [js];
    const declaredPaths = new Set([...additionalFiles ?? [], ...binarySet]);
    for (const relPath of [...declaredPaths].sort()) {
      const isBinary = binarySet.has(relPath);
      const part = isBinary ? `bin:${relPath}` : relPath;
      const asset = await readShippableAsset(filesRoot, realRoot, relPath);
      if (typeof asset === "string") {
        parts.push(`${part}:missing`);
        refused.push({
          relPath,
          field: isBinary ? "binaries" : "additionalFiles",
          reason: asset,
        });
        continue;
      }
      const hash = await hashAssetBytes(asset);
      assetHashes.set(relPath, hash);
      parts.push(`${part}:${hash}`);
    }
    const fingerprint = await sha256Hex(parts.join("\0"));
    if (this.#options.bundles.get(fingerprint) === null) {
      for (const { relPath, field, reason } of refused) {
        logger.warn(
          "Asset {relPath} declared in {field} of {type} is {reason}; " +
            "it is not shipped to workers",
          { relPath, field, reason, type: modelDef.type.normalized },
        );
      }
    }
    this.#options.bundles.register(fingerprint, {
      js,
      filesRoot,
      additionalFiles,
      binaries,
      assetHashes,
      withheld: refused,
    });
    return fingerprint;
  }

  #pendingTransition(
    methodName: string,
    queueId: string,
    transition: (pending: PendingDispatchStore) => Promise<void>,
  ): void {
    // control-plane bookkeeping chained from inside the dispatching run must
    // not be held to that run's vault scope
    const run = () =>
      withoutVaultAccess(() => transition(this.#pendingDispatches));
    // ordered per queue entry: each is its own record
    this.#transitions.run(
      `pending_dispatch.${methodName}`,
      run,
      `pending:${queueId}`,
    ).catch(() => {});
  }

  #leaseTransition(
    methodName: string,
    leaseId: string,
    transition: (leases: StepLeaseStore) => Promise<void>,
  ): Promise<void> {
    // control-plane bookkeeping chained from inside the dispatching run must
    // not be held to that run's vault scope
    const run = () => withoutVaultAccess(() => transition(this.#stepLeases));
    return this.#transitions.run(
      `step_lease.${methodName}`,
      run,
      `lease:${leaseId}`,
    );
  }

  #endLease(
    leaseId: string,
    state: EndedLeaseState,
    error?: string,
  ): Promise<void> {
    return this.#leaseTransition(
      LEASE_END_METHODS[state],
      leaseId,
      (leases) => leases.end(leaseId, state, error),
    );
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
      { definitionType: ModelType.create(input.typeArg) },
    );
    const libCtx = createLibSwampContext({
      openUnitOfWork: repoUnitOfWorkFactory(this.#options.repoContext),
    });
    // control-plane bookkeeping is never held to the dispatching run's vault
    // scope
    for await (
      const event of runGeneratorWithoutVaultAccess(() =>
        modelMethodRun(libCtx, deps, {
          modelIdOrName: input.definitionName,
          methodName: input.methodName,
          inputs: input.inputs,
          lastEvaluated: false,
          typeArg: input.typeArg,
          definitionName: input.definitionName,
          // skip per-run report artifacts so pool churn stays bounded to the
          // state records
          skipAllReports: true,
        })
      )
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

export class WorkerAffinityLostError extends Error {
  readonly workerName: string;
  readonly affinityKey: string;

  constructor(workerName: string, affinityKey: string) {
    super(
      `Worker '${workerName}' required by affinity group '${affinityKey}' ` +
        `is no longer connected — failing step to preserve co-location guarantee`,
    );
    this.name = "WorkerAffinityLostError";
    this.workerName = workerName;
    this.affinityKey = affinityKey;
  }
}

export class AffinityPlacementMismatchError extends Error {
  readonly workerName: string;
  readonly affinityKey: string;
  readonly unmet: string;

  constructor(workerName: string, affinityKey: string, unmet: string) {
    super(
      `Worker '${workerName}' pinned by affinity group '${affinityKey}' ` +
        `does not meet this step's placement (${unmet}) — failing step ` +
        `rather than running it on a worker it does not match`,
    );
    this.name = "AffinityPlacementMismatchError";
    this.workerName = workerName;
    this.affinityKey = affinityKey;
    this.unmet = unmet;
  }
}

export class WorkerIneligibleError extends Error {
  readonly code = "worker_ineligible";
  readonly workerName: string;
  readonly reason: "unverified" | "draining";

  constructor(workerName: string, reason: "unverified" | "draining") {
    super(
      `Worker '${workerName}' is ${reason} and can no longer take its fan-out lane (worker_ineligible); the lane is not sent`,
    );
    this.name = "WorkerIneligibleError";
    this.workerName = workerName;
    this.reason = reason;
  }
}

export class WorkerLostError extends Error {
  readonly workerName: string;
  readonly hadWrites: boolean;
  readonly dispatchId: string;

  constructor(workerName: string, hadWrites: boolean, dispatchId: string) {
    super(
      `Worker '${workerName}' disconnected mid-dispatch (writes: ${hadWrites})`,
    );
    this.name = "WorkerLostError";
    this.workerName = workerName;
    this.hadWrites = hadWrites;
    this.dispatchId = dispatchId;
  }
}
