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

import { join } from "@std/path";
import { RpcChannel, RpcError } from "../domain/remote/rpc_channel.ts";
import {
  type EnrollResult,
  GATE_PASS_UNAVAILABLE,
  PERMANENT_ENROLLMENT_ERROR_CODES,
  REMOTE_PROTOCOL_VERSION,
  RemoteMethod,
  type SessionRefreshResult,
  withoutQuotedNames,
} from "../domain/remote/protocol.ts";
import { dataPlaneUrlFromConnectUrl } from "./data_plane_client.ts";
import {
  type DispatchHandlerHandle,
  registerDispatchHandler,
  type WorkerDispatchEvent,
} from "./dispatch_handler.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  observeExecutionWork,
  traceCarrier,
} from "../domain/remote/observability.ts";
import { injectTraceContext } from "../infrastructure/tracing/propagation.ts";
import { AuthGateBlockedError } from "../domain/auth/auth_gate_blocked_error.ts";
import {
  createTlsHttpClient,
  diagnoseTlsMessage,
  getDefaultHttpClient,
  probeServeRestarting,
} from "../cli/remote_run.ts";

const logger = getSwampLogger(["worker", "connect"]);

const REFRESH_FRACTION = 2 / 3;

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

// long enough to ride out a serve restart; measured from the first failure of a streak
const PRE_ENROLL_RETRY_BUDGET_MS = 5 * 60_000;

const MAX_PRE_ENROLL_FAILURES = 3;

export type WorkerStatusEvent =
  | { kind: "connecting"; url: string; attempt: number }
  | { kind: "enrolled"; workerId: string; reconnect: boolean }
  | { kind: "disconnected"; reason: string }
  | { kind: "retrying"; delayMs: number }
  | { kind: "stopped"; reason: string }
  | { kind: "draining"; reason: WorkerExitReason }
  | { kind: "drain_complete" }
  | WorkerDispatchEvent;

export type WorkerExitReason =
  | "signal"
  | "max-dispatches"
  | "idle-timeout"
  | "shutdown"
  | "error";

export interface WorkerExitResult {
  reason: WorkerExitReason;
}

export interface RunWorkerOptions {
  url: string;
  token: string;
  labels?: Record<string, string>;
  swampVersion: string;
  dataPlaneUrl?: string;
  /**
   * Bundle/asset cache directory; defaults to a fresh temp dir, removed when
   * the worker exits unless a dispatch is still running from it.
   */
  cacheDir?: string;
  signal?: AbortSignal;
  onStatus?: (event: WorkerStatusEvent) => void;
  reconnect?: boolean;
  maxDispatches?: number;
  idleTimeoutMs?: number;
  concurrency?: number;
  onDrainAvailable?: (requestDrain: (reason: WorkerExitReason) => void) => void;
  headers?: Record<string, string>;
  caCerts?: string[];
  createSocket?: (url: string, headers?: Record<string, string>) => WebSocket;
  runnerCommand?: { cmd: string; args: string[] };
  /**
   * for a worker without a swamp-club credential: called once per process with
   * the orchestrator's pass (undefined if none) and throws the gate's block
   * error to stop the worker
   */
  admitGatePass?: (
    gatePass: string | undefined,
    serveRefused?: boolean,
  ) => Promise<void>;
  preEnrollRetryBudgetMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  isServeRestarting?: (failure: string) => Promise<boolean>;
}

interface SessionState {
  credential: string;
  expiresAtMs: number;
}

export async function runWorker(
  options: RunWorkerOptions,
): Promise<WorkerExitResult> {
  const dispatches: DispatchCount = { active: 0 };
  if (options.cacheDir !== undefined) {
    return await runWorkerFrom(options, options.cacheDir, dispatches);
  }
  const cacheDir = await Deno.makeTempDir({ prefix: "swamp-worker-cache-" });
  try {
    return await runWorkerFrom(options, cacheDir, dispatches);
  } finally {
    await releaseWorkerCacheDir(cacheDir, dispatches.active);
  }
}

