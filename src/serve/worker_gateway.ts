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
 * The orchestrator's worker gateway (see design/enablers/remote-execution.md,
 * "Enrollment" and "Failure, reconnection, and retry").
 *
 * Owns the live worker pool: enrollment over the control socket, session
 * credentials for the data plane, dispatch/cancel toward workers, the
 * reconnection grace window, and the persistence of every pool transition
 * through the built-in worker/enrollment-token models — the orchestrator
 * process serializes those transitions in memory, which is what makes the
 * token state machine race-free without datastore CAS.
 */

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
  REMOTE_PROTOCOL_VERSION,
  RemoteMethod,
  type RpcStreamEvent,
  type SessionRefreshResult,
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
import { observeExecutionWork } from "../domain/remote/observability.ts";
import { runDetached } from "../infrastructure/tracing/tracer.ts";
import { isUnreadableContentError } from "../domain/datastore/unreadable_content.ts";
import { TransitionTail } from "./transition_tail.ts";

const logger = getSwampLogger(["serve", "worker-gateway"]);

/** Default reconnection grace window after a control-socket drop. */
export const DEFAULT_GRACE_WINDOW_MS = 60_000;

/** The enrollment-token model's single resource name. */
const TOKEN_DATA_NAME = "token-main";

/**
 * Redeem rejections, matched on the message with quoted names removed, and
 * the code the worker decides on. Anything unmatched is rethrown as is and
 * reaches the worker as a retryable `handler_failed`.
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

/** Human wording for each way a token loses its authority. */
const CUTOFF_REASONS: Record<EnrollmentBindingCutoffCause, string> = {
  revoked: "revoked",
  reminted: "re-minted",
  deleted: "deleted",
};

/** setTimeout overflows past 2^31-1 ms; longer waits are chained. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** How long close() waits for queued transitions before shutdown moves on. */
export const GATEWAY_CLOSE_DEADLINE_MS = 10_000;

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
  capacity: number;
  activeDispatchIds: string[];
  verifyFailureReason?: string;
}

interface WorkerEntry {
  name: string;
  /** The enrollment-token model instance name (differs from `name` for fleet workers). */
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
  channel: RpcChannel | null;
  /** Force-closes the current control socket (absent for test transports). */
  closeSocket: (() => void) | null;
  status: "idle" | "busy" | "unverified" | "draining";
  capacity: number;
  activeDispatchIds: string[];
  verifyFailureReason?: string;
  /** An enrollment verification is running for this entry. */
  verifying?: boolean;
  /** Another verification was asked for while one was running. */
  verifyAgain?: boolean;
  /**
   * A probe was refused for want of a slot while the unverified worker's
   * enrollment verification was running. The next dispatch to end with no
   * slots held probes it again.
   */
  probeRefusedForCapacity?: boolean;
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
  /**
   * The id of the definition the caller resolved. When set, the run is
   * refused rather than auto-creating a definition if the name no longer
   * resolves to that id.
   */
  expectedDefinitionId?: string;
}) => Promise<void>;

/** Why the gateway refused to send a dispatch to a worker. */
export type WorkerNotDispatchableReason =
  | "not_in_pool"
  | "disconnected"
  | "at_capacity"
  | "unverified"
  | "draining";

