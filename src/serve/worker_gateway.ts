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

import { runGeneratorWithoutVaultAccess } from "../domain/vaults/run_vault_access.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import { repoUnitOfWorkFactory } from "../infrastructure/persistence/repo_unit_of_work.ts";
import { createLibSwampContext } from "../libswamp/context.ts";
import { createWorkerModelRunDeps } from "../libswamp/worker/run_deps.ts";
import { ModelType } from "../domain/models/model_type.ts";
import { modelMethodRun } from "../libswamp/models/run.ts";
import {
  ChannelClosedError,
  RpcChannel,
  RpcError,
} from "../domain/remote/rpc_channel.ts";
import type { RpcTransport } from "../domain/remote/rpc_channel.ts";
import {
  type DispatchParams,
  type DispatchResult,
  DispatchResultSchema,
  EnrollParamsSchema,
  type EnrollResult,
  GATE_PASS_UNAVAILABLE,
  isSupportedRemoteProtocolVersion,
  REMOTE_PROTOCOL_VERSION,
  RemoteMethod,
  type RpcStreamEvent,
  type SessionRefreshResult,
  shipsReferencesOnly,
  SUPPORTED_REMOTE_PROTOCOL_VERSIONS,
  withoutQuotedNames,
  WorkerMethod,
} from "../domain/remote/protocol.ts";
import { SessionCredentialService } from "../domain/remote/session_credential.ts";
import {
  WORKER_MODEL_TYPE,
  workerDefinitionName,
} from "../domain/models/worker/worker_model.ts";
import {
  ENROLLMENT_TOKEN_MODEL_TYPE,
  type EnrollmentBindingCutoffCause,
  type EnrollmentToken,
  EnrollmentTokenSchema,
  type MaxEnrollments,
} from "../domain/models/worker/enrollment_token_model.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  type ObservationAttributes,
  observeExecutionWork,
} from "../domain/remote/observability.ts";
import { runDetached } from "../infrastructure/tracing/tracer.ts";
import {
  observeDiagnosticPhase,
  type PhaseTally,
  withDiagnosticArea,
} from "../domain/diagnostics/diagnostic_phase.ts";
import { isUnreadableContentError } from "../domain/datastore/unreadable_content.ts";
import { TransitionTail } from "./transition_tail.ts";
import {
  methodRunnerWorkerStatusStore,
  WorkerStatusLedger,
  type WorkerStatusStore,
} from "./worker_status_ledger.ts";
import { parseUntrustedOrThrow } from "../domain/untrusted_parse.ts";
import { SERVE_NOT_LEADER_CODE } from "../domain/datastore_v3/serve_leader.ts";

const logger = getSwampLogger(["serve", "worker-gateway"]);

export const DEFAULT_GRACE_WINDOW_MS = 60_000;

const TOKEN_DATA_NAME = "token-main";

/**
 * unmatched redeem rejections are rethrown as is and reach the worker as a
 * retryable handler_failed
 */
const REDEEM_FAILURE_CODES: readonly [string, string][] = [
  ["has been revoked", "token_revoked"],
  ["has expired", "token_expired"],
  ["does not match", "token_mismatch"],
  ["does not exist", "token_not_found"],
  ["allowance exhausted", "enrollment_allowance_exhausted"],
];

function codedRedeemFailure(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const reason = withoutQuotedNames(error.message);
  for (const [phrase, code] of REDEEM_FAILURE_CODES) {
    if (reason.includes(phrase)) {
      return new RpcError({ code, message: error.message });
    }
  }
  return error;
}

const CUTOFF_REASONS: Record<EnrollmentBindingCutoffCause, string> = {
  revoked: "revoked",
  reminted: "re-minted",
  deleted: "deleted",
};

/** setTimeout overflows past 2^31-1 ms; longer waits are chained. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export function splitEnrollmentToken(
  presented: string,
): { name: string; secret: string } | null {
  const dot = presented.indexOf(".");
  if (dot <= 0 || dot === presented.length - 1) {
    return null;
  }
  return { name: presented.slice(0, dot), secret: presented.slice(dot + 1) };
}

/**
 * 8 hex chars from a machineId hash give each fleet member a distinct worker
 * name; 4 bytes make collisions negligible for any practical fleet size
 */
export async function fleetMemberSuffix(machineId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(machineId),
  );
  return Array.from(new Uint8Array(digest))
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface WorkerSnapshot {
  name: string;
  instanceUuid: string;
  labels: Record<string, string>;
  platform: string;
  arch: string;
  swampVersion: string;
  protocolVersion: number;
  status: "idle" | "busy" | "unverified" | "draining";
  connected: boolean;
  capacity: number;
  activeDispatchIds: string[];
  verifyFailureReason?: string;
}

interface WorkerEntry {
  name: string;
  tokenName: string;
  /**
   * The token mint (`createdAt`) this worker enrolled on. Re-minting a
   * revoked name yields a new mint.
   */
  tokenCreatedAt: string;
  instanceUuid: string;
  labels: Record<string, string>;
  platform: string;
  arch: string;
  swampVersion: string;
  protocolVersion: number;
  channel: RpcChannel | null;
  closeSocket: (() => void) | null;
  status: "idle" | "busy" | "unverified" | "draining";
  capacity: number;
  activeDispatchIds: string[];
  verifyFailureReason?: string;
  verifying?: boolean;
  verifyAgain?: boolean;
  /**
   * A probe was refused for want of a slot while the unverified worker's
   * enrollment verification was running. The next dispatch to end with no
   * slots held probes it again.
   */
  probeRefusedForCapacity?: boolean;
  graceTimer?: ReturnType<typeof setTimeout>;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

export type ModelMethodRunner = (input: {
  typeArg: string;
  definitionName: string;
  methodName: string;
  inputs: Record<string, unknown>;
  /**
   * The id of the definition the caller resolved. When set, the run is
   * refused rather than auto-creating a definition if the name no longer
   * resolves to that id.
   */
  expectedDefinitionId?: string;
}) => Promise<void>;

export type WorkerNotDispatchableReason =
  | "not_in_pool"
  | "disconnected"
  | "at_capacity"
  | "unverified"
  | "draining"
  | "version_changed";

const NOT_DISPATCHABLE_PHRASES: Record<WorkerNotDispatchableReason, string> = {
  not_in_pool: "is not in the pool",
  disconnected: "is disconnected",
  at_capacity: "is at capacity",
  unverified: "is unverified",
  draining: "is draining",
  version_changed:
    "re-enrolled at another protocol version than its dispatch was built for",
};

/**
 * The gateway refused a dispatch before sending it: the attempt never
 * reached the worker, so nothing ran and nothing was written.
 */
export class WorkerNotDispatchableError extends Error {
  readonly workerName: string;
  readonly reason: WorkerNotDispatchableReason;

