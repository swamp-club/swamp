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
import { ENROLLMENT_TOKEN_MODEL_TYPE } from "../domain/models/worker/enrollment_token_model.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "worker-gateway"]);

/** Default reconnection grace window after a control-socket drop. */
export const DEFAULT_GRACE_WINDOW_MS = 60_000;

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

export interface WorkerSnapshot {
  name: string;
  instanceUuid: string;
  labels: Record<string, string>;
  platform: string;
  arch: string;
  swampVersion: string;
  status: "idle" | "busy";
  connected: boolean;
  dispatchId: string | null;
}

interface WorkerEntry {
  name: string;
  instanceUuid: string;
  labels: Record<string, string>;
  platform: string;
  arch: string;
  swampVersion: string;
  channel: RpcChannel | null;
  status: "idle" | "busy";
  dispatchId: string | null;
  graceTimer?: ReturnType<typeof setTimeout>;
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
  capabilityService: { registerHandlers(channel: RpcChannel): void };
  sessionCredentials?: SessionCredentialService;
  graceWindowMs?: number;
  swampVersion?: string;
  /** A worker became idle (enrolled, finished a dispatch, or reconnected). */
  onWorkerIdle?: (worker: WorkerSnapshot) => void;
  /** A worker's control socket dropped; the grace window has started. */
  onWorkerDisconnected?: (worker: WorkerSnapshot) => void;
  /** The grace window elapsed without reconnection; the worker is gone. */
  onGraceExpired?: (worker: WorkerSnapshot) => void;
  /** Test seam: overrides the modelMethodRun-backed transition runner. */
  runModelMethod?: ModelMethodRunner;
}

/** Tracks one attached control socket before/after enrollment. */
interface SocketState {
  channel: RpcChannel;
  workerName: string | null;
}

export class WorkerGateway {
  readonly #options: WorkerGatewayOptions;
  readonly #workers = new Map<string, WorkerEntry>();
  readonly #sessions: SessionCredentialService;
  readonly #graceWindowMs: number;
  readonly #runModelMethod: ModelMethodRunner;
  /** Serializes every token/worker/lease transition (sole-writer rule). */
  #transitionTail: Promise<unknown> = Promise.resolve();

  constructor(options: WorkerGatewayOptions) {
    this.#options = options;
    this.#sessions = options.sessionCredentials ??
      new SessionCredentialService();
    this.#graceWindowMs = options.graceWindowMs ?? DEFAULT_GRACE_WINDOW_MS;
    this.#runModelMethod = options.runModelMethod ??
      ((input) => this.#defaultRunModelMethod(input));
  }

  /** The credential service the data plane authenticates against. */
  get sessions(): SessionCredentialService {
    return this.#sessions;
  }

  /**
   * Attach a control socket. Returns the per-socket state whose channel
   * consumes RPC frames; the caller feeds raw messages to `feed()` and must
   * call `closed()` from the socket's close handler.
   */
  attachTransport(transport: RpcTransport): {
    feed: (raw: string) => boolean;
    closed: () => void;
  } {
    const state: SocketState = {
      channel: new RpcChannel(transport),
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
        },
      );
      return DispatchResultSchema.parse(raw);
    } finally {
      entry.dispatchId = null;
      if (entry.channel === null || entry.channel.closed) {
        // The socket dropped mid-dispatch. The in-memory status returns to
        // idle so a reconnect within the grace window is schedulable again;
        // the durable record already says "disconnected".
        entry.status = "idle";
      } else {
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
      const existing = this.#workers.get(name);
      if (
        existing && existing.channel !== null &&
        existing.instanceUuid !== params.instanceUuid
      ) {
        throw new RpcError({
          code: "already_connected",
          message: `Worker '${name}' is already connected`,
        });
      }

      // Redeem validates state, expiry, the secret, and instance binding —
      // and performs the unused → enrolled transition on first redemption.
      await this.#runModelMethod({
        typeArg: ENROLLMENT_TOKEN_MODEL_TYPE.normalized,
        definitionName: name,
        methodName: "redeem",
        inputs: {
          presentedToken: secret,
          instanceUuid: params.instanceUuid,
        },
      });

      const reconnecting = existing !== undefined &&
        existing.instanceUuid === params.instanceUuid;

      if (reconnecting) {
        if (existing.graceTimer !== undefined) {
          clearTimeout(existing.graceTimer);
          existing.graceTimer = undefined;
        }
        existing.channel = state.channel;
        await this.#runModelMethod({
          typeArg: WORKER_MODEL_TYPE.normalized,
          definitionName: workerDefinitionName(name),
          methodName: "set_status",
          inputs: existing.status === "busy"
            ? { status: "busy", dispatchId: existing.dispatchId ?? undefined }
            : { status: "idle" },
        });
      } else {
        await this.#runModelMethod({
          typeArg: WORKER_MODEL_TYPE.normalized,
          definitionName: workerDefinitionName(name),
          methodName: "enroll",
          inputs: {
            instanceUuid: params.instanceUuid,
            tokenName: name,
            labels: params.labels,
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
      const entry: WorkerEntry = reconnecting ? existing : {
        name,
        instanceUuid: params.instanceUuid,
        labels: params.labels,
        platform: params.platform,
        arch: params.arch,
        swampVersion: params.swampVersion,
        channel: state.channel,
        status: "idle",
        dispatchId: null,
      };
      entry.channel = state.channel;
      this.#workers.set(name, entry);
      state.workerName = name;

      this.#options.capabilityService.registerHandlers(state.channel);
      state.channel.register(
        RemoteMethod.sessionRefresh,
        () => this.#handleSessionRefresh(name),
      );

      const session = this.#sessions.issue(name);
      logger.info("Worker {worker} enrolled ({mode})", {
        worker: name,
        mode: reconnecting ? "reconnect" : "first-connect",
      });
      if (entry.status === "idle") {
        this.#options.onWorkerIdle?.(this.#snapshot(entry));
      }
      return {
        workerId: name,
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

    entry.graceTimer = setTimeout(() => {
      entry.graceTimer = undefined;
      this.#workers.delete(name);
      this.#sessions.revokeForWorker(name);
      logger.info("Reconnection grace window expired for {worker}", {
        worker: name,
      });
      this.#options.onGraceExpired?.(snapshot);
    }, this.#graceWindowMs);

    this.#options.onWorkerDisconnected?.(snapshot);
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