/**
 * an abort returns without waiting for in-flight dispatches, which may still
 * run bundles from it, so the directory is left behind
 */
export async function releaseWorkerCacheDir(
  cacheDir: string,
  activeDispatches: number,
): Promise<void> {
  if (activeDispatches > 0) {
    logger
      .debug`Keeping worker cache ${cacheDir}: ${activeDispatches} dispatch(es) still running`;
    return;
  }
  try {
    await Deno.remove(cacheDir, { recursive: true });
  } catch (error) {
    logger.debug`Removing worker cache ${cacheDir} failed: ${error}`;
  }
}

interface DispatchCount {
  active: number;
}

async function runWorkerFrom(
  options: RunWorkerOptions,
  cacheDir: string,
  dispatches: DispatchCount,
): Promise<WorkerExitResult> {
  const instanceUuid = crypto.randomUUID();
  const session: SessionState = { credential: "", expiresAtMs: 0 };
  const gate: GateState = { admitted: options.admitGatePass === undefined };
  const dataPlaneUrl = options.dataPlaneUrl ??
    dataPlaneUrlFromConnectUrl(options.url);
  const machineId = await loadOrCreateMachineId(cacheDir);
  const httpClient = options.caCerts?.length
    ? createTlsHttpClient({ caCerts: options.caCerts })
    : getDefaultHttpClient();

  const concurrency = options.concurrency ?? 1;
  let drainReason: WorkerExitReason | null = null;
  let dispatchCount = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let currentDrainHandle: DispatchHandlerHandle | null = null;
  let currentChannel: RpcChannel | null = null;
  let currentCloseConnection: (() => void) | null = null;
  let _drainPromise: Promise<void> | null = null;

  const startIdleTimer = () => {
    if (options.idleTimeoutMs === undefined || drainReason !== null) return;
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      triggerDrain("idle-timeout");
    }, options.idleTimeoutMs);
  };

  const clearIdleTimer = () => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const triggerDrain = (reason: WorkerExitReason) => {
    if (drainReason !== null) return;
    drainReason = reason;
    clearIdleTimer();
    options.onStatus?.({ kind: "draining", reason });

    const handle = currentDrainHandle;
    const channel = currentChannel;
    const close = currentCloseConnection;
    if (handle) {
      // announce the drain before waiting on in-flight work so the orchestrator
      // stops scheduling here; a failed announcement must not hold up the drain
      const callDrain = () =>
        channel
          ? channel.call(RemoteMethod.drain, {}).then(() => {}, () => {})
          : Promise.resolve();
      const announced = callDrain();
      _drainPromise = handle.drain().then(() => {
        options.onStatus?.({ kind: "drain_complete" });
        return announced;
        // A second call once the work has ended: frames arrive in order, so
        // its answer proves the last dispatch response reached the
        // orchestrator before the socket closes and the process exits.
      }).then(callDrain).then(() => {
        close?.();
      }, () => {
        close?.();
      });
    } else {
      close?.();
    }
  };

  options.onDrainAvailable?.(triggerDrain);

  let attempt = 0;
  let delayMs = RECONNECT_BASE_DELAY_MS;
  const budgetMs = options.preEnrollRetryBudgetMs ??
    PRE_ENROLL_RETRY_BUDGET_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableDelay;
  let failureStreakStartMs: number | null = null;
  let otherFailures = 0;
  let lastFailureRestarting = false;
  const isServeRestarting = options.isServeRestarting ??
    ((failure: string) =>
      serveRestartingFromFailure(
        failure,
        options.url,
        options.headers,
        options.caCerts,
      ));
  while (!(options.signal?.aborted ?? false) && drainReason === null) {
    attempt++;
    options.onStatus?.({ kind: "connecting", url: options.url, attempt });
    try {
      const outcome = await observeExecutionWork("enrollment.connect", {
        "swamp.worker.machine_id": machineId,
        "swamp.worker.instance_id": instanceUuid,
        "swamp.connection.epoch": crypto.randomUUID(),
        "swamp.enrollment.attempt": attempt,
      }, () =>
        connectOnce({
          options,
          httpClient,
          instanceUuid,
          machineId,
          session,
          gate,
          dataPlaneUrl,
          cacheDirPath: join(cacheDir, "bundles"),
          concurrency,
          onDispatchHandlerRegistered: (handle, channel, close) => {
            currentDrainHandle = handle;
            currentChannel = channel;
            currentCloseConnection = close;
            if (drainReason !== null) {
              close();
              return;
            }
            startIdleTimer();
          },
          onDispatchStarted: () => {
            dispatches.active++;
            clearIdleTimer();
          },
          onDispatchFinished: () => {
            dispatches.active--;
            dispatchCount++;
            if (
              options.maxDispatches !== undefined &&
              dispatchCount >= options.maxDispatches
            ) {
              triggerDrain("max-dispatches");
            } else if (dispatches.active === 0) {
              startIdleTimer();
            }
          },
        }));
      failureStreakStartMs = null;
      otherFailures = 0;
      lastFailureRestarting = false;
      options.onStatus?.({ kind: "disconnected", reason: outcome });
      delayMs = RECONNECT_BASE_DELAY_MS;
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      if (isPermanentEnrollmentFailure(error)) {
        // The gate's block is reported in full once, by the caller.
        options.onStatus?.({
          kind: "stopped",
          reason: error instanceof AuthGateBlockedError
            ? "auth gate blocked"
            : raw,
        });
        throw error;
      }
      const message = diagnoseTlsMessage(raw) ?? raw;
      lastFailureRestarting = await isServeRestarting(raw);
      let giveUp: string | undefined;
      if (lastFailureRestarting) {
        otherFailures = 0;
        const failedAtMs = now();
        failureStreakStartMs ??= failedAtMs;
        const elapsedMs = failedAtMs - failureStreakStartMs;
        if (elapsedMs >= budgetMs) {
          giveUp = `connection failed before enrollment for ${
            formatElapsed(elapsedMs)
          }`;
        }
      } else if (++otherFailures >= MAX_PRE_ENROLL_FAILURES) {
        giveUp =
          `connection failed ${MAX_PRE_ENROLL_FAILURES} consecutive times before enrollment`;
      }
      if (giveUp !== undefined) {
        const reason = `${giveUp} — giving up (last error: ${message})`;
        logger.error(reason);
        options.onStatus?.({ kind: "stopped", reason });
        throw new Error(reason);
      }
      options.onStatus?.({ kind: "disconnected", reason: message });
    }
    if (
      options.reconnect === false || (options.signal?.aborted ?? false) ||
      drainReason !== null
    ) {
      break;
    }
    // the last sleep is cut short so one final attempt lands at the budget
    const sleepMs = lastFailureRestarting && failureStreakStartMs !== null
      ? Math.min(delayMs, budgetMs - (now() - failureStreakStartMs))
      : delayMs;
    options.onStatus?.({ kind: "retrying", delayMs: sleepMs });
    await observeExecutionWork("enrollment.retry", {
      "swamp.enrollment.attempt": attempt,
      "swamp.retry.delay_ms": sleepMs,
    }, () => sleep(sleepMs, options.signal));
    delayMs = Math.min(delayMs * 2, RECONNECT_MAX_DELAY_MS);
  }

  clearIdleTimer();
  const reason = drainReason ?? "shutdown";
  options.onStatus?.({ kind: "stopped", reason });
  return { reason };
}