const NOT_DISPATCHABLE_PHRASES: Record<WorkerNotDispatchableReason, string> = {
  not_in_pool: "is not in the pool",
  disconnected: "is disconnected",
  at_capacity: "is at capacity",
  unverified: "is unverified",
  draining: "is draining",
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
   * A worker was removed from the pool because its enrollment token lost
   * its authority (revoked, expired, re-minted, or deleted). Unlike a
   * socket drop there is no grace window: the worker cannot re-enroll.
   */
  onWorkerRemoved?: (worker: WorkerSnapshot) => void;
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
  /**
   * The auth gate pass this serve hands each worker it enrolls
   * (`formatOrchestratorGatePass`), or undefined when it has none. A worker
   * without a swamp-club credential passes the gate on it
   * (design/surfaces/auth-gate.md, "Remote workers").
   */
  gatePass?: () => string | undefined;
  /** Test seam: overrides the modelMethodRun-backed transition runner. */
  runModelMethod?: ModelMethodRunner;
  /**
   * Test seam: the id of an enrollment token's definition in the local
   * repo, or null when this repo has none. Defaults to a definition lookup
   * by name.
   */
  findTokenDefinitionId?: (tokenName: string) => Promise<string | null>;
  /**
   * Test seam: reads a token's current record, or null when it does not
   * exist or no longer parses. Throws on read failures (I/O). Enrollment
   * reads it once after redemption and fails when it cannot. Defaults to a
   * datastore query.
   */
  readTokenRecord?: (tokenName: string) => Promise<EnrollmentToken | null>;
  /**
   * Test seam: the `expiresAt` to enforce, taken from the record read at
   * enrollment; null disables expiry enforcement for that worker.
   */
  readTokenExpiresAt?: (
    tokenName: string,
    record: EnrollmentToken,
  ) => Promise<string | null>;
  /**
   * Test seam: the `maxEnrollments` used for fleet naming, taken from the
   * record read at enrollment.
   */
  readTokenMaxEnrollments?: (
    tokenName: string,
    record: EnrollmentToken,
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
  /** Set by close(): no verify starts, and one in flight records nothing. */
  #closing = false;

  constructor(options: WorkerGatewayOptions) {
    this.#options = options;
    this.#sessions = options.sessionCredentials ??
      new SessionCredentialService();
    this.#graceWindowMs = options.graceWindowMs ?? DEFAULT_GRACE_WINDOW_MS;
    this.#runModelMethod = options.runModelMethod ??
      ((input) => this.#defaultRunModelMethod(input));
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

  /** The credential service the data plane authenticates against. */
  get sessions(): SessionCredentialService {
    return this.#sessions;
  }

  /** Clean up internal timers (dispatch credential refresh). */
  dispose(): void {
    this.#sessions.dispose();
  }

  /**
   * Shuts the gateway down (swamp-club#3854). Every connected worker is
   * removed, its socket closed and its disconnect queued, so the socket
   * closing later opens no grace window; timers are cleared and no
   * enrollment verify starts or records a result, so no transition begins
   * later. The transitions queued are then awaited, so the workers' status
   * is written before serve stops its datastore. The wait is bounded by
   * `deadlineMs`, so a write that never settles does not hold up the rest
   * of shutdown.
   */
  async close(deadlineMs: number = GATEWAY_CLOSE_DEADLINE_MS): Promise<void> {
    this.#closing = true;
    this.dispose();
    for (const entry of [...this.#workers.values()]) {
      if (entry.graceTimer !== undefined) {
        clearTimeout(entry.graceTimer);
        entry.graceTimer = undefined;
      }
      if (entry.expiryTimer !== undefined) {
        clearTimeout(entry.expiryTimer);
        entry.expiryTimer = undefined;
      }
      if (entry.channel === null) continue;
      const name = entry.name;
      this.#removeWorker(entry, "serve shutting down");
      // #recordDisconnected logs its own failures, so this never rejects.
      this.#recordTransition(
        "worker_disconnected",
        () => this.#recordDisconnected(name),
      ).catch(() => {});
    }
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((resolve) => {
      deadline = setTimeout(() => resolve("expired"), deadlineMs);
    });
    try {
      const outcome = await Promise.race([
        this.#transitions.settled().then(() => "settled" as const),
        expired,
      ]);
      if (outcome === "expired") {
        logger.warn(
          "Shutting down with {count} worker status write(s) still pending after {ms}ms",
          { count: this.#transitions.pending, ms: deadlineMs },
        );
      }
    } finally {
      clearTimeout(deadline);
    }
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
      (params, ctx) =>
        runDetached(() =>
          observeExecutionWork("enrollment.request", {
            "swamp.rpc.request_id": ctx.requestId,
          }, async (observation) => {
            // Authentication is server-owned; only an accepted peer may link
            // its context into the enrollment trace.
            ctx.responseTrace = observation.carrier;
            const result = await this.#handleEnroll(state, params);
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
   * Every token's current record, keyed by name, from one datastore scan.
   * A token that does not exist or no longer parses is absent. Read
   * failures propagate.
   */
  readTokenRecords(): Promise<Map<string, EnrollmentToken>> {
    return this.#scanTokenRecords();
  }

  /**
   * Each distinct token mint held by a pool member, including members
   * inside a reconnection grace window.
   */
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
   * Cut off every pool member enrolled on `tokenName` (all fleet members):
   * each is removed at once, its control and dispatch credentials are
   * revoked, and its control socket is closed. With `mint`, only members
   * enrolled on that mint are cut off, so a worker that enrolled on a newer
   * mint of the same name keeps its connection. Runs on the transition tail
   * so an enrollment already in progress lands first and is cut off too.
   * Returns the names of the removed workers.
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
   * Dispatch one execution request to a named worker. Resolves with the
   * worker's result; rejects with a WorkerNotDispatchableError when the
   * worker is unknown, busy, disconnected, unverified or draining, or when
   * the control socket drops mid-dispatch (the caller owns grace-window
   * failure semantics — see DispatchService).
   *
   * A dispatch moves a worker between idle and busy only. An unverified
   * worker takes a probe without leaving `unverified`: the enrollment
   * verification alone promotes it (swamp-club#3388).
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
    // An unverified worker is only ever sent a probe, and the probe's result
    // has not been judged yet: it holds a slot but stays unverified, so the
    // scheduler never sees it idle in between (swamp-club#3388).
    const unverified = entry.status === "unverified";
    if (!unverified) {
      entry.status = "busy";
    }
    // The slot is taken from here on, so everything below runs under the
    // finally that gives it back: a dispatch that fails before it reaches
    // the worker must not keep the slot (swamp-club#3294).
    try {
      // Kept in the same synchronous turn as the push: the dispatcher drops
      // its reservation here, and an await in between would count the
      // dispatch twice.
      options?.onRegistered?.();
      if (!unverified) {
        await this.#recordTransition("worker_busy", () =>
          this.#runModelMethod({
            typeArg: WORKER_MODEL_TYPE.normalized,
            definitionName: workerDefinitionName(name),
            methodName: "set_status",
            inputs: {
              status: "busy",
              activeDispatchIds: [...entry.activeDispatchIds],
            },
          }));
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
            () =>
              this.#runModelMethod({
                typeArg: WORKER_MODEL_TYPE.normalized,
                definitionName: workerDefinitionName(name),
                methodName: "set_status",
                inputs: { status: "idle" },
              }),
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
              this.#runModelMethod({
                typeArg: WORKER_MODEL_TYPE.normalized,
                definitionName: workerDefinitionName(name),
                methodName: "set_status",
                inputs: {
                  status: "busy",
                  activeDispatchIds: [...entry.activeDispatchIds],
                },
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
      // An unverified worker's enrollment probe can be refused for want of
      // a slot: one held by a dispatch from before a reconnect
      // (swamp-club#3388), or by a manual probe (swamp-club#3404). When the
      // last slot frees, probe again, whichever socket that dispatch used:
      // nothing else would.
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

    // Only a worker that asks gets the pass, which carries the serve key
    // holder's proof payload. Read once, so the refusal below and the reply
    // agree. A worker that needs a pass is refused before the token is
    // redeemed, so it spends no enrollment.
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

    return await this.#recordTransition<EnrollResult>("enroll", async () => {
      // The worker gave up on this attempt while it waited for its turn (its
      // enroll call timed out). Nothing is recorded yet, so skip it rather
      // than delay the live enrollments queued behind it (swamp-club#3405).
      if (state.channel.closed) {
        throw new ChannelClosedError(
          "control socket closed before enrollment began",
        );
      }
      // Redeem validates state, expiry, the secret, and allowance — and
      // appends a binding on first enrollment or re-auths a known machine.
      // Must happen before the already-connected check because the worker
      // name depends on maxEnrollments (fleet vs single-machine).
      const definitionId = await this.#requireTokenDefinition(name);
      try {
        await this.#runModelMethod({
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
      const record = await this.#readEnrolledRecord(name);
      const tokenCreatedAt = record.createdAt;
      const maxEnrollments =
        await this.#readTokenMaxEnrollments(name, record) ?? 1;
      const workerName = maxEnrollments === 1
        ? name
        : `${name}-${await fleetMemberSuffix(params.machineId)}`;

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

      const capacity = (params.resourceLimits?.capacity as number) ?? 1;
      // Under verify-on-enroll the worker is unverified until its probe
      // passes. The durable record says so too, so `swamp worker list`
      // matches the pool while the probe is pending (swamp-club#3501).
      const initialStatus = this.#options.verifyOnEnroll
        ? "unverified"
        : "idle";

      if (reconnecting) {
        existing.channel = state.channel;
        existing.capacity = capacity;
        await this.#runModelMethod({
          typeArg: WORKER_MODEL_TYPE.normalized,
          definitionName: workerDefinitionName(workerName),
          methodName: "set_status",
          inputs: initialStatus === "unverified"
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

      // The socket closed while the enrollment was being recorded, and its
      // close handler found no worker to disconnect. Disconnect it now, so it
      // gets the usual grace window instead of staying in the pool as a live
      // worker on a dead socket (swamp-club#3405).
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
        protocolVersion: REMOTE_PROTOCOL_VERSION,
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
    await this.#recordTransition("worker_draining", () =>
      this.#runModelMethod({
        typeArg: WORKER_MODEL_TYPE.normalized,
        definitionName: workerDefinitionName(workerName),
        methodName: "set_status",
        inputs: { status: "draining" },
      }));
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
      () =>
        this.#runModelMethod({
          typeArg: WORKER_MODEL_TYPE.normalized,
          definitionName: workerDefinitionName(name),
          methodName: "set_status",
          inputs: { status: "disconnected" },
        }),
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
   * `expired` state and cut the worker off. The worker's re-enrollment
   * attempt is rejected as expired, so there is no grace window: it is
   * removed and its credentials revoked at once.
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
    // here just delays the durable record catching up. A token whose
    // definition is gone has nothing to record, and running `expire` by
    // name would auto-create one.
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
   * Remove a worker whose token lost its authority. The pool entry goes
   * first, so the socket close this triggers is ignored by
   * #handleSocketClosed instead of opening a grace window. Closing the
   * channel rejects in-flight dispatches now; DispatchService then sees the
   * worker gone and applies its usual lost-worker semantics.
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
      await this.#runModelMethod({
        typeArg: WORKER_MODEL_TYPE.normalized,
        definitionName: workerDefinitionName(workerName),
        methodName: "set_status",
        inputs: { status: "disconnected" },
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
    if (!entry || this.#closing) return;
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
      if (!entry || entry.channel === null || this.#closing) return;
      if (probeResult.ok) {
        if (entry.status !== "draining") {
          await this.#recordTransition("verify_passed", async () => {
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
        }
      } else {
        await this.#recordTransition("verify_failed", async () => {
          entry.verifyFailureReason = probeResult.failureReason;
          await this.#runModelMethod({
            typeArg: "swamp/worker",
            definitionName: workerDefinitionName(workerName),
            methodName: "set_status",
            inputs: {
              status: "unverified",
              activeDispatchIds: [...entry.activeDispatchIds],
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
      if (!entry || entry.channel === null || this.#closing) return;
      const reason = error instanceof Error ? error.message : String(error);
      await this.#recordTransition("verify_failed", async () => {
        entry.verifyFailureReason = reason;
        await this.#runModelMethod({
          typeArg: "swamp/worker",
          definitionName: workerDefinitionName(workerName),
          methodName: "set_status",
          inputs: {
            status: "unverified",
            activeDispatchIds: [...entry.activeDispatchIds],
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
      capacity: entry.capacity,
      activeDispatchIds: [...entry.activeDispatchIds],
      verifyFailureReason: entry.verifyFailureReason,
    };
  }

  /**
   * Append a transition to the serialized tail. Every durable pool/token
   * mutation flows through here, preserving the sole-writer invariant.
   * `operation` labels its span (swamp-club#3755).
   */
  #recordTransition<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return this.#transitions.run(operation, fn);
  }

  /**
   * Reads the record redeem just validated. Redeem read the same record a
   * moment ago, so a failure here is transient: the enrollment fails and
   * the worker retries, rather than joining the pool without a known mint
   * or expiry deadline.
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
   * The id of the token's definition in this repo. Redeem runs pinned to
   * it, so enrollment never creates a token definition (swamp-club#3074).
   * Without one, a token whose record is already here was minted on an HA
   * peer whose definition this replica has not pulled yet: that refusal is
   * retryable. Otherwise the token does not exist.
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

  /** Finds one token's current record; null when there is no usable one. */
  async #findTokenRecord(tokenName: string): Promise<EnrollmentToken | null> {
    return (await this.#scanTokenRecords()).get(tokenName) ?? null;
  }

  /**
   * Reads every token record in the datastore, keyed by name. Records that
   * are deleted, renamed, do not parse, or that the datastore could not
   * materialise are skipped. Other read failures propagate.
   */
  async #scanTokenRecords(): Promise<Map<string, EnrollmentToken>> {
    const records = new Map<string, EnrollmentToken>();
    const dataItems = await this.#options.repoContext.unifiedDataRepo
      .findAllForType(ENROLLMENT_TOKEN_MODEL_TYPE);
    for (const { data, modelType, modelId } of dataItems) {
      if (data.isRenamed || data.isDeleted) continue;
      if (data.name !== TOKEN_DATA_NAME) continue;
      let content: Uint8Array | null;
      try {
        content = await this.#options.repoContext.unifiedDataRepo
          .getContent(modelType, modelId, data.name);
      } catch (error) {
        // One record the datastore could not materialise is left out
        // rather than failing every enrollment (swamp-club#3617).
        if (!isUnreadableContentError(error)) throw error;
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
    return records;
  }

  async #defaultRunModelMethod(
    input: Parameters<ModelMethodRunner>[0],
  ): Promise<void> {
    const deps = await createWorkerModelRunDeps(
      this.#options.repoDir,
      this.#options.repoContext,
      { definitionType: ModelType.create(input.typeArg) },
    );
    const libCtx = createLibSwampContext({
      openUnitOfWork: repoUnitOfWorkFactory(this.#options.repoContext),
    });
    // Control-plane bookkeeping (enrollment tokens): never held to a run's
    // vault scope (swamp-club#2676).
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
