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
 * The orchestrator's worker gateway (see design/remote-execution.md,
 * "Enrollment" and "Failure, reconnection, and retry").
 *
 * Owns the live worker pool: enrollment over the control socket, session
 * credentials for the data plane, dispatch/cancel toward workers, the
 * reconnection grace window, and the persistence of every pool transition
 * through the built-in worker/enrollment-token models — the orchestrator
 * process serializes those transitions in memory, which is what makes the
 * token state machine race-free without datastore CAS.
 */

import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import {
  createLibSwampContext,
  createWorkerModelRunDeps,
  modelMethodRun,
} from "../libswamp/mod.ts";
import { RpcChannel, RpcError } from "../domain/remote/rpc_channel.ts";
import type { RpcTransport } from "../domain/remote/rpc_channel.ts";
import {
  type DispatchParams,
  type DispatchResult,
  DispatchResultSchema,
  EnrollParamsSchema,
  type EnrollResult,
  REMOTE_PROTOCOL_VERSION,
  RemoteMethod,
  type RpcStreamEvent,
  type SessionRefreshResult,
  WorkerMethod,
} from "../domain/remote/protocol.ts";
import { SessionCredentialService } from "../domain/remote/session_credential.ts";
import {
  WORKER_MODEL_TYPE,
  workerDefinitionName,
} from "../domain/models/worker/worker_model.ts";
import {
  ENROLLMENT_TOKEN_MODEL_TYPE,
  EnrollmentTokenSchema,
  type MaxEnrollments,
} from "../domain/models/worker/enrollment_token_model.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "worker-gateway"]);

/** Default reconnection grace window after a control-socket drop. */
export const DEFAULT_GRACE_WINDOW_MS = 60_000;

/** The enrollment-token model's single resource name. */
const TOKEN_DATA_NAME = "token-main";

/** setTimeout overflows past 2^31-1 ms; longer waits are chained. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Splits a presented enrollment credential of the form `<name>.<secret>`.
 * The name half addresses the token aggregate; the secret half is compared
 * against the vault-stored plaintext.
 */
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
 * Stable 8-hex-char suffix derived from a machineId, used to give each
 * fleet member a distinct worker name: `<tokenName>-<suffix>`.
 *
 * 4 bytes → ~4 billion values; birthday-paradox collision is negligible
 * for any practical fleet size.
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
  status: "idle" | "busy" | "unverified" | "draining";
  connected: boolean;
  dispatchId: string | null;
  verifyFailureReason?: string;
}

interface WorkerEntry {
  name: string;
  /** The enrollment-token model instance name (differs from `name` for fleet workers). */
  tokenName: string;
  instanceUuid: string;
  labels: Record<string, string>;
  platform: string;
  arch: string;
  swampVersion: string;
  channel: RpcChannel | null;
  /** Force-closes the current control socket (absent for test transports). */
  closeSocket: (() => void) | null;
  status: "idle" | "busy" | "unverified" | "draining";
  dispatchId: string | null;
  verifyFailureReason?: string;
  graceTimer?: ReturnType<typeof setTimeout>;
  /** Fires at the token's `expiresAt` to disconnect the worker. */
  expiryTimer?: ReturnType<typeof setTimeout>;
}

/** Runs a built-in model method; injectable for tests. */
export type ModelMethodRunner = (input: {
  typeArg: string;
  definitionName: string;
  methodName: string;
  inputs: Record<string, unknown>;
}) => Promise<void>;

