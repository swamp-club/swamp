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

import { AsyncLocalStorage } from "node:async_hooks";
import { runGeneratorWithoutVaultAccess } from "../domain/vaults/run_vault_access.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import {
  checkpointOpenUnitOfWork,
  repoUnitOfWorkFactory,
} from "../infrastructure/persistence/repo_unit_of_work.ts";
import { createLibSwampContext } from "../libswamp/context.ts";
import { createWorkerModelRunDeps } from "../libswamp/worker/run_deps.ts";
import { ensureWorkerDefinition } from "../libswamp/worker/ensure_definition.ts";
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
  type RotateTokenResult,
  type RpcStreamEvent,
  type SessionRefreshResult,
  shipsReferencesOnly,
  SUPPORTED_REMOTE_PROTOCOL_VERSIONS,
  withoutQuotedNames,
  WorkerCapability,
  WorkerMethod,
} from "../domain/remote/protocol.ts";
import { SessionCredentialService } from "../domain/remote/session_credential.ts";
import {
  type SetStatusArgs,
  WORKER_MODEL_TYPE,
  workerDefinitionName,
  type WorkerEnrollment,
} from "../domain/models/worker/worker_model.ts";
import type { OrchestratorOwner } from "../domain/models/worker/orchestrator_owner.ts";
import {
  admitsMachine,
  deliverablePredecessor,
  ENROLLMENT_TOKEN_MODEL_TYPE,
  type EnrollmentBindingCutoffCause,
  enrollmentMintFor,
  type EnrollmentToken,
  enrollmentTokenClosed,
  EnrollmentTokenSchema,
  type MaxEnrollments,
  presentedTokenMint,
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
 * an unmatched redeem rejection reaches the worker as a retryable
 * redeem_failed with a generic message: a vault error names serve's paths
 */
const REDEEM_FAILURE_CODES: readonly [string, string][] = [
  ["has been revoked", "token_revoked"],
  ["has expired", "token_expired"],
  ["does not match", "token_mismatch"],
  ["does not exist", "token_not_found"],
  ["allowance exhausted", "enrollment_allowance_exhausted"],
];

function codedRedeemFailure(error: unknown): unknown {
  if (
    !(error instanceof Error) || error instanceof RpcError ||
    error instanceof ChannelClosedError
  ) {
    return error;
  }
  const reason = withoutQuotedNames(error.message);
  for (const [phrase, code] of REDEEM_FAILURE_CODES) {
    if (reason.includes(phrase)) {
      return new RpcError({ code, message: error.message });
    }
  }
  logger.warn("Could not verify an enrollment token: {error}", {
    error: error.message,
  });
  return new RpcError({
    code: "redeem_failed",
    message:
      "The orchestrator could not verify the enrollment token; retry the connection",
  });
}

const CUTOFF_REASONS: Record<EnrollmentBindingCutoffCause, string> = {
  revoked: "revoked",
  reminted: "re-minted",
  deleted: "deleted",
  expired: "expired",
  retired: "retired by a rotation",
};

/** setTimeout overflows past 2^31-1 ms; longer waits are chained. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export const DEFAULT_ROTATION_DELIVERY_TIMEOUT_MS = 10_000;

/** enrollment pre-checks run before the caller is authenticated, so only this many at once */
export const MAX_ENROLLMENT_PRECHECKS = 4;

const ROTATION_REFUSALS: Record<string, string> = {
  invalid_token: "refused a malformed token",
  invalid_params: "refused a malformed request",
  token_rename_refused: "refused a token under another name",
};

function rotationRefusalReason(code: string): string {
  return ROTATION_REFUSALS[code] ?? `refused (${code})`;
}

export interface TokenRotationReport {
  tokenName: string;
  /** the successor credential `<name>.<secret>`, for hosts it did not reach */
  token: string;
  expiresAt: string;
  predecessorExpiresAt: string | null;
  rotated: { worker: string; persisted: boolean }[];
  notRotated: { worker: string; reason: string }[];
  /** bound machines with no pool member, still able to enroll on the old secret */
  unconnectedBindings: number;
  /** bound machines with no pool member whose secret this rotation retired */
  retiredBindings: number;
}

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

async function workerNameFor(
  tokenName: string,
  machineId: string,
  maxEnrollments: MaxEnrollments,
): Promise<string> {
  return maxEnrollments === 1
    ? tokenName
    : `${tokenName}-${await fleetMemberSuffix(machineId)}`;
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
  /** the optional verbs the worker declared at enrollment */
  capabilities: readonly string[];
  /** the machine its token binding names */
  machineId?: string;
  channel: RpcChannel | null;
  closeSocket: (() => void) | null;
  status: "idle" | "busy" | "unverified" | "draining";
  capacity: number;
  activeDispatchIds: string[];
  verifyFailureReason?: string;
  verifying?: boolean;
  verifyAgain?: boolean;
  /** this enrollment's probe has not started yet; `verifying` covers it from then */
  probeOwed?: boolean;
  /**
   * A probe was refused for want of a slot while the unverified worker's
   * enrollment verification was running. The next dispatch to end with no
   * slots held probes it again.
   */
  probeRefusedForCapacity?: boolean;
  graceTimer?: ReturnType<typeof setTimeout>;
  expiryTimer?: ReturnType<typeof setTimeout>;
  /** the deadline expiryTimer is armed for */
  expiresAtMs?: number;
}

interface RotationTarget {
  name: string;
  instanceUuid: string;
  tokenCreatedAt: string;
  machineId: string | undefined;
  canRotate: boolean;
  channel: RpcChannel | null;
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
  | "version_changed"
  | "state_unrecorded";

const NOT_DISPATCHABLE_PHRASES: Record<WorkerNotDispatchableReason, string> = {
  not_in_pool: "is not in the pool",
  disconnected: "is disconnected",
  at_capacity: "is at capacity",
  unverified: "is unverified",
  draining: "is draining",
  version_changed:
    "re-enrolled at another protocol version than its dispatch was built for",
  state_unrecorded: "has no state record this serve could write",
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

export type TokenSecretPurpose = "deliver" | "verify";

export interface WorkerGatewayOptions {
  /**
   * whether this serve node takes workers: false on a team-mode follower. A
   * refused worker retries and reaches the leader or this node once it leads.
   * Absent, every node takes them.
   */
  acceptsWorkers?: () => boolean;
  /** stamped on every worker record this gateway writes, so another serve's sweep leaves it while this process lives */
  owner?: OrchestratorOwner;
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
  onWorkerVerifyFailed?: (worker: WorkerSnapshot) => void;
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
  /** reads a token's plaintext to hand a rotation to workers, or to check a presented secret */
  readTokenSecret?: (
    vaultName: string,
    secretKey: string,
    purpose: TokenSecretPurpose,
  ) => Promise<string>;
  rotationDeliveryTimeoutMs?: number;
  runModelMethod?: ModelMethodRunner;
  /** absent with an injected runModelMethod, which then creates definitions itself */
  ensureWorkerDefinition?: (workerName: string) => Promise<void>;
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
  /** publishes worker records written outside a run, so a peer's pull sees a live enrollment */
  pushWorkerRecords?: () => Promise<void>;
}

interface SocketState {
  channel: RpcChannel;
  closeSocket: (() => void) | null;
  workerName: string | null;
  forwardedPrefix: string | undefined;
}

// fails the definition name pattern, so it is never a worker's key
const WORKER_RECORDS_PUSH_KEY = "push:worker-records";

export class WorkerGateway {
  readonly #options: WorkerGatewayOptions;
  readonly #workers = new Map<string, WorkerEntry>();
  readonly #sessions: SessionCredentialService;
  readonly #graceWindowMs: number;
  readonly #runModelMethod: ModelMethodRunner;
  readonly #ensureWorkerDefinition:
    | ((workerName: string) => Promise<void>)
    | undefined;
  #prechecksInFlight = 0;
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
  /** Serializes every token/pool/lease transition, and each worker's own writes on its key (sole-writer rule). */
  readonly #transitions = new TransitionTail("gateway");
  readonly #runningTransition = new AsyncLocalStorage<{ settled: boolean }>();
  /** counted: a --server rotation and a pass can both be delivering to one worker */
  readonly #deliveriesInFlight = new Map<string, number>();
  /** instanceUuid to the mint it refused, so a pass never offers it again */
  readonly #rotationRefusals = new Map<string, string>();
  #publishQueued = false;

  constructor(options: WorkerGatewayOptions) {
    this.#options = options;
    this.#sessions = options.sessionCredentials ??
      new SessionCredentialService();
    this.#graceWindowMs = options.graceWindowMs ?? DEFAULT_GRACE_WINDOW_MS;
    this.#runModelMethod = options.runModelMethod ??
      ((input) => this.#defaultRunModelMethod(input));
    this.#ensureWorkerDefinition = options.ensureWorkerDefinition ??
      (options.runModelMethod
        ? undefined
        : (workerName) =>
          ensureWorkerDefinition(
            options.repoDir,
            options.repoContext,
            workerName,
          ));
    const workerStatus = options.runModelMethod
      ? methodRunnerWorkerStatusStore(options.runModelMethod)
      : new WorkerStatusLedger(
        options.repoContext,
        methodRunnerWorkerStatusStore(this.#runModelMethod),
        this.#ensureWorkerDefinition,
      );
    const owner = options.owner;
    const stamp = (args: SetStatusArgs) =>
      owner === undefined ? args : { ...args, owner };
    const reassert = workerStatus.reassert?.bind(workerStatus);
    // a removed worker's disconnect passes the enrollment it captured before removal
    this.#workerStatus = {
      recordStatus: async (workerName, args, live) => {
        await workerStatus.recordStatus(
          workerName,
          stamp(args),
          live ?? this.#liveEnrollment(workerName),
        );
        // a departure left unpublished is lost to the next pull that replaces its marker
        if (args.status === "draining" || args.status === "disconnected") {
          this.#publishWorkerRecords();
        }
      },
      ...(reassert === undefined ? {} : {
        reassert: (workerName, args, live) =>
          reassert(workerName, stamp(args), live),
      }),
    };
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
  attachTransport(
    transport: RpcTransport,
    close?: () => void,
    forwardedPrefix?: string,
  ): {
    feed: (raw: string) => boolean;
    closed: () => void;
  } {
    const state: SocketState = {
      channel: new RpcChannel(transport),
      closeSocket: close ?? null,
      workerName: null,
      forwardedPrefix,
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

  /**
   * a pull can bring a peer's older record of a worker this serve holds; each
   * connected worker whose record says it is gone is written again from its
   * connection, numbered above what the pull brought
   */
  async reassertConnected(): Promise<number> {
    const reassert = this.#workerStatus.reassert;
    if (reassert === undefined) return 0;
    let rewritten = 0;
    for (const entry of [...this.#workers.values()]) {
      if (entry.channel === null) continue;
      const name = entry.name;
      const live = this.#enrollmentOf(entry);
      try {
        await this.#recordWorkerWrite("worker_reassert", name, async () => {
          const current = this.#workers.get(name);
          if (
            current === undefined || current.channel === null ||
            current.instanceUuid !== live.instanceUuid
          ) return;
          const decision = await reassert(name, {
            status: current.status,
            activeDispatchIds: [...current.activeDispatchIds],
            ...(current.status === "unverified"
              ? { verifyFailureReason: current.verifyFailureReason }
              : {}),
          }, live);
          if (decision === "rewrite") {
            rewritten++;
            logger.info(
              "Worker {worker} record was restored from its live connection",
              { worker: name },
            );
          } else if (decision === "live_elsewhere") {
            logger.warn(
              "Worker {worker} is recorded as live on another serve as well as connected here; leaving that record",
              { worker: name },
            );
          }
        });
      } catch (error) {
        logger.warn(
          "Failed to restore the record of worker {worker}: {error}",
          {
            worker: name,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
    if (rewritten > 0) await this.#pushWorkerRecords();
    return rewritten;
  }

  async #pushWorkerRecords(): Promise<void> {
    const push = this.#options.pushWorkerRecords;
    if (push === undefined) return;
    try {
      await push();
    } catch (error) {
      logger.warn(
        "Failed to publish worker records; the next push carries them: {error}",
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  /** runs fn in order with token and pool-admission turns, so no enrollment interleaves */
  serializeWorkerWrites<T>(fn: () => Promise<T>): Promise<T> {
    return this.#recordTransition("settle_left_workers", fn);
  }

  /**
   * runs a token record write in order with redeem and rotate, which read and
   * rewrite the same record on this tail
   */
  serializeTokenWrite<T>(fn: () => Promise<T>): Promise<T> {
    // called from a transition still running, fn already holds the tail and
    // queueing would wait on itself; work that outlived its transition queues.
    // Assumes a transition's own writes run one after another, never in parallel
    const running = this.#runningTransition.getStore();
    if (running !== undefined && !running.settled) return fn();
    return this.#recordTransition("token_write", fn);
  }

  /**
   * a token method run's write commits inside its turn, even when the run then
   * throws: committed at the end of its run instead, it would land after a
   * later turn's commit and replace it, since a latest write has no version check
   */
  orderTokenMethodRun<T>(fn: () => Promise<T>): Promise<T> {
    return this.serializeTokenWrite(async () => {
      try {
        return await fn();
      } finally {
        await this.#commitInTurn();
      }
    });
  }

  /** a write already happened, so a failed commit must not fail the run */
  async #commitInTurn(): Promise<void> {
    try {
      const outcome = await checkpointOpenUnitOfWork(
        this.#options.repoContext,
      );
      if (outcome === "refused") {
        logger.warn(
          "An enrollment token write was refused a commit in its turn; it commits or is discarded when its run ends",
        );
      }
    } catch (error) {
      logger.warn(
        "Could not commit an enrollment token write in its turn; the run's end commit tries again: {error}",
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
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
        const live = this.#enrollmentOf(entry);
        this.#removeWorker(entry, `enrollment token ${CUTOFF_REASONS[cause]}`);
        removed.push(entry.name);
        if (wasConnected) {
          await this.#recordWorkerWrite(
            "worker_disconnected",
            entry.name,
            () => this.#recordDisconnected(entry.name, live),
          );
        }
      }
      return removed;
    });
  }

  /**
   * three phases so enrollments never queue behind a slow worker: rotate on the
   * tail, deliver off it, re-stamp on it; the verdict keeps predecessor workers
   */
  async rotateToken(
    tokenName: string,
    options?: { durationMs?: number },
  ): Promise<TokenRotationReport> {
    const readTokenSecret = this.#options.readTokenSecret;
    if (readTokenSecret === undefined) {
      throw new Error("This orchestrator cannot read enrollment token secrets");
    }
    const { definitionId, record, targets } = await this.#recordTransition(
      "rotate_token",
      async () => {
        const definitionId = await this.#requireTokenDefinition(tokenName);
        await this.#runModelMethod({
          typeArg: ENROLLMENT_TOKEN_MODEL_TYPE.normalized,
          definitionName: tokenName,
          methodName: "rotate",
          inputs: options?.durationMs !== undefined
            ? { durationMs: options.durationMs }
            : {},
          expectedDefinitionId: definitionId,
        });
        const record = await this.#readTokenRecord(tokenName);
        if (record === null) {
          throw new Error(
            `Enrollment token '${tokenName}' could not be read after rotation`,
          );
        }
        const targets = this.#rotationTargets(
          (entry) => entry.tokenName === tokenName,
        );
        return { definitionId, record, targets };
      },
    );

    let secret: string;
    try {
      secret = await readTokenSecret(
        record.vaultName,
        record.secretKey,
        "deliver",
      );
    } catch (error) {
      logger.warn("Could not read the rotated secret of {token}: {error}", {
        token: tokenName,
        error: error instanceof Error ? error.message : String(error),
      });
      // the vault error stays in serve's log: it can name a path, which the
      // client sanitizer would turn into a message without the reveal hint
      throw new Error(
        `Enrollment token '${tokenName}' was rotated, but its new secret could not be read; read it with: swamp worker token reveal ${tokenName}`,
      );
    }
    return await this.#deliverRotation(
      tokenName,
      definitionId,
      record,
      targets,
      `${tokenName}.${secret}`,
    );
  }

  /** observed is the caller's read, so a token with nobody to reach costs no transition */
  async deliverCurrentMint(
    tokenName: string,
    observed: EnrollmentToken,
  ): Promise<TokenRotationReport | null> {
    const readTokenSecret = this.#options.readTokenSecret;
    if (readTokenSecret === undefined) return null;
    if (this.#undeliveredHolders(tokenName, observed).length === 0) {
      return null;
    }
    const prepared = await this.#recordTransition(
      "deliver_rotation",
      async () => {
        const definitionId = await this.#findTokenDefinitionId(tokenName);
        if (definitionId === null) return null;
        const record = await this.#readTokenRecord(tokenName);
        if (record === null) return null;
        const holders = new Set(this.#undeliveredHolders(tokenName, record));
        if (holders.size === 0) return null;
        const targets = this.#rotationTargets((entry) => holders.has(entry));
        // claimed on the tail, so a concurrent pass skips them while this one
        // reads the secret
        this.#markDelivering(targets);
        return { definitionId, record, targets };
      },
    );
    if (prepared === null) return null;
    const { definitionId, record, targets } = prepared;

    let report: TokenRotationReport;
    try {
      let secret: string;
      try {
        secret = await readTokenSecret(
          record.vaultName,
          record.secretKey,
          "deliver",
        );
      } catch (error) {
        logger.warn(
          "Could not read the current secret of {token} to deliver it: {error}",
          {
            token: tokenName,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return null;
      }
      report = await this.#deliverRotation(
        tokenName,
        definitionId,
        record,
        targets,
        `${tokenName}.${secret}`,
      );
    } finally {
      this.#unmarkDelivering(targets);
    }
    for (const worker of report.rotated) {
      logger.info(
        "Delivered the rotated enrollment token {token} to {worker}",
        {
          token: tokenName,
          worker: worker.worker,
        },
      );
    }
    for (const worker of report.notRotated) {
      const properties = {
        token: tokenName,
        worker: worker.worker,
        reason: worker.reason,
      };
      const message =
        "Could not deliver the rotated enrollment token {token} to {worker}: {reason}";
      // a member in its grace window is retried every pass until it returns
      if (worker.reason === "disconnected") logger.debug(message, properties);
      else logger.warn(message, properties);
    }
    return report;
  }

  /** members on the predecessor mint that no delivery is reaching or has given up on */
  #undeliveredHolders(
    tokenName: string,
    record: EnrollmentToken,
  ): WorkerEntry[] {
    const predecessor = deliverablePredecessor(record);
    if (predecessor === undefined) return [];
    const predecessorMs = Date.parse(predecessor.createdAt);
    return [...this.#workers.values()].filter((entry) =>
      entry.tokenName === tokenName &&
      Date.parse(entry.tokenCreatedAt) === predecessorMs &&
      !this.#deliveriesInFlight.has(entry.instanceUuid) &&
      this.#rotationRefusals.get(entry.instanceUuid) !== record.createdAt
    );
  }

  #markDelivering(targets: readonly RotationTarget[]): void {
    for (const { instanceUuid } of targets) {
      this.#deliveriesInFlight.set(
        instanceUuid,
        (this.#deliveriesInFlight.get(instanceUuid) ?? 0) + 1,
      );
    }
  }

  #unmarkDelivering(targets: readonly RotationTarget[]): void {
    for (const { instanceUuid } of targets) {
      const remaining = (this.#deliveriesInFlight.get(instanceUuid) ?? 1) - 1;
      if (remaining > 0) this.#deliveriesInFlight.set(instanceUuid, remaining);
      else this.#deliveriesInFlight.delete(instanceUuid);
    }
  }

  #rotationTargets(include: (entry: WorkerEntry) => boolean): RotationTarget[] {
    return [...this.#workers.values()].filter(include).map((entry) => ({
      name: entry.name,
      instanceUuid: entry.instanceUuid,
      tokenCreatedAt: entry.tokenCreatedAt,
      machineId: entry.machineId,
      canRotate: entry.capabilities.includes(WorkerCapability.tokenRotate),
      channel: entry.channel,
    }));
  }

  async #deliverRotation(
    tokenName: string,
    definitionId: string,
    record: EnrollmentToken,
    targets: RotationTarget[],
    token: string,
  ): Promise<TokenRotationReport> {
    const present = new Set(
      [...this.#workers.values()].map((entry) => entry.instanceUuid),
    );
    for (const uuid of this.#rotationRefusals.keys()) {
      if (!present.has(uuid)) this.#rotationRefusals.delete(uuid);
    }
    const expiresAtMs = Date.parse(record.expiresAt);
    const timeoutMs = this.#options.rotationDeliveryTimeoutMs ??
      DEFAULT_ROTATION_DELIVERY_TIMEOUT_MS;

    const notRotated: { worker: string; reason: string }[] = [];
    const acknowledged: {
      name: string;
      instanceUuid: string;
      machineId: string | undefined;
      persisted: boolean;
    }[] = [];
    await Promise.all(targets.map(async (target) => {
      const channel = target.channel;
      if (channel === null || channel.closed) {
        notRotated.push({ worker: target.name, reason: "disconnected" });
        return;
      }
      if (!target.canRotate) {
        this.#rotationRefusals.set(target.instanceUuid, record.createdAt);
        notRotated.push({
          worker: target.name,
          reason: "its swamp version cannot take a rotated token",
        });
        return;
      }
      this.#markDelivering([target]);
      try {
        const result = await channel.call<RotateTokenResult>(
          WorkerMethod.rotateToken,
          { token, expiresAtMs, mintMs: Date.parse(record.createdAt) },
          { timeoutMs },
        );
        acknowledged.push({
          name: target.name,
          instanceUuid: target.instanceUuid,
          machineId: target.machineId,
          persisted: result?.persisted === true,
        });
      } catch (error) {
        if (error instanceof RpcError) {
          this.#rotationRefusals.set(target.instanceUuid, record.createdAt);
        }
        notRotated.push({
          worker: target.name,
          reason: error instanceof RpcError
            ? rotationRefusalReason(error.code)
            : error instanceof ChannelClosedError
            ? "disconnected"
            : "no acknowledgement",
        });
      } finally {
        this.#unmarkDelivering([target]);
      }
    }));

    const rotated = await this.#recordTransition(
      "restamp_rotated_workers",
      async () => {
        const restamped: { worker: string; persisted: boolean }[] = [];
        for (const ack of acknowledged) {
          const entry = this.#workers.get(ack.name);
          // a later rotation may already have moved it; never move it back
          if (
            entry?.tokenName === tokenName &&
            Date.parse(entry.tokenCreatedAt) >= Date.parse(record.createdAt)
          ) {
            restamped.push({ worker: ack.name, persisted: ack.persisted });
            continue;
          }
          if (
            entry === undefined || entry.tokenName !== tokenName ||
            entry.instanceUuid !== ack.instanceUuid
          ) {
            notRotated.push({
              worker: ack.name,
              reason: "reconnected during rotation",
            });
            continue;
          }
          entry.tokenCreatedAt = record.createdAt;
          if (entry.expiryTimer !== undefined) {
            clearTimeout(entry.expiryTimer);
            entry.expiryTimer = undefined;
          }
          this.#scheduleTokenExpiry(entry, expiresAtMs);
          restamped.push({ worker: ack.name, persisted: ack.persisted });
          try {
            await this.#recordWorkerWrite(
              "worker_restamp",
              entry.name,
              () =>
                this.#workerStatus.recordStatus(entry.name, {
                  status: entry.status,
                  activeDispatchIds: [...entry.activeDispatchIds],
                  tokenCreatedAt: record.createdAt,
                }),
            );
          } catch (error) {
            logger.warn(
              "Failed to record the rotated mint for {worker}: {error}",
              {
                worker: entry.name,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }
        // a shortened rotation clamps the predecessor's deadline, so a worker
        // still on it must not outlive the clamp
        const predecessor = record.predecessor;
        if (predecessor !== undefined) {
          const clampMs = Date.parse(predecessor.expiresAt);
          for (const entry of this.#workers.values()) {
            if (
              entry.tokenName === tokenName &&
              Date.parse(entry.tokenCreatedAt) ===
                Date.parse(predecessor.createdAt) &&
              (entry.expiresAtMs === undefined || clampMs < entry.expiresAtMs)
            ) {
              if (entry.expiryTimer !== undefined) {
                clearTimeout(entry.expiryTimer);
                entry.expiryTimer = undefined;
              }
              this.#scheduleTokenExpiry(entry, clampMs);
            }
          }
        }
        // the binding follows the machine's token file, which a persisted
        // acknowledgement wrote whatever became of its pool entry since
        const saved = new Set(
          acknowledged.flatMap((ack) =>
            ack.persisted && ack.machineId !== undefined ? [ack.machineId] : []
          ),
        );
        if (saved.size > 0) {
          try {
            await this.#runModelMethod({
              typeArg: ENROLLMENT_TOKEN_MODEL_TYPE.normalized,
              definitionName: tokenName,
              methodName: "rebind",
              inputs: {
                machineIds: [...saved],
                mint: record.createdAt,
              },
              expectedDefinitionId: definitionId,
            });
          } catch (error) {
            logger.warn(
              "Failed to record the rotated mint on the bindings of {token}: {error}",
              {
                token: tokenName,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }
        return restamped;
      },
    );

    // a member still on a mint older than the predecessor held a secret this
    // rotation retired: revalidation cuts it off unless it took the successor
    const predecessorMs = record.predecessor === undefined
      ? undefined
      : Date.parse(record.predecessor.createdAt);
    const isRetired = (mint: string | undefined) =>
      predecessorMs !== undefined && mint !== undefined &&
      Date.parse(mint) < predecessorMs;
    const retiredWorkers = new Set(
      targets.filter((t) => isRetired(t.tokenCreatedAt)).map((t) => t.name),
    );
    const reported = notRotated.map((entry) =>
      retiredWorkers.has(entry.worker)
        ? {
          worker: entry.worker,
          reason:
            `${entry.reason}; its token was retired by this rotation, so it will be disconnected`,
        }
        : entry
    );
    // a member is classified from its pool entry; only machines with no member count
    const members = new Set(targets.map((t) => t.machineId));
    const unattended = record.bindings.filter((b) => !members.has(b.machineId));
    return {
      tokenName,
      token,
      expiresAt: record.expiresAt,
      predecessorExpiresAt: record.predecessor?.expiresAt ?? null,
      rotated,
      notRotated: reported,
      unconnectedBindings: unattended.filter((b) => !isRetired(b.mint)).length,
      retiredBindings: unattended.filter((b) => isRetired(b.mint)).length,
    };
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
        try {
          await this.#recordWorkerWrite(
            "worker_busy",
            name,
            () =>
              this.#workerStatus.recordStatus(name, {
                status: "busy",
                activeDispatchIds: [...entry.activeDispatchIds],
              }),
          );
        } catch (error) {
          // refused unsent, so the step waits for its queue timeout instead of failing
          logger.warn(
            "Failed to record {worker} busy; refusing the dispatch: {error}",
            {
              worker: name,
              error: error instanceof Error ? error.message : String(error),
            },
          );
          throw new WorkerNotDispatchableError(name, "state_unrecorded");
        }
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
          await this.#recordWorkerWrite(
            "worker_idle",
            name,
            () => this.#workerStatus.recordStatus(name, { status: "idle" }),
          ).catch((error: unknown) => {
            logger.warn("Failed to record idle status for {worker}: {error}", {
              worker: name,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        } else {
          await this.#recordWorkerWrite(
            "worker_busy",
            name,
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
    // one enrollment, one answer, though a reload may change it meanwhile
    const verifyOnEnroll = this.#options.verifyOnEnroll === true;

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
    await preparing(() =>
      this.#prepareWorkerDefinition(
        state,
        name,
        secret,
        params.machineId,
        signal,
      )
    );
    const enrolled = await this.#recordTransition<EnrollResult>(
      "enroll",
      async () => {
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
        // a machine that redeemed the predecessor of a rotation is bound to that
        // mint and keeps its deadline
        const mint = enrollmentMintFor(record, params.machineId);
        const tokenCreatedAt = mint.createdAt;
        const onPredecessor = tokenCreatedAt !== record.createdAt;
        const maxEnrollments =
          await preparing(() => this.#readTokenMaxEnrollments(name, record)) ??
            1;
        const workerName = await workerNameFor(
          name,
          params.machineId,
          maxEnrollments,
        );

        // the worker gave up during redeem: stop before the pool or definition
        // changes; redeem bound its machine, which re-authenticates next attempt
        // without spending another enrollment
        if (state.channel.closed || signal.aborted) {
          throw new ChannelClosedError(
            "control socket closed before enrollment was recorded",
          );
        }

        // held on the worker's key until it is wired, so a dispatch's busy write
        // and the work it sends wait for the channel's handlers
        return await this.#recordWorkerWrite<EnrollResult>(
          "worker_enroll",
          workerName,
          async () => {
            const existing = this.#workers.get(workerName);
            if (
              existing && existing.channel !== null &&
              !existing.channel.closed &&
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
            const initialStatus = verifyOnEnroll ? "unverified" : "idle";

            if (reconnecting) {
              existing.channel = state.channel;
              existing.capacity = capacity;
              existing.protocolVersion = params.protocolVersion;
              existing.capabilities = params.capabilities ?? [];
              existing.machineId = params.machineId;
              await preparing(() =>
                this.#workerStatus.recordStatus(
                  workerName,
                  {
                    ...(initialStatus === "unverified"
                      ? {
                        status: "unverified",
                        activeDispatchIds: [...existing.activeDispatchIds],
                      }
                      : existing.activeDispatchIds.length > 0
                      ? {
                        status: "busy",
                        activeDispatchIds: [...existing.activeDispatchIds],
                      }
                      : { status: "idle" }),
                    tokenCreatedAt,
                  },
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
                  tokenCreatedAt,
                  ...(this.#options.owner
                    ? { owner: this.#options.owner }
                    : {}),
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
              capabilities: params.capabilities ?? [],
              machineId: params.machineId,
              channel: state.channel,
              closeSocket: state.closeSocket,
              status: initialStatus,
              capacity,
              activeDispatchIds: [],
            };
            if (reconnecting && verifyOnEnroll) {
              entry.status = "unverified";
              // A refusal or failure from before the reconnect is answered by the
              // probe this enrollment starts.
              entry.probeRefusedForCapacity = false;
              entry.verifyFailureReason = undefined;
            }
            entry.probeOwed = verifyOnEnroll &&
              this.#options.verifyWorker !== undefined;
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
            const expiresAt = onPredecessor
              ? mint.expiresAt
              : await this.#readTokenExpiresAt(name, record);
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

            if (verifyOnEnroll && this.#options.verifyWorker) {
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
              ...(state.forwardedPrefix === undefined
                ? {}
                : { forwardedPrefix: state.forwardedPrefix }),
            };
          },
        ).catch((error: unknown) => {
          // an enrollment that failed before its probe started owes none
          const entry = this.#workers.get(workerName);
          if (entry) entry.probeOwed = false;
          throw error;
        });
      },
    );
    this.#publishWorkerRecords();
    return enrolled;
  }

  /**
   * queued on its own chain so the enrollment's reply never waits on the
   * datastore; settled() still covers it
   */
  #publishWorkerRecords(): void {
    if (this.#options.pushWorkerRecords === undefined) return;
    // a push not yet started carries every write made before it starts
    if (this.#publishQueued) return;
    this.#publishQueued = true;
    // #pushWorkerRecords logs its own failures, so this never rejects
    this.#transitions.run(
      "worker_records_push",
      () => {
        this.#publishQueued = false;
        return this.#pushWorkerRecords();
      },
      WORKER_RECORDS_PUSH_KEY,
    ).catch(() => {});
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
    await this.#recordWorkerWrite(
      "worker_draining",
      workerName,
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
    const live = this.#enrollmentOf(entry);

    const recordDisconnect = this.#recordWorkerWrite(
      "worker_disconnected",
      name,
      () =>
        this.#workerStatus.recordStatus(
          name,
          { status: "disconnected" },
          live,
        ),
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
    entry.expiresAtMs = deadlineMs;
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
        inputs: { mint: entry.tokenCreatedAt },
        expectedDefinitionId: definitionId,
      });
    }).catch((error: unknown) => {
      logger.warn("Failed to record token expiry for {worker}: {error}", {
        worker: workerName,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const wasConnected = entry.channel !== null;
    const live = this.#enrollmentOf(entry);
    this.#removeWorker(entry, "enrollment token expired");
    if (wasConnected) {
      // #recordDisconnected logs its own failures, so this never rejects.
      this.#recordWorkerWrite(
        "worker_disconnected",
        workerName,
        () => this.#recordDisconnected(workerName, live),
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
   * run it on the worker's key. Bookkeeping only: failures are logged.
   */
  async #recordDisconnected(
    workerName: string,
    live: WorkerEnrollment,
  ): Promise<void> {
    try {
      await this.#workerStatus.recordStatus(workerName, {
        status: "disconnected",
      }, live);
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
    entry.probeOwed = false;
    let failed = false;
    this.#runEnrollmentVerify(workerName).then((result) => {
      failed = result;
    }).catch((e: unknown) => {
      logger.error(
        "Enrollment verify failed unexpectedly for {worker}: {error}",
        {
          worker: workerName,
          error: e instanceof Error ? e.message : String(e),
        },
      );
    }).finally(() => {
      entry.verifying = false;
      if (!entry.verifyAgain) {
        // only now does the worker read as failed rather than pending
        if (failed) this.#announceVerifyFailed(workerName, entry);
        return;
      }
      entry.verifyAgain = false;
      if (
        this.#workers.get(workerName) === entry &&
        entry.status === "unverified" && entry.channel !== null &&
        !entry.channel.closed
      ) {
        this.#startEnrollmentVerify(workerName);
      } else {
        entry.probeOwed = false;
      }
    });
  }

  // true when the probe failed and the failure was recorded on the worker
  async #runEnrollmentVerify(workerName: string): Promise<boolean> {
    const verifyWorker = this.#options.verifyWorker!;
    // This run answers any refusal seen before it; only one it meets itself
    // calls for another.
    const started = this.#workers.get(workerName);
    if (started) started.probeRefusedForCapacity = false;
    try {
      const probeResult = await verifyWorker(workerName);
      const entry = this.#workers.get(workerName);
      if (!entry || entry.channel === null) return false;
      if (probeResult.ok) {
        if (entry.status !== "draining") {
          const promoted = await this.#recordWorkerWrite(
            "verify_passed",
            workerName,
            async () => {
              if (this.#probeOutcomeSuperseded(entry)) return false;
              await this.#workerStatus.recordStatus(workerName, {
                status: "idle",
              });
              // promoted only once recorded, and never over a drain or
              // disconnect that landed during the write
              if (this.#probeOutcomeSuperseded(entry)) return false;
              entry.status = "idle";
              entry.verifyFailureReason = undefined;
              return true;
            },
          );
          if (promoted) {
            const snap = this.#snapshot(entry);
            this.#options.onWorkerEnrolled?.(snap);
            this.#options.onWorkerIdle?.(snap);
          }
        }
      } else {
        await this.#recordWorkerWrite("verify_failed", workerName, async () => {
          entry.verifyFailureReason = probeResult.failureReason;
          // the newer record stands: a persisted reason goes only with unverified
          if (this.#probeOutcomeSuperseded(entry)) return;
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
        return true;
      }
    } catch (error) {
      const entry = this.#workers.get(workerName);
      if (!entry || entry.channel === null) return false;
      const reason = error instanceof Error ? error.message : String(error);
      await this.#recordWorkerWrite("verify_failed", workerName, async () => {
        entry.verifyFailureReason = reason;
        if (this.#probeOutcomeSuperseded(entry)) return;
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
      return true;
    }
    return false;
  }

  #announceVerifyFailed(workerName: string, entry: WorkerEntry): void {
    if (
      this.#workers.get(workerName) !== entry ||
      this.#probeOutcomeSuperseded(entry)
    ) {
      return;
    }
    this.#options.onWorkerVerifyFailed?.(this.#snapshot(entry));
  }

  // unverified with a probe running or owed, never inferred from a missing reason
  verificationPending(name: string): boolean {
    const entry = this.#workers.get(name);
    if (!entry || entry.status !== "unverified") return false;
    return entry.probeOwed === true || entry.verifying === true ||
      entry.probeRefusedForCapacity === true;
  }

  // a drain or disconnect can land while a probe's outcome waits on the
  // worker's key; its own write follows and must not be overwritten
  #probeOutcomeSuperseded(entry: WorkerEntry): boolean {
    return entry.status === "draining" || entry.channel === null;
  }

  #liveEnrollment(workerName: string): WorkerEnrollment | undefined {
    const entry = this.#workers.get(workerName);
    return entry === undefined ? undefined : this.#enrollmentOf(entry);
  }

  #enrollmentOf(entry: WorkerEntry): WorkerEnrollment {
    return {
      instanceUuid: entry.instanceUuid,
      tokenName: entry.tokenName,
      workerName: entry.name,
      labels: { ...entry.labels },
      platform: entry.platform,
      arch: entry.arch,
      swampVersion: entry.swampVersion,
      protocolVersion: entry.protocolVersion,
      // a reconnect takes its capacity unchecked; the record needs a valid one
      capacity: Number.isInteger(entry.capacity) && entry.capacity >= 1
        ? entry.capacity
        : 1,
      tokenCreatedAt: entry.tokenCreatedAt,
      ...(this.#options.owner ? { owner: this.#options.owner } : {}),
    };
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
   * advisory: once the presented secret opens the token, creates a new
   * worker's definition off the tail so the enroll turn reads its name file
   * instead of listing the auto-definitions directory; redeem still decides
   */
  async #prepareWorkerDefinition(
    state: SocketState,
    tokenName: string,
    presented: string,
    machineId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const ensure = this.#ensureWorkerDefinition;
    const readTokenSecret = this.#options.readTokenSecret;
    if (ensure === undefined || readTokenSecret === undefined) return;
    if (this.#prechecksInFlight >= MAX_ENROLLMENT_PRECHECKS) return;
    this.#prechecksInFlight++;
    try {
      if (await this.#findTokenDefinitionId(tokenName) === null) return;
      const record = await this.#readTokenRecord(tokenName);
      if (record === null) return;
      const nowMs = Date.now();
      if (enrollmentTokenClosed(record, nowMs) !== null) return;
      if (!admitsMachine(record, machineId)) return;
      const workerName = await workerNameFor(
        tokenName,
        machineId,
        await this.#readTokenMaxEnrollments(tokenName, record) ?? 1,
      );
      if (this.#workers.has(workerName)) return;
      const opened = await presentedTokenMint(
        record,
        presented,
        nowMs,
        (secretKey) => readTokenSecret(record.vaultName, secretKey, "verify"),
      );
      if (opened === null) return;
      if (state.channel.closed || signal.aborted) return;
      await ensure(workerName);
    } catch (error) {
      // a refusal returns above, so a throw is a fault worth seeing
      logger.warn(
        "Enrollment pre-check for {token} failed, so its turn creates the worker definition: {error}",
        {
          token: tokenName,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    } finally {
      this.#prechecksInFlight--;
    }
  }

  /**
   * every durable token and pool-admission mutation flows through this
   * serialized tail, preserving the sole-writer invariant; operation labels its span
   */
  #recordTransition<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return this.#transitions.run(operation, async () => {
      const running = { settled: false };
      try {
        return await this.#runningTransition.run(running, fn);
      } finally {
        running.settled = true;
      }
    });
  }

  /**
   * a worker's own record, ordered only with that worker's other writes; fn
   * never writes a token record or queues a transition, since a turn awaits it
   */
  #recordWorkerWrite<T>(
    operation: string,
    workerName: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.#transitions.run(operation, fn, workerName);
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