const MACHINE_ID_FILE = "machine-id";

/**
 * the enrollment token binds to this id, so a stable cache directory lets a
 * worker re-enroll after a restart; the default temp directory yields a fresh
 * id per process
 */
async function loadOrCreateMachineId(cacheDir: string): Promise<string> {
  const path = join(cacheDir, MACHINE_ID_FILE);
  try {
    const existing = (await Deno.readTextFile(path)).trim();
    if (existing.length > 0) {
      return existing;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
  const machineId = crypto.randomUUID();
  await Deno.mkdir(cacheDir, { recursive: true });
  await Deno.writeTextFile(path, machineId);
  return machineId;
}

/**
 * retrying cannot fix a dead token or version mismatch; an uncoded rejection is
 * matched on its text with quoted names removed, so a token named
 * 'expired-runners' cannot make a retryable failure permanent
 */
function isPermanentEnrollmentFailure(error: unknown): boolean {
  if (error instanceof AuthGateBlockedError) return true;
  if (error instanceof RpcError && error.code !== "handler_failed") {
    return PERMANENT_ENROLLMENT_ERROR_CODES.has(error.code);
  }
  const message = withoutQuotedNames(
    error instanceof Error ? error.message : String(error),
  );
  return message.includes("revoked") ||
    message.includes("expired") ||
    message.includes("does not match") ||
    message.includes("already bound") ||
    message.includes("protocol version") ||
    message.includes("does not exist") ||
    message.includes("allowance exhausted");
}

// a status the upgrade carried decides; without one only the probe can tell a
// refusal from a DNS failure or a timeout
async function serveRestartingFromFailure(
  failure: string,
  url: string,
  headers: Record<string, string> | undefined,
  caCerts: string[] | undefined,
): Promise<boolean> {
  const status = failure.match(/Invalid status code: (\d+)/);
  if (status) return RESTART_STATUSES.has(Number(status[1]));
  return await probeServeRestarting(url, headers, caCerts);
}

const RESTART_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface GateState {
  admitted: boolean;
  /**
   * The admission check in flight, shared by a reconnect that enrolls while
   * it runs; cleared when it fails, so the next enrollment checks again.
   */
  pending?: Promise<void>;
}

interface ConnectOnceArgs {
  options: RunWorkerOptions;
  httpClient: Deno.HttpClient;
  instanceUuid: string;
  machineId: string;
  session: SessionState;
  gate: GateState;
  dataPlaneUrl: string;
  cacheDirPath: string;
  concurrency: number;
  onDispatchHandlerRegistered: (
    handle: DispatchHandlerHandle,
    channel: RpcChannel,
    closeConnection: () => void,
  ) => void;
  onDispatchStarted: () => void;
  onDispatchFinished: () => void;
}

function connectOnce(args: ConnectOnceArgs): Promise<string> {
  const lifecycleTrace = traceCarrier(injectTraceContext());
  const { options, instanceUuid, machineId, session, gate } = args;
  return new Promise<string>((resolve, reject) => {
    const defaultCreate = (url: string, headers?: Record<string, string>) => {
      const opts: Record<string, unknown> = { client: args.httpClient };
      if (headers && Object.keys(headers).length > 0) {
        opts.headers = headers;
      }
      return new WebSocket(url, opts);
    };
    const socket = (options.createSocket ?? defaultCreate)(
      options.url,
      options.headers,
    );
    const channel = new RpcChannel({ send: (data) => socket.send(data) });
    let enrolled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const finish = (reason: string, error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (refreshTimer !== undefined) {
        clearTimeout(refreshTimer);
      }
      options.signal?.removeEventListener("abort", onShutdown);
      channel.close(reason);
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      if (error) {
        reject(error);
      } else {
        resolve(reason);
      }
    };

    const onShutdown = () => finish("shutdown requested");
    options.signal?.addEventListener("abort", onShutdown, { once: true });

    const scheduleRefresh = () => {
      const ttl = session.expiresAtMs - Date.now();
      const delay = Math.max(1_000, ttl * REFRESH_FRACTION);
      refreshTimer = setTimeout(() => {
        channel.call<SessionRefreshResult>(RemoteMethod.sessionRefresh, {})
          .then((refreshed) => {
            session.credential = refreshed.sessionCredential;
            session.expiresAtMs = refreshed.sessionExpiresAtMs;
            scheduleRefresh();
          })
          .catch((error: unknown) => {
            // A failed refresh means the credential will lapse — drop the
            // socket and re-enroll rather than running unauthenticated.
            finish(
              `session refresh failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
      }, delay);
    };

    socket.onopen = () => {
      // the orchestrator can dispatch before its enroll reply arrives, so the
      // handler exists from the start and holds each dispatch until enrollment
      // is complete; a failed enrollment refuses them
      const ready = Promise.withResolvers<void>();
      ready.promise.catch(() => {});
      const handle = registerDispatchHandler({
        lifecycleTrace,
        channel,
        sessionCredential: () => session.credential,
        dataPlaneUrl: args.dataPlaneUrl,
        cacheDirPath: args.cacheDirPath,
        caCerts: options.caCerts,
        capacity: args.concurrency,
        runnerCommand: options.runnerCommand,
        admitted: ready.promise,
        onDispatch: (event) => {
          if (event.kind === "dispatch_started") {
            args.onDispatchStarted();
          } else if (event.kind === "dispatch_finished") {
            args.onDispatchFinished();
          }
          options.onStatus?.(event);
        },
      });
      observeExecutionWork(
        "enrollment.request",
        {},
        () =>
          channel.call<EnrollResult>(RemoteMethod.enroll, {
            token: options.token,
            instanceUuid,
            machineId,
            protocolVersion: REMOTE_PROTOCOL_VERSION,
            swampVersion: options.swampVersion,
            platform: Deno.build.os,
            arch: Deno.build.arch,
            labels: options.labels ?? {},
            resourceLimits: { capacity: args.concurrency },
            ...(gate.admitted ? {} : { needsGatePass: true }),
          }),
        lifecycleTrace,
      ).then((result) => {
        session.credential = result.sessionCredential;
        session.expiresAtMs = result.sessionExpiresAtMs;
        // until admitted, a reconnect asks for a pass again and a refusal
        // stops the worker (fails closed)
        const admitGatePass = options.admitGatePass;
        const admitted = gate.admitted || !admitGatePass
          ? Promise.resolve()
          : gate.pending ??= admitGatePass(result.gatePass).then(() => {
            gate.admitted = true;
          }, (error: unknown) => {
            gate.pending = undefined;
            throw error;
          });
        return admitted.then(() => {
          // The socket closed while admission was pending: the reconnect
          // loop owns what happens next.
          if (settled) {
            ready.reject(new Error("connection closed during enrollment"));
            return;
          }
          enrolled = true;
          args.onDispatchHandlerRegistered(
            handle,
            channel,
            () => finish("drained"),
          );
          scheduleRefresh();
          logger.info("Enrolled as {workerId}", { workerId: result.workerId });
          options.onStatus?.({
            kind: "enrolled",
            workerId: result.workerId,
            reconnect: false,
          });
          ready.resolve();
        });
      }).catch(async (error: unknown) => {
        ready.reject(error);
        // never rejects: everything is caught and ends in finish(); an
        // orchestrator with no pass refuses before redeeming the token, which
        // admission turns into the gate's block
        let failure = error;
        if (
          options.admitGatePass && error instanceof RpcError &&
          error.code === GATE_PASS_UNAVAILABLE
        ) {
          try {
            await options.admitGatePass(undefined, true);
          } catch (blocked) {
            failure = blocked;
          }
        }
        finish(
          "enrollment failed",
          failure instanceof Error ? failure : new Error(String(failure)),
        );
      });
    };

    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        channel.handleRaw(event.data);
      }
    };

    let connectErrorDetail = "";
    socket.onclose = (event: CloseEvent | Event | undefined) => {
      const parts: string[] = [];
      const closeEvent = event instanceof CloseEvent ? event : undefined;
      if (closeEvent && closeEvent.code !== 1000 && closeEvent.code !== 1005) {
        parts.push(`code ${closeEvent.code}`);
      }
      if (closeEvent?.reason) {
        parts.push(closeEvent.reason);
      }
      const detail = connectErrorDetail ||
        (parts.length > 0 ? ` (${parts.join(": ")})` : "");
      if (enrolled) {
        finish(`control socket closed${detail}`);
      } else {
        const reason = `socket closed before enrollment${detail}`;
        finish(reason, new Error(reason));
      }
    };

    socket.onerror = (event: Event) => {
      if (event instanceof ErrorEvent && event.message) {
        connectErrorDetail = `: ${event.message}`;
      }
    };
  });
}