export interface WorkerGatewayOptions {
  repoDir: string;
  repoContext: RepositoryContext;
  /** Registers the capability verb handlers on an enrolled channel. */
  capabilityService: {
    registerHandlers(channel: RpcChannel, workerName: string): void;
  };
  sessionCredentials?: SessionCredentialService;
  graceWindowMs?: number;
  swampVersion?: string;
  /** A worker became idle (enrolled, finished a dispatch, or reconnected). */
  onWorkerIdle?: (worker: WorkerSnapshot) => void;
  /** A worker's control socket dropped; the grace window has started. */
  onWorkerDisconnected?: (worker: WorkerSnapshot) => void;
  /** The grace window elapsed without reconnection; the worker is gone. */
  onGraceExpired?: (worker: WorkerSnapshot) => void;
  /** A worker enrolled or re-enrolled (including within the grace window). */
  onWorkerEnrolled?: (worker: WorkerSnapshot) => void;
  /** A worker announced it is draining (no longer schedulable). */
  onWorkerDraining?: (worker: WorkerSnapshot) => void;
  /**
   * When true, dispatch a fleet probe to each enrolling worker before it
   * becomes schedulable. Workers that fail the probe are marked `unverified`.
   * Requires `verifyWorker` to be set.
   */
  verifyOnEnroll?: boolean;
  /**
   * Dispatches the fleet probe to a worker and returns whether it passed.
   * Wired by the serve command to use the DispatchService.
   */
  verifyWorker?: (
    workerName: string,
  ) => Promise<{ ok: boolean; failureReason?: string }>;
  /** Test seam: overrides the modelMethodRun-backed transition runner. */
  runModelMethod?: ModelMethodRunner;
  /**
   * Test seam: reads a token's `expiresAt` after redemption; null disables
   * expiry enforcement for that worker. Defaults to a datastore query.
   */
  readTokenExpiresAt?: (tokenName: string) => Promise<string | null>;
  /**
   * Test seam: reads a token's `maxEnrollments` after redemption for fleet
   * naming. Defaults to a datastore query.
   */
  readTokenMaxEnrollments?: (
    tokenName: string,
  ) => Promise<MaxEnrollments | null>;
}