  constructor(workerName: string, reason: WorkerNotDispatchableReason) {
    super(`Worker '${workerName}' ${NOT_DISPATCHABLE_PHRASES[reason]}`);
    this.name = "WorkerNotDispatchableError";
    this.workerName = workerName;
    this.reason = reason;
  }
}

export interface WorkerGatewayOptions {
  /**
   * whether this serve node takes workers: false on a team-mode follower. A
   * refused worker retries and reaches the leader or this node once it leads.
   * Absent, every node takes them.
   */
  acceptsWorkers?: () => boolean;
  repoDir: string;
  repoContext: RepositoryContext;
  capabilityService: {
    registerHandlers(channel: RpcChannel, workerName: string): void;
  };
  sessionCredentials?: SessionCredentialService;
  graceWindowMs?: number;
  swampVersion?: string;
  onWorkerIdle?: (worker: WorkerSnapshot) => void;
  onWorkerDisconnected?: (worker: WorkerSnapshot) => void;
  onGraceExpired?: (worker: WorkerSnapshot) => void;
  onWorkerEnrolled?: (worker: WorkerSnapshot) => void;
  onWorkerDraining?: (worker: WorkerSnapshot) => void;
  /**
   * A worker was removed from the pool because its enrollment token lost
   * its authority (revoked, expired, re-minted, or deleted). Unlike a
   * socket drop there is no grace window: the worker cannot re-enroll.
   */
  onWorkerRemoved?: (worker: WorkerSnapshot) => void;
  verifyOnEnroll?: boolean;
  verifyWorker?: (
    workerName: string,
  ) => Promise<{ ok: boolean; failureReason?: string }>;
  gatePass?: () => string | undefined;
  runModelMethod?: ModelMethodRunner;
  findTokenDefinitionId?: (tokenName: string) => Promise<string | null>;
  readTokenRecord?: (tokenName: string) => Promise<EnrollmentToken | null>;
  readTokenExpiresAt?: (
    tokenName: string,
    record: EnrollmentToken,
  ) => Promise<string | null>;
  readTokenMaxEnrollments?: (
    tokenName: string,
    record: EnrollmentToken,
  ) => Promise<MaxEnrollments | null>;
}

interface SocketState {
  channel: RpcChannel;
  closeSocket: (() => void) | null;
  workerName: string | null;
}

export class WorkerGateway {
  readonly #options: WorkerGatewayOptions;
  readonly #workers = new Map<string, WorkerEntry>();
  readonly #sessions: SessionCredentialService;
  readonly #graceWindowMs: number;
  readonly #runModelMethod: ModelMethodRunner;
  readonly #workerStatus: WorkerStatusStore;
  readonly #findTokenDefinitionId: (
    tokenName: string,
  ) => Promise<string | null>;
  readonly #readTokenExpiresAt: (
    tokenName: string,
    record: EnrollmentToken,
  ) => Promise<string | null>;
  readonly #readTokenMaxEnrollments: (
    tokenName: string,
    record: EnrollmentToken,
  ) => Promise<MaxEnrollments | null>;
  readonly #readTokenRecord: (
    tokenName: string,
  ) => Promise<EnrollmentToken | null>;
  /** Serializes every token/worker/lease transition (sole-writer rule). */
  readonly #transitions = new TransitionTail("gateway");

  constructor(options: WorkerGatewayOptions) {
    this.#options = options;
    this.#sessions = options.sessionCredentials ??
      new SessionCredentialService();
    this.#graceWindowMs = options.graceWindowMs ?? DEFAULT_GRACE_WINDOW_MS;
    this.#runModelMethod = options.runModelMethod ??
      ((input) => this.#defaultRunModelMethod(input));
    this.#workerStatus = options.runModelMethod
      ? methodRunnerWorkerStatusStore(options.runModelMethod)
      : new WorkerStatusLedger(
        options.repoContext,
        methodRunnerWorkerStatusStore(this.#runModelMethod),
      );
    this.#findTokenDefinitionId = options.findTokenDefinitionId ??
      (async (tokenName) =>
        (await options.repoContext.definitionRepo.findByName(
          ENROLLMENT_TOKEN_MODEL_TYPE,
          tokenName,
        ))?.id ?? null);
    this.#readTokenExpiresAt = options.readTokenExpiresAt ??
      ((_tokenName, record) => Promise.resolve(record.expiresAt));
    this.#readTokenMaxEnrollments = options.readTokenMaxEnrollments ??
      ((_tokenName, record) => Promise.resolve(record.maxEnrollments));
    this.#readTokenRecord = options.readTokenRecord ??
      ((tokenName) => this.#findTokenRecord(tokenName));
  }

  get sessions(): SessionCredentialService {
    return this.#sessions;
  }

  dispose(): void {
    this.#sessions.dispose();
  }

  /**
   * resolves once every queued transition settles, including ones queued while
   * waiting; a test awaits it after closing sockets so the recorded disconnects
   * land before the repo is removed
   */
  async settled(): Promise<void> {
    await this.#transitions.settled();
  }

  /**
   * the caller must call closed() from the socket close handler; close lets the
   * gateway force-disconnect the socket (token expiry) and must still surface
   * through that handler
   */
  attachTransport(transport: RpcTransport, close?: () => void): {
    feed: (raw: string) => boolean;
    closed: () => void;
  } {
    const state: SocketState = {
      channel: new RpcChannel(transport),
      closeSocket: close ?? null,
      workerName: null,
    };
    state.channel.register(
      RemoteMethod.enroll,
      (params, ctx) =>
        runDetached(() =>
          observeExecutionWork("enrollment.request", {
            "swamp.rpc.request_id": ctx.requestId,
          }, async (observation) => {
            // Authentication is server-owned; only an accepted peer may link
            // its context into the enrollment trace.
            ctx.responseTrace = observation.carrier;
            // Records when and how this process saw the call cancelled; starts
            // false so a query can tell uncancelled from a build without the
            // field.
            const started = performance.now();
            const setRequestAttributes = (values: ObservationAttributes) => {
              try {
                observation.attributes(values);
              } catch {
                // Dropped: see above.
              }
            };
            setRequestAttributes({ "swamp.rpc.cancel_observed": false });
            const onCancel = () =>
              setRequestAttributes({
                "swamp.rpc.cancel_observed": true,
                "swamp.rpc.cancel_observed_ms": performance.now() - started,
                "swamp.rpc.cancel_cause": state.channel.closed
                  ? "channel_closed"
                  : "cancel_frame",
              });
            if (ctx.signal.aborted) onCancel();
            else ctx.signal.addEventListener("abort", onCancel, { once: true });
            let result: EnrollResult;
            try {
              result = await this.#handleEnroll(state, params, ctx.signal);
            } finally {
              ctx.signal.removeEventListener("abort", onCancel);
            }
            return await observeExecutionWork(
              "enrollment.accepted",
              {},
              () => Promise.resolve(result),
              undefined,
              ctx.trace ? [ctx.trace] : undefined,
            );
          })
        ),
    );
    return {
      feed: (raw) => state.channel.handleRaw(raw),
      closed: () => this.#handleSocketClosed(state),
    };
  }

  workers(): WorkerSnapshot[] {
    return [...this.#workers.values()].map((entry) => this.#snapshot(entry));
  }

  worker(name: string): WorkerSnapshot | null {
    const entry = this.#workers.get(name);
    return entry ? this.#snapshot(entry) : null;
  }

  readTokenRecords(): Promise<Map<string, EnrollmentToken>> {
    return this.#scanTokenRecords();
  }

  boundTokens(): { tokenName: string; tokenCreatedAt: string }[] {
    const seen = new Map<
      string,
      { tokenName: string; tokenCreatedAt: string }
    >();
    for (const entry of this.#workers.values()) {
      const key = JSON.stringify([entry.tokenName, entry.tokenCreatedAt]);
      if (!seen.has(key)) {
        seen.set(key, {
          tokenName: entry.tokenName,
          tokenCreatedAt: entry.tokenCreatedAt,
        });
      }
    }
    return [...seen.values()];
  }

  /**
   * cuts off every pool member on tokenName, or only one mint so newer-mint
   * workers keep their connection; runs on the transition tail so an enrollment
   * in progress lands first and is cut off too
   */
  async revokeToken(
    tokenName: string,
    cause: EnrollmentBindingCutoffCause,
    options?: { mint: string },
  ): Promise<string[]> {
    return await this.#recordTransition("revoke_token", async () => {
      const removed: string[] = [];
      for (const entry of [...this.#workers.values()]) {
        if (entry.tokenName !== tokenName) continue;
        if (options !== undefined && entry.tokenCreatedAt !== options.mint) {
          continue;
        }
        logger.info("Enrollment token for {worker} {cause} — disconnecting", {
          worker: entry.name,
          cause: CUTOFF_REASONS[cause],
        });
        const wasConnected = entry.channel !== null;
        this.#removeWorker(entry, `enrollment token ${CUTOFF_REASONS[cause]}`);
        removed.push(entry.name);
        if (wasConnected) {
          // Already on the transition tail, so written in place.
          await this.#recordDisconnected(entry.name);
        }
      }
      return removed;
    });
  }

  /**
   * an unverified worker takes a probe without leaving unverified; only
   * enrollment verification promotes it. The caller owns grace-window failure
   * semantics (see DispatchService).
   */
  async dispatch(
    name: string,
    params: DispatchParams,
    options?: {
      signal?: AbortSignal;
      onEvent?: (event: RpcStreamEvent) => void;
      onRegistered?: () => void;
    },
  ): Promise<DispatchResult> {
    const entry = this.#workers.get(name);
    if (!entry) {
      throw new WorkerNotDispatchableError(name, "not_in_pool");
    }
    if (entry.channel === null) {
      throw new WorkerNotDispatchableError(name, "disconnected");
    }
    // a re-enrolled process may speak another version than the frame was built
    // for: a v5 worker would run reference-only sentinels as values, and
    // plaintext must never reach a worker that loads its own
    if (entry.protocolVersion !== params.execution.protocolVersion) {
      throw new WorkerNotDispatchableError(name, "version_changed");
    }
    if (entry.activeDispatchIds.length >= entry.capacity) {
      if (
        entry.status === "unverified" && entry.verifying && params.probeMarker
      ) {
        entry.probeRefusedForCapacity = true;
      }
      throw new WorkerNotDispatchableError(name, "at_capacity");
    }
    if (entry.status === "unverified" && !params.probeMarker) {
      throw new WorkerNotDispatchableError(name, "unverified");
    }
    if (entry.status === "draining") {
      throw new WorkerNotDispatchableError(name, "draining");
    }

    logger.info(
      "Dispatching {modelType}.{methodName} (step {step}) to worker {worker} [{dispatchId}]",
      {
        modelType: params.execution.modelType,
        methodName: params.execution.methodName,
        step: params.step?.stepName ?? "-",
        worker: name,
        dispatchId: params.dispatchId,
      },
    );
    const dispatchStart = performance.now();
    entry.activeDispatchIds.push(params.dispatchId);
    // an unverified worker is only sent a probe not yet judged: it holds a slot
    // but stays unverified so the scheduler never sees it idle in between
    const unverified = entry.status === "unverified";
    if (!unverified) {
      entry.status = "busy";
    }
    // the slot is taken from here on, so everything below runs under the
    // finally that gives it back: a dispatch failing before it reaches the
    // worker must not keep the slot
    try {
      // Kept in the same synchronous turn as the push: the dispatcher drops
      // its reservation here, and an await in between would count the
      // dispatch twice.
      options?.onRegistered?.();
      if (!unverified) {
        await this.#recordTransition(
          "worker_busy",
          () =>
            this.#workerStatus.recordStatus(name, {
              status: "busy",
              activeDispatchIds: [...entry.activeDispatchIds],
            }),
        );
      }

      const dispatchCredential = this.#sessions.issueForDispatch(
        name,
        params.dispatchId,
      );

      // The worker may have been removed (token revoked or expired) or
      // dropped while the dispatch was being registered.
      const channel = entry.channel;
      if (channel === null || channel.closed) {
        throw new ChannelClosedError(
          `Worker '${name}' disconnected before dispatch`,
        );
      }
      const dispatchParams = {
        ...params,
        dispatchCredential: dispatchCredential.credential,
      };
      const raw = await channel.call(
        WorkerMethod.dispatch,
        dispatchParams,
        {
          timeoutMs: null,
          signal: options?.signal,
          onStream: options?.onEvent,
          waitForPeerOnCancel: true,
        },
      );
      const result = parseUntrustedOrThrow(DispatchResultSchema, raw);
      logger.info(
        "Dispatch {dispatchId} on worker {worker} {status} in {durationMs}ms",
        {
          dispatchId: params.dispatchId,
          worker: name,
          status: result.status === "success" ? "succeeded" : "failed",
          durationMs: Math.round(performance.now() - dispatchStart),
        },
      );
      return result;
    } finally {
      entry.activeDispatchIds = entry.activeDispatchIds.filter(
        (id) => id !== params.dispatchId,
      );
      this.#sessions.revokeDispatch(name, params.dispatchId);
      const currentStatus = entry.status as string;
      // Neither status is left by a dispatch ending: a draining worker is on
      // its way out, and an unverified one waits on its enrollment probe.
      const settled = currentStatus === "draining" ||
        currentStatus === "unverified";
      if (entry.channel === null || entry.channel.closed) {
        if (!settled && entry.activeDispatchIds.length === 0) {
          entry.status = "idle";
        }
      } else if (!settled) {
        if (entry.activeDispatchIds.length === 0) {
          entry.status = "idle";
          await this.#recordTransition(
            "worker_idle",
            () => this.#workerStatus.recordStatus(name, { status: "idle" }),
          ).catch((error: unknown) => {
            logger.warn("Failed to record idle status for {worker}: {error}", {
              worker: name,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        } else {
          await this.#recordTransition(
            "worker_busy",
            () =>
              this.#workerStatus.recordStatus(name, {
                status: "busy",
                activeDispatchIds: [...entry.activeDispatchIds],
              }),
          ).catch((error: unknown) => {
            logger.warn(
              "Failed to record dispatch-end status for {worker}: {error}",
              {
                worker: name,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          });
        }
        this.#options.onWorkerIdle?.(this.#snapshot(entry));
      }
      // an unverified worker's enrollment probe can be refused for want of a
      // slot; when the last slot frees, probe again whichever socket that
      // dispatch used, as nothing else would
      if (
        currentStatus === "unverified" && entry.probeRefusedForCapacity &&
        entry.activeDispatchIds.length === 0 &&
        entry.channel !== null && !entry.channel.closed &&
        this.#options.verifyWorker
      ) {
        this.#startEnrollmentVerify(name);
      }
    }
  }

  get pendingGraceWindows(): number {
    return [...this.#workers.values()].filter((w) => w.graceTimer !== undefined)
      .length;
  }

  async #handleEnroll(
    state: SocketState,
    rawParams: unknown,
    signal: AbortSignal,
  ): Promise<EnrollResult> {
    const params = parseUntrustedOrThrow(EnrollParamsSchema, rawParams);

    if (!isSupportedRemoteProtocolVersion(params.protocolVersion)) {
      throw new RpcError({
        code: "protocol_mismatch",
        message:
          `Worker protocol version ${params.protocolVersion} does not match orchestrator version ${REMOTE_PROTOCOL_VERSION} (supported: ${
            SUPPORTED_REMOTE_PROTOCOL_VERSIONS.join(", ")
          })`,
      });
    }

    const split = splitEnrollmentToken(params.token);
    if (split === null) {
      throw new RpcError({
        code: "invalid_token",
        message: "Enrollment token must have the form '<name>.<secret>'",
      });
    }
    const { name, secret } = split;

    // before the token is redeemed, so a refused worker spends no enrollment;
    // the reply names no leader because the token is not checked yet
    if (this.#options.acceptsWorkers?.() === false) {
      throw new RpcError({
        code: SERVE_NOT_LEADER_CODE,
        message:
          "This serve node does not lead the datastore, so it takes no workers; the worker retries",
      });
    }

    // only a worker that asks gets the pass, read once so refusal and reply
    // agree; a worker needing a pass is refused before token redemption so it
    // spends no enrollment
    const gatePass = params.needsGatePass
      ? this.#options.gatePass?.()
      : undefined;
    if (params.needsGatePass && gatePass === undefined) {
      throw new RpcError({
        code: GATE_PASS_UNAVAILABLE,
        message:
          "This orchestrator has no auth gate pass to give a worker without a credential",
      });
    }

    // Preparation runs as the enrollment diagnostic area; the rest of the
    // transition arms timers and starts work that must not carry it.
    const preparing = <T>(fn: () => Promise<T>) =>
      withDiagnosticArea("enrollment", fn, signal);
    const runPreparing = (input: Parameters<ModelMethodRunner>[0]) =>
      preparing(() => this.#runModelMethod(input));
    return await this.#recordTransition<EnrollResult>("enroll", async () => {
      // the worker gave up while waiting its turn (enroll call timed out): skip
      // rather than delay live enrollments queued behind; the channel aborts
      // the signal on cancel and close
      if (state.channel.closed || signal.aborted) {
        throw new ChannelClosedError(
          "control socket closed before enrollment began",
        );
      }
      // redeem validates state, expiry, secret and allowance and binds the
      // machine; it must precede the already-connected check because the worker
      // name depends on maxEnrollments
      const definitionId = await preparing(() =>
        this.#requireTokenDefinition(name)
      );
      try {
        await runPreparing({
          typeArg: ENROLLMENT_TOKEN_MODEL_TYPE.normalized,
          definitionName: name,
          methodName: "redeem",
          inputs: {
            presentedToken: secret,
            machineId: params.machineId,
          },
          // Pinned so a token this repo lacks is never auto-created.
          expectedDefinitionId: definitionId,
        });
      } catch (error) {
        throw codedRedeemFailure(error);
      }

      // One read of the record redeem just validated supplies the mint the
      // worker is bound to, its lifetime, and fleet naming.
      const record = await preparing(() => this.#readEnrolledRecord(name));
      const tokenCreatedAt = record.createdAt;
      const maxEnrollments = await preparing(() =>
        this.#readTokenMaxEnrollments(name, record)
      ) ?? 1;
      const workerName = maxEnrollments === 1
        ? name
        : `${name}-${await fleetMemberSuffix(params.machineId)}`;

      // the worker gave up during redeem: stop before the pool or definition
      // changes; redeem bound its machine, which re-authenticates next attempt
      // without spending another enrollment
      if (state.channel.closed || signal.aborted) {
        throw new ChannelClosedError(
          "control socket closed before enrollment was recorded",
        );
      }

      const existing = this.#workers.get(workerName);
      if (
        existing && existing.channel !== null && !existing.channel.closed &&
        existing.instanceUuid !== params.instanceUuid
      ) {
        throw new RpcError({
          code: "already_connected",
          message: `Worker '${workerName}' is already connected`,
        });
      }

      const reconnecting = existing !== undefined &&
        existing.instanceUuid === params.instanceUuid;

      // Pending timers on the prior entry would fire against this
      // enrollment — cancel them whether the same process reconnects or a
      // restarted process takes over. Expiry is re-armed below.
      if (existing?.graceTimer !== undefined) {
        clearTimeout(existing.graceTimer);
        existing.graceTimer = undefined;
      }
      if (existing?.expiryTimer !== undefined) {
        clearTimeout(existing.expiryTimer);
        existing.expiryTimer = undefined;
      }

      const labels = { ...params.labels };
      if (maxEnrollments !== 1) {
        if (labels.fleet !== undefined) {
          logger.warn(
            "Worker {worker} supplies its own fleet label {fleet}; keeping it instead of auto-injecting {tokenName}",
            { worker: workerName, fleet: labels.fleet, tokenName: name },
          );
        } else {
          labels.fleet = name;
        }
      }

      const capacity = (params.resourceLimits?.capacity as number) ?? 1;
      // under verify-on-enroll the worker is unverified until its probe passes,
      // and the durable record says so too so `swamp worker list` matches the
      // pool
      const initialStatus = this.#options.verifyOnEnroll
        ? "unverified"
        : "idle";

      if (reconnecting) {
        existing.channel = state.channel;
        existing.capacity = capacity;
        existing.protocolVersion = params.protocolVersion;
        await preparing(() =>
          this.#workerStatus.recordStatus(
            workerName,
            initialStatus === "unverified"
              ? {
                status: "unverified",
                activeDispatchIds: [...existing.activeDispatchIds],
              }
              : existing.activeDispatchIds.length > 0
              ? {
                status: "busy",
                activeDispatchIds: [...existing.activeDispatchIds],
              }
              : { status: "idle" },
          )
        );
      } else {
        await runPreparing({
          typeArg: WORKER_MODEL_TYPE.normalized,
          definitionName: workerDefinitionName(workerName),
          methodName: "enroll",
          inputs: {
            instanceUuid: params.instanceUuid,
            tokenName: name,
            workerName,
            labels,
            platform: params.platform,
            arch: params.arch,
            swampVersion: params.swampVersion,
            protocolVersion: params.protocolVersion,
            capacity,
            status: initialStatus,
          },
        });
      }

      // All durable transitions succeeded — only now mutate the pool, wire
      // the capability handlers, and issue the credential, so a failed
      // enrollment leaves no orphaned state behind.
      const entry: WorkerEntry = reconnecting ? existing : {
        name: workerName,
        tokenName: name,
        tokenCreatedAt,
        instanceUuid: params.instanceUuid,
        labels,
        platform: params.platform,
        arch: params.arch,
        swampVersion: params.swampVersion,
        protocolVersion: params.protocolVersion,
        channel: state.channel,
        closeSocket: state.closeSocket,
        status: initialStatus,
        capacity,
        activeDispatchIds: [],
      };
      if (reconnecting && this.#options.verifyOnEnroll) {
        entry.status = "unverified";
        // A refusal from before the reconnect is answered by the probe this
        // enrollment starts.
        entry.probeRefusedForCapacity = false;
      }
      entry.channel = state.channel;
      entry.closeSocket = state.closeSocket;
      entry.tokenCreatedAt = tokenCreatedAt;
      this.#workers.set(workerName, entry);
      state.workerName = workerName;

      // the socket closed during recording and its close handler found no
      // worker to disconnect: disconnect now so it gets the usual grace window
      // instead of staying a live worker on a dead socket
      if (state.channel.closed) {
        logger.info(
          "Worker {worker} closed its socket before enrollment finished",
          { worker: workerName },
        );
        this.#handleSocketClosed(state);
        throw new ChannelClosedError(
          "control socket closed during enrollment",
        );
      }

      // The token lifetime is a hard deadline: when it elapses, disconnect
      // the worker. Re-enrollment is then rejected as expired, so the
      // worker cannot return on this token.
      const expiresAt = await this.#readTokenExpiresAt(name, record);
      if (expiresAt !== null) {
        this.#scheduleTokenExpiry(entry, Date.parse(expiresAt));
      }

      this.#options.capabilityService.registerHandlers(
        state.channel,
        workerName,
      );
      state.channel.register(
        RemoteMethod.sessionRefresh,
        () => this.#handleSessionRefresh(workerName),
      );
      state.channel.register(
        RemoteMethod.drain,
        () => this.#handleDrain(workerName),
      );

      const session = this.#sessions.issue(workerName);
      logger.info("Worker {worker} enrolled ({mode})", {
        worker: workerName,
        mode: reconnecting ? "reconnect" : "first-connect",
      });
      if (!shipsReferencesOnly(params.protocolVersion)) {
        logger.warn(
          "Worker {worker} enrolled at deprecated protocol version {version}: its dispatches carry secret values in plaintext. Upgrade it to protocol version {current}; typed-secrets 5.3 stops enrolling version {version} workers",
          {
            worker: workerName,
            version: params.protocolVersion,
            current: REMOTE_PROTOCOL_VERSION,
          },
        );
      }

      if (this.#options.verifyOnEnroll && this.#options.verifyWorker) {
        this.#startEnrollmentVerify(workerName);
      } else {
        const snap = this.#snapshot(entry);
        this.#options.onWorkerEnrolled?.(snap);
        if (entry.status === "idle") {
          this.#options.onWorkerIdle?.(snap);
        }
      }

      return {
        workerId: workerName,
        sessionCredential: session.credential,
        sessionExpiresAtMs: session.expiresAtMs,
        protocolVersion: params.protocolVersion,
        ...(gatePass === undefined ? {} : { gatePass }),
      };
    });
  }

  #handleSessionRefresh(name: string): Promise<SessionRefreshResult> {
    const session = this.#sessions.issue(name);
    return Promise.resolve({
      sessionCredential: session.credential,
      sessionExpiresAtMs: session.expiresAtMs,
    });
  }

  async #handleDrain(workerName: string): Promise<void> {
    const entry = this.#workers.get(workerName);
    // A worker calls again when its in-flight work ends, to confirm its last
    // response arrived before it closes; the repeat changes nothing.
    if (!entry || entry.status === "draining") return;
    logger.info("Worker {worker} is draining", { worker: workerName });
    entry.status = "draining";
    await this.#recordTransition(
      "worker_draining",
      () => this.#workerStatus.recordStatus(workerName, { status: "draining" }),
    );
    this.#options.onWorkerDraining?.(this.#snapshot(entry));
  }

  #handleSocketClosed(state: SocketState): void {
    state.channel.close("control socket closed");
    const name = state.workerName;
    if (name === null) {
      return;
    }
    const entry = this.#workers.get(name);
    if (!entry || entry.channel !== state.channel) {
      // A newer socket has taken over (reconnect before close) — ignore.
      return;
    }
    entry.channel = null;
    const snapshot = this.#snapshot(entry);

    const recordDisconnect = this.#recordTransition(
      "worker_disconnected",
      () => this.#workerStatus.recordStatus(name, { status: "disconnected" }),
    );
    recordDisconnect.catch((error: unknown) => {
      logger.warn(
        "Failed to record disconnect for {worker}: {error}",
        {
          worker: name,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    });

    if (entry.status === "draining") {
      if (entry.expiryTimer !== undefined) {
        clearTimeout(entry.expiryTimer);
        entry.expiryTimer = undefined;
      }
      this.#workers.delete(name);
      this.#sessions.revokeAllForWorker(name);
      logger.info("Draining worker {worker} disconnected — removed from pool", {
        worker: name,
      });
      this.#options.onWorkerDisconnected?.(snapshot);
      return;
    }

    entry.graceTimer = setTimeout(() => {
      entry.graceTimer = undefined;
      if (entry.expiryTimer !== undefined) {
        clearTimeout(entry.expiryTimer);
        entry.expiryTimer = undefined;
      }
      this.#workers.delete(name);
      this.#sessions.revokeAllForWorker(name);
      logger.info("Reconnection grace window expired for {worker}", {
        worker: name,
      });
      this.#options.onGraceExpired?.(snapshot);
    }, this.#graceWindowMs);

    this.#options.onWorkerDisconnected?.(snapshot);
  }

  #scheduleTokenExpiry(entry: WorkerEntry, deadlineMs: number): void {
    if (Number.isNaN(deadlineMs)) {
      return;
    }
    const delay = deadlineMs - Date.now();
    if (delay > MAX_TIMEOUT_MS) {
      entry.expiryTimer = setTimeout(
        () => this.#scheduleTokenExpiry(entry, deadlineMs),
        MAX_TIMEOUT_MS,
      );
      return;
    }
    entry.expiryTimer = setTimeout(
      () => this.#handleTokenExpired(entry.name),
      Math.max(0, delay),
    );
  }

  /**
   * token lifetime elapsed: record the durable expired state and cut the worker
   * off at once, with no grace window since re-enrollment would be rejected as
   * expired
   */
  #handleTokenExpired(workerName: string): void {
    const entry = this.#workers.get(workerName);
    if (!entry) {
      return;
    }
    entry.expiryTimer = undefined;
    logger.info("Enrollment token for {worker} expired — disconnecting", {
      worker: workerName,
    });
    // bookkeeping only: redeem rejects on time itself, so a failure just delays
    // the durable record; a token with no definition has nothing to record, and
    // running expire by name would auto-create one
    this.#recordTransition("token_expire", async () => {
      const definitionId = await this.#findTokenDefinitionId(entry.tokenName);
      if (definitionId === null) {
        logger.debug(
          "Enrollment token {token} has no definition; skipping expiry record",
          { token: entry.tokenName },
        );
        return;
      }
      await this.#runModelMethod({
        typeArg: ENROLLMENT_TOKEN_MODEL_TYPE.normalized,
        definitionName: entry.tokenName,
        methodName: "expire",
        inputs: {},
        expectedDefinitionId: definitionId,
      });
    }).catch((error: unknown) => {
      logger.warn("Failed to record token expiry for {worker}: {error}", {
        worker: workerName,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const wasConnected = entry.channel !== null;
    this.#removeWorker(entry, "enrollment token expired");
    if (wasConnected) {
      // #recordDisconnected logs its own failures, so this never rejects.
      this.#recordTransition(
        "worker_disconnected",
        () => this.#recordDisconnected(workerName),
      )
        .catch(() => {});
    }
  }

  /**
   * the pool entry goes first so the socket close this triggers is ignored by
   * #handleSocketClosed instead of opening a grace window; closing the channel
   * rejects in-flight dispatches now
   */
  #removeWorker(entry: WorkerEntry, reason: string): void {
    if (entry.graceTimer !== undefined) {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = undefined;
    }
    if (entry.expiryTimer !== undefined) {
      clearTimeout(entry.expiryTimer);
      entry.expiryTimer = undefined;
    }
    this.#workers.delete(entry.name);
    this.#sessions.revokeAllForWorker(entry.name);

    const channel = entry.channel;
    entry.channel = null;
    if (channel !== null) {
      channel.close(reason);
      entry.closeSocket?.();
    }
    this.#options.onWorkerRemoved?.(this.#snapshot(entry));
  }

  /**
   * Durable record that a removed worker is no longer connected. Callers
   * run it on the transition tail. Bookkeeping only: failures are logged.
   */
  async #recordDisconnected(workerName: string): Promise<void> {
    try {
      await this.#workerStatus.recordStatus(workerName, {
        status: "disconnected",
      });
    } catch (error) {
      logger.warn("Failed to record disconnect for {worker}: {error}", {
        worker: workerName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Run the enrollment probe without holding up the caller. One runs at a
   * time per worker: a request made while one is running is remembered and
   * honoured when it finishes, if the worker is still unverified by then.
   */
  #startEnrollmentVerify(workerName: string): void {
    const entry = this.#workers.get(workerName);
    if (!entry) return;
    if (entry.verifying) {
      entry.verifyAgain = true;
      return;
    }
    entry.verifying = true;
    this.#runEnrollmentVerify(workerName).catch((e: unknown) => {
      logger.error(
        "Enrollment verify failed unexpectedly for {worker}: {error}",
        {
          worker: workerName,
          error: e instanceof Error ? e.message : String(e),
        },
      );
    }).finally(() => {
      entry.verifying = false;
      if (!entry.verifyAgain) return;
      entry.verifyAgain = false;
      if (
        this.#workers.get(workerName) === entry &&
        entry.status === "unverified" && entry.channel !== null &&
        !entry.channel.closed
      ) {
        this.#startEnrollmentVerify(workerName);
      }
    });
  }

  async #runEnrollmentVerify(workerName: string): Promise<void> {
    const verifyWorker = this.#options.verifyWorker!;
    // This run answers any refusal seen before it; only one it meets itself
    // calls for another.
    const started = this.#workers.get(workerName);
    if (started) started.probeRefusedForCapacity = false;
    try {
      const probeResult = await verifyWorker(workerName);
      const entry = this.#workers.get(workerName);
      if (!entry || entry.channel === null) return;
      if (probeResult.ok) {
        if (entry.status !== "draining") {
          await this.#recordTransition("verify_passed", async () => {
            entry.status = "idle";
            entry.verifyFailureReason = undefined;
            await this.#workerStatus.recordStatus(workerName, {
              status: "idle",
            });
          });
          const snap = this.#snapshot(entry);
          this.#options.onWorkerEnrolled?.(snap);
          this.#options.onWorkerIdle?.(snap);
        }
      } else {
        await this.#recordTransition("verify_failed", async () => {
          entry.verifyFailureReason = probeResult.failureReason;
          await this.#workerStatus.recordStatus(workerName, {
            status: "unverified",
            activeDispatchIds: [...entry.activeDispatchIds],
            verifyFailureReason: probeResult.failureReason,
          });
        });
        logger.warn(
          "Worker {worker} failed enrollment verification: {reason}",
          { worker: workerName, reason: probeResult.failureReason ?? "" },
        );
      }
    } catch (error) {
      const entry = this.#workers.get(workerName);
      if (!entry || entry.channel === null) return;
      const reason = error instanceof Error ? error.message : String(error);
      await this.#recordTransition("verify_failed", async () => {
        entry.verifyFailureReason = reason;
        await this.#workerStatus.recordStatus(workerName, {
          status: "unverified",
          activeDispatchIds: [...entry.activeDispatchIds],
          verifyFailureReason: reason,
        });
      }).catch((persistError: unknown) => {
        logger.warn(
          "Failed to persist unverified status for {worker}: {error}",
          {
            worker: workerName,
            error: persistError instanceof Error
              ? persistError.message
              : String(persistError),
          },
        );
      });
      logger.warn(
        "Worker {worker} verification probe errored: {reason}",
        { worker: workerName, reason },
      );
    }
  }

  #snapshot(entry: WorkerEntry): WorkerSnapshot {
    return {
      name: entry.name,
      instanceUuid: entry.instanceUuid,
      labels: { ...entry.labels },
      platform: entry.platform,
      arch: entry.arch,
      swampVersion: entry.swampVersion,
      protocolVersion: entry.protocolVersion,
      status: entry.status,
      connected: entry.channel !== null,
      capacity: entry.capacity,
      activeDispatchIds: [...entry.activeDispatchIds],
      verifyFailureReason: entry.verifyFailureReason,
    };
  }

  /**
   * every durable pool/token mutation flows through this serialized tail,
   * preserving the sole-writer invariant; operation labels its span
   */
  #recordTransition<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return this.#transitions.run(operation, fn);
  }

  /**
   * redeem read this record a moment ago, so a failure here is transient: the
   * enrollment fails and the worker retries rather than joining the pool
   * without a known mint or expiry deadline
   */
  async #readEnrolledRecord(tokenName: string): Promise<EnrollmentToken> {
    let record: EnrollmentToken | null;
    try {
      record = await this.#readTokenRecord(tokenName);
    } catch (error) {
      logger.warn("Failed to read enrollment token {token}: {error}", {
        token: tokenName,
        error: error instanceof Error ? error.message : String(error),
      });
      record = null;
    }
    if (record === null) {
      throw new RpcError({
        code: "token_unreadable",
        message:
          `Enrollment token '${tokenName}' could not be read after redemption; retry the connection`,
      });
    }
    return record;
  }

  /**
   * redeem runs pinned to this id so enrollment never creates a token
   * definition; with none but a record present, the token was minted on an HA
   * peer this replica has not pulled yet, a retryable refusal
   */
  async #requireTokenDefinition(tokenName: string): Promise<string> {
    const definitionId = await this.#findTokenDefinitionId(tokenName);
    if (definitionId !== null) return definitionId;
    if (await this.#readTokenRecord(tokenName) !== null) {
      throw new RpcError({
        code: "token_not_synced",
        message:
          `Enrollment token '${tokenName}' has a record but no definition on this orchestrator yet; retry the connection`,
      });
    }
    throw new RpcError({
      code: "token_not_found",
      message: `Enrollment token '${tokenName}' does not exist — mint it first`,
    });
  }

  async #findTokenRecord(tokenName: string): Promise<EnrollmentToken | null> {
    return (await this.#scanTokenRecords()).get(tokenName) ?? null;
  }

  /**
   * skips records that are deleted, renamed, unparsable or that the datastore
   * could not materialise; other read failures propagate
   */
  #scanTokenRecords(): Promise<Map<string, EnrollmentToken>> {
    return observeDiagnosticPhase(
      "token_record_scan",
      {},
      (phase) => this.#readTokenRecords(phase.tally),
    );
  }

  async #readTokenRecords(
    tally: PhaseTally,
  ): Promise<Map<string, EnrollmentToken>> {
    const records = new Map<string, EnrollmentToken>();
    const dataItems = await tally.measure(
      "list",
      () =>
        this.#options.repoContext.unifiedDataRepo
          .findAllForType(ENROLLMENT_TOKEN_MODEL_TYPE),
    );
    tally.add("records_listed", dataItems.length);
    for (const { data, modelType, modelId } of dataItems) {
      if (data.isRenamed || data.isDeleted) continue;
      if (data.name !== TOKEN_DATA_NAME) continue;
      let content: Uint8Array | null;
      try {
        content = await tally.measure(
          "read",
          () =>
            this.#options.repoContext.unifiedDataRepo
              .getContent(modelType, modelId, data.name),
        );
        tally.add("content_reads");
        if (content) tally.add("bytes_read", content.length);
      } catch (error) {
        // one record the datastore could not materialise is left out rather
        // than failing every enrollment
        if (!isUnreadableContentError(error)) throw error;
        tally.add("unreadable");
        logger.warn(
          "Skipping unreadable enrollment token record {modelId}: {error}",
          { modelId, error: (error as Error).message },
        );
        continue;
      }
      if (!content) continue;
      let attrs: Record<string, unknown>;
      try {
        attrs = JSON.parse(new TextDecoder().decode(content)) as Record<
          string,
          unknown
        >;
      } catch {
        continue;
      }
      const parsed = EnrollmentTokenSchema.safeParse(attrs);
      if (!parsed.success) continue;
      // Two records under one name (a definition recreated over stale data)
      // resolve to the newest mint, never a stale revoked one.
      const existing = records.get(parsed.data.name);
      if (
        existing === undefined ||
        Date.parse(parsed.data.createdAt) > Date.parse(existing.createdAt)
      ) {
        records.set(parsed.data.name, parsed.data);
      }
    }
    tally.add("tokens", records.size);
    return records;
  }

  async #defaultRunModelMethod(
    input: Parameters<ModelMethodRunner>[0],
  ): Promise<void> {
    const deps = await observeDiagnosticPhase(
      "registry_load",
      {},
      () =>
        createWorkerModelRunDeps(
          this.#options.repoDir,
          this.#options.repoContext,
          { definitionType: ModelType.create(input.typeArg) },
        ),
    );
    const libCtx = createLibSwampContext({
      openUnitOfWork: repoUnitOfWorkFactory(this.#options.repoContext),
    });
    // control-plane bookkeeping (enrollment tokens) is never held to a run's
    // vault scope
    for await (
      const event of runGeneratorWithoutVaultAccess(() =>
        modelMethodRun(libCtx, deps, {
          modelIdOrName: input.definitionName,
          methodName: input.methodName,
          inputs: input.inputs,
          lastEvaluated: false,
          typeArg: input.typeArg,
          definitionName: input.definitionName,
          expectedDefinitionId: input.expectedDefinitionId,
          // Control-plane bookkeeping: skip per-run report artifacts so pool
          // churn stays bounded to the state records themselves.
          skipAllReports: true,
        })
      )
    ) {
      if (event.kind === "error") {
        const detail = event.error;
        const message = detail instanceof Error
          ? detail.message
          : typeof detail === "object" && detail !== null &&
              "message" in detail
          ? String((detail as { message: unknown }).message)
          : String(detail);
        throw new Error(message);
      }
    }
  }
}