/** Tracks one attached control socket before/after enrollment. */
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
  readonly #readTokenExpiresAt: (tokenName: string) => Promise<string | null>;
  readonly #readTokenMaxEnrollments: (
    tokenName: string,
  ) => Promise<MaxEnrollments | null>;
  /** Serializes every token/worker/lease transition (sole-writer rule). */
  #transitionTail: Promise<unknown> = Promise.resolve();

  constructor(options: WorkerGatewayOptions) {
    this.#options = options;
    this.#sessions = options.sessionCredentials ??
      new SessionCredentialService();
    this.#graceWindowMs = options.graceWindowMs ?? DEFAULT_GRACE_WINDOW_MS;
    this.#runModelMethod = options.runModelMethod ??
      ((input) => this.#defaultRunModelMethod(input));
    this.#readTokenExpiresAt = options.readTokenExpiresAt ??
      ((tokenName) => this.#defaultReadTokenExpiresAt(tokenName));
    this.#readTokenMaxEnrollments = options.readTokenMaxEnrollments ??
      ((tokenName) => this.#defaultReadTokenMaxEnrollments(tokenName));
  }

  /** The credential service the data plane authenticates against. */
  get sessions(): SessionCredentialService {
    return this.#sessions;
  }

  /**
   * Attach a control socket. Returns the per-socket state whose channel
   * consumes RPC frames; the caller feeds raw messages to `feed()` and must
   * call `closed()` from the socket's close handler. `close` lets the
   * gateway force-disconnect the socket (token expiry); the close must
   * still surface through the caller's close handler.
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
      (params) => this.#handleEnroll(state, params),
    );
    return {
      feed: (raw) => state.channel.handleRaw(raw),
      closed: () => this.#handleSocketClosed(state),
    };
  }

  /** Live pool snapshot for scheduling decisions. */
  workers(): WorkerSnapshot[] {
    return [...this.#workers.values()].map((entry) => this.#snapshot(entry));
  }

  /** Snapshot of one worker, or null when not in the pool. */
  worker(name: string): WorkerSnapshot | null {
    const entry = this.#workers.get(name);
    return entry ? this.#snapshot(entry) : null;
  }

  /**
   * Dispatch one execution request to a named worker. Resolves with the
   * worker's result; rejects when the worker is unknown, busy, disconnected,
   * or the control socket drops mid-dispatch (the caller owns grace-window
   * failure semantics — see DispatchService).
   */
  async dispatch(
    name: string,
    params: DispatchParams,
    options?: {
      signal?: AbortSignal;
      onEvent?: (event: RpcStreamEvent) => void;
    },
  ): Promise<DispatchResult> {
    const entry = this.#workers.get(name);
    if (!entry) {
      throw new Error(`Worker '${name}' is not in the pool`);
    }
    if (entry.channel === null) {
      throw new Error(`Worker '${name}' is disconnected`);
    }
    if (entry.status === "busy") {
      throw new Error(`Worker '${name}' is busy`);
    }
    if (entry.status === "unverified" && !params.probeMarker) {
      throw new Error(`Worker '${name}' is unverified`);
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
    entry.status = "busy";
    entry.dispatchId = params.dispatchId;
    await this.#recordTransition(() =>
      this.#runModelMethod({
        typeArg: WORKER_MODEL_TYPE.normalized,
        definitionName: workerDefinitionName(name),
        methodName: "set_status",
        inputs: { status: "busy", dispatchId: params.dispatchId },
      })
    );

    try {
      const raw = await entry.channel.call(
        WorkerMethod.dispatch,
        params,
        {
          timeoutMs: null,
          signal: options?.signal,
          onStream: options?.onEvent,
          // A cancelled dispatch must stay pending until the worker's
          // serial slot has actually freed — otherwise the next dispatch
          // races the worker's busy guard.
          waitForPeerOnCancel: true,
        },
      );
      const result = DispatchResultSchema.parse(raw);
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
      entry.dispatchId = null;
      const currentStatus = entry.status as string;
      if (entry.channel === null || entry.channel.closed) {
        // The socket dropped mid-dispatch. The in-memory status returns to
        // idle so a reconnect within the grace window is schedulable again;
        // the durable record already says "disconnected".
        entry.status = "idle";
      } else if (currentStatus !== "draining") {
        entry.status = "idle";
        await this.#recordTransition(() =>
          this.#runModelMethod({
            typeArg: WORKER_MODEL_TYPE.normalized,
            definitionName: workerDefinitionName(name),
            methodName: "set_status",
            inputs: { status: "idle" },
          })
        ).catch((error: unknown) => {
          logger.warn("Failed to record idle status for {worker}: {error}", {
            worker: name,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        this.#options.onWorkerIdle?.(this.#snapshot(entry));
      }
    }
  }

  /** Number of grace timers currently pending (test introspection). */
  get pendingGraceWindows(): number {
    return [...this.#workers.values()].filter((w) => w.graceTimer !== undefined)
      .length;
  }

  async #handleEnroll(
    state: SocketState,
    rawParams: unknown,
  ): Promise<EnrollResult> {
    const params = EnrollParamsSchema.parse(rawParams);

    if (params.protocolVersion !== REMOTE_PROTOCOL_VERSION) {
      throw new RpcError({
        code: "protocol_mismatch",
        message:
          `Worker protocol version ${params.protocolVersion} does not match orchestrator version ${REMOTE_PROTOCOL_VERSION}`,
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

    return await this.#recordTransition<EnrollResult>(async () => {
      // Redeem validates state, expiry, the secret, and allowance — and
      // appends a binding on first enrollment or re-auths a known machine.
      // Must happen before the already-connected check because the worker
      // name depends on maxEnrollments (fleet vs single-machine).
      await this.#runModelMethod({
        typeArg: ENROLLMENT_TOKEN_MODEL_TYPE.normalized,
        definitionName: name,
        methodName: "redeem",
        inputs: {
          presentedToken: secret,
          machineId: params.machineId,
        },
      });

      const maxEnrollments = await this.#readTokenMaxEnrollments(name) ?? 1;
      const workerName = maxEnrollments === 1
        ? name
        : `${name}-${await fleetMemberSuffix(params.machineId)}`;

      const existing = this.#workers.get(workerName);
      if (
        existing && existing.channel !== null &&
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

      // Auto-inject fleet label for multi-machine tokens.
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

      if (reconnecting) {
        existing.channel = state.channel;
        await this.#runModelMethod({
          typeArg: WORKER_MODEL_TYPE.normalized,
          definitionName: workerDefinitionName(workerName),
          methodName: "set_status",
          inputs: existing.status === "busy"
            ? { status: "busy", dispatchId: existing.dispatchId ?? undefined }
            : { status: "idle" },
        });
      } else {
        await this.#runModelMethod({
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
          },
        });
      }

      // All durable transitions succeeded — only now mutate the pool, wire
      // the capability handlers, and issue the credential, so a failed
      // enrollment leaves no orphaned state behind.
      const initialStatus = this.#options.verifyOnEnroll
        ? "unverified"
        : "idle";
      const entry: WorkerEntry = reconnecting ? existing : {
        name: workerName,
        tokenName: name,
        instanceUuid: params.instanceUuid,
        labels,
        platform: params.platform,
        arch: params.arch,
        swampVersion: params.swampVersion,
        channel: state.channel,
        closeSocket: state.closeSocket,
        status: initialStatus,
        dispatchId: null,
      };
      if (reconnecting && this.#options.verifyOnEnroll) {
        entry.status = "unverified";
      }
      entry.channel = state.channel;
      entry.closeSocket = state.closeSocket;
      this.#workers.set(workerName, entry);
      state.workerName = workerName;

      // The token lifetime is a hard deadline: when it elapses, disconnect
      // the worker. Re-enrollment is then rejected as expired, so the
      // worker cannot return on this token.
      const expiresAt = await this.#readTokenExpiresAt(name);
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

      if (this.#options.verifyOnEnroll && this.#options.verifyWorker) {
        this.#runEnrollmentVerify(workerName).catch((e: unknown) => {
          logger.error(
            "Enrollment verify failed unexpectedly for {worker}: {error}",
            {
              worker: workerName,
              error: e instanceof Error ? e.message : String(e),
            },
          );
        });
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
        protocolVersion: REMOTE_PROTOCOL_VERSION,
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
    if (!entry) return;
    logger.info("Worker {worker} is draining", { worker: workerName });
    entry.status = "draining";
    await this.#recordTransition(() =>
      this.#runModelMethod({
        typeArg: WORKER_MODEL_TYPE.normalized,
        definitionName: workerDefinitionName(workerName),
        methodName: "set_status",
        inputs: { status: "draining" },
      })
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

    const recordDisconnect = this.#recordTransition(() =>
      this.#runModelMethod({
        typeArg: WORKER_MODEL_TYPE.normalized,
        definitionName: workerDefinitionName(name),
        methodName: "set_status",
        inputs: { status: "disconnected" },
      })
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
      this.#sessions.revokeForWorker(name);
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
      this.#sessions.revokeForWorker(name);
      logger.info("Reconnection grace window expired for {worker}", {
        worker: name,
      });
      this.#options.onGraceExpired?.(snapshot);
    }, this.#graceWindowMs);

    this.#options.onWorkerDisconnected?.(snapshot);
  }

  /** Arm the token-expiry timer, chaining past the setTimeout cap. */
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
   * The token lifetime elapsed for a pool member: record the durable
   * `expired` state and force the control socket closed. The close surfaces
   * through the normal disconnect path (grace window, then removal); the
   * worker's re-enrollment attempt is rejected as expired, so it cannot
   * return on this token.
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
    // Bookkeeping only: redeem independently rejects on time, so a failure
    // here just delays the durable record catching up.
    this.#recordTransition(() =>
      this.#runModelMethod({
        typeArg: ENROLLMENT_TOKEN_MODEL_TYPE.normalized,
        definitionName: entry.tokenName,
        methodName: "expire",
        inputs: {},
      })
    ).catch((error: unknown) => {
      logger.warn("Failed to record token expiry for {worker}: {error}", {
        worker: workerName,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    if (entry.channel !== null) {
      if (entry.closeSocket !== null) {
        entry.closeSocket();
      } else {
        // No transport close hook: at least tear down the channel so the
        // worker's session refresh fails and it falls back to re-enrolling.
        entry.channel.close("enrollment token expired");
      }
    }
  }

  async #runEnrollmentVerify(workerName: string): Promise<void> {
    const verifyWorker = this.#options.verifyWorker!;
    try {
      const probeResult = await verifyWorker(workerName);
      const entry = this.#workers.get(workerName);
      if (!entry || entry.channel === null) return;
      if (probeResult.ok) {
        await this.#recordTransition(async () => {
          entry.status = "idle";
          entry.verifyFailureReason = undefined;
          await this.#runModelMethod({
            typeArg: "swamp/worker",
            definitionName: workerDefinitionName(workerName),
            methodName: "set_status",
            inputs: { status: "idle" },
          });
        });
        const snap = this.#snapshot(entry);
        this.#options.onWorkerEnrolled?.(snap);
        this.#options.onWorkerIdle?.(snap);
      } else {
        await this.#recordTransition(async () => {
          entry.verifyFailureReason = probeResult.failureReason;
          await this.#runModelMethod({
            typeArg: "swamp/worker",
            definitionName: workerDefinitionName(workerName),
            methodName: "set_status",
            inputs: {
              status: "unverified",
              verifyFailureReason: probeResult.failureReason,
            },
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
      await this.#recordTransition(async () => {
        entry.verifyFailureReason = reason;
        await this.#runModelMethod({
          typeArg: "swamp/worker",
          definitionName: workerDefinitionName(workerName),
          methodName: "set_status",
          inputs: {
            status: "unverified",
            verifyFailureReason: reason,
          },
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
      status: entry.status,
      connected: entry.channel !== null,
      dispatchId: entry.dispatchId,
      verifyFailureReason: entry.verifyFailureReason,
    };
  }

  /**
   * Append a transition to the serialized tail. Every durable pool/token
   * mutation flows through here, preserving the sole-writer invariant.
   */
  #recordTransition<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#transitionTail.then(fn, fn);
    this.#transitionTail = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * Reads the token's recorded `expiresAt` for expiry scheduling. Returns
   * null when the record cannot be found or parsed — enrollment proceeds
   * without live enforcement rather than failing (redeem still rejects
   * expired tokens at the next reconnect).
   */
  async #defaultReadTokenExpiresAt(tokenName: string): Promise<string | null> {
    try {
      const dataItems = await this.#options.repoContext.unifiedDataRepo
        .findAllForType(ENROLLMENT_TOKEN_MODEL_TYPE);
      for (const { data, modelType, modelId } of dataItems) {
        if (data.isRenamed || data.isDeleted) continue;
        if (data.name !== TOKEN_DATA_NAME) continue;
        const content = await this.#options.repoContext.unifiedDataRepo
          .getContent(modelType, modelId, data.name);
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
        if (parsed.success && parsed.data.name === tokenName) {
          return parsed.data.expiresAt;
        }
      }
    } catch (error) {
      logger.warn("Failed to read token expiry for {worker}: {error}", {
        worker: tokenName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }

  async #defaultReadTokenMaxEnrollments(
    tokenName: string,
  ): Promise<MaxEnrollments | null> {
    try {
      const dataItems = await this.#options.repoContext.unifiedDataRepo
        .findAllForType(ENROLLMENT_TOKEN_MODEL_TYPE);
      for (const { data, modelType, modelId } of dataItems) {
        if (data.isRenamed || data.isDeleted) continue;
        if (data.name !== TOKEN_DATA_NAME) continue;
        const content = await this.#options.repoContext.unifiedDataRepo
          .getContent(modelType, modelId, data.name);
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
        if (parsed.success && parsed.data.name === tokenName) {
          return parsed.data.maxEnrollments;
        }
      }
    } catch (error) {
      logger.warn(
        "Failed to read token maxEnrollments for {worker}: {error}",
        {
          worker: tokenName,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    return null;
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
