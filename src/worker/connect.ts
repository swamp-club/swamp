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
 * The worker dial-home loop (see design/remote-execution.md, "Enrollment").
 *
 * A worker is a swamp binary plus a token and a URL: it opens the control
 * socket outbound, enrolls (or re-authenticates after a blip or restart),
 * keeps the data-plane session credential sliding, and executes dispatches
 * until told to stop. The instance UUID lives in memory only and tells a
 * same-process reconnect apart from a new process; the machine id persists
 * in the cache directory and is what the token binds to — a worker with a
 * stable cache directory survives restarts and reboots on the same token
 * until the token lifetime expires.
 */

import { join } from "@std/path";
import { RpcChannel } from "../domain/remote/rpc_channel.ts";
import {
  type EnrollResult,
  REMOTE_PROTOCOL_VERSION,
  RemoteMethod,
  type SessionRefreshResult,
} from "../domain/remote/protocol.ts";
import {
  DataPlaneClient,
  dataPlaneUrlFromConnectUrl,
} from "./data_plane_client.ts";
import { WorkerBundleCache } from "./bundle_cache.ts";
import {
  type DispatchHandlerHandle,
  registerDispatchHandler,
  type WorkerDispatchEvent,
} from "./dispatch_handler.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["worker", "connect"]);

/** Refresh the session credential when 2/3 of its lifetime has elapsed. */
const REFRESH_FRACTION = 2 / 3;

/** Reconnect backoff: starts here, doubles, caps below. */
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

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
  /** Orchestrator control-socket URL (ws:// or wss://). */
  url: string;
  /** Enrollment credential of the form `<name>.<secret>`. */
  token: string;
  labels?: Record<string, string>;
  swampVersion: string;
  /** Overrides the data-plane base URL derived from the connect URL. */
  dataPlaneUrl?: string;
  /** Bundle/asset cache directory; defaults to a fresh temp dir. */
  cacheDir?: string;
  /** Abort to shut the worker down. */
  signal?: AbortSignal;
  /** Status callback for CLI rendering. */
  onStatus?: (event: WorkerStatusEvent) => void;
  /** Reconnect on socket loss (default true). */
  reconnect?: boolean;
  /** Drain and exit 0 after N dispatches complete. */
  maxDispatches?: number;
  /** Drain and exit 0 after being continuously idle for this many ms. */
  idleTimeoutMs?: number;
  /**
   * Called once during setup with a function that triggers drain from
   * outside (e.g. signal handler). The caller can store this and invoke
   * it when a signal arrives.
   */
  onDrainAvailable?: (requestDrain: (reason: WorkerExitReason) => void) => void;
  /** Test seam: WebSocket factory. */
  createSocket?: (url: string) => WebSocket;
}

interface SessionState {
  credential: string;
  expiresAtMs: number;
}

/**
 * Run the worker until the signal aborts, enrollment is permanently
 * rejected, a lifecycle policy triggers drain, or (with reconnect
 * disabled) the socket closes.
 */
export async function runWorker(
  options: RunWorkerOptions,
): Promise<WorkerExitResult> {
  const instanceUuid = crypto.randomUUID();
  const session: SessionState = { credential: "", expiresAtMs: 0 };
  const dataPlaneUrl = options.dataPlaneUrl ??
    dataPlaneUrlFromConnectUrl(options.url);
  const client = new DataPlaneClient({
    baseUrl: dataPlaneUrl,
    credential: () => session.credential,
  });
  const cacheDir = options.cacheDir ??
    await Deno.makeTempDir({ prefix: "swamp-worker-cache-" });
  const machineId = await loadOrCreateMachineId(cacheDir);
  const bundleCache = new WorkerBundleCache(join(cacheDir, "bundles"), client);

  let drainReason: WorkerExitReason | null = null;
  let dispatchCount = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let currentDrainHandle: DispatchHandlerHandle | null = null;
  let currentChannel: RpcChannel | null = null;
  let currentCloseConnection: (() => void) | null = null;

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
      handle.drain().then(() => {
        options.onStatus?.({ kind: "drain_complete" });
        if (!channel) {
          close?.();
          return;
        }
        return channel.call(RemoteMethod.drain, {}).then(() => {
          close?.();
        }).catch(() => {
          close?.();
        });
      }).catch(() => {
        close?.();
      });
    } else {
      close?.();
    }
  };

  options.onDrainAvailable?.(triggerDrain);

  let attempt = 0;
  let delayMs = RECONNECT_BASE_DELAY_MS;
  while (!(options.signal?.aborted ?? false) && drainReason === null) {
    attempt++;
    options.onStatus?.({ kind: "connecting", url: options.url, attempt });
    try {
      const outcome = await connectOnce({
        options,
        instanceUuid,
        machineId,
        session,
        client,
        bundleCache,
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
          clearIdleTimer();
        },
        onDispatchFinished: () => {
          dispatchCount++;
          if (
            options.maxDispatches !== undefined &&
            dispatchCount >= options.maxDispatches
          ) {
            triggerDrain("max-dispatches");
          } else {
            startIdleTimer();
          }
        },
      });
      options.onStatus?.({ kind: "disconnected", reason: outcome });
      delayMs = RECONNECT_BASE_DELAY_MS;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isPermanentEnrollmentFailure(message)) {
        options.onStatus?.({ kind: "stopped", reason: message });
        throw error;
      }
      options.onStatus?.({ kind: "disconnected", reason: message });
    }
    if (
      options.reconnect === false || (options.signal?.aborted ?? false) ||
      drainReason !== null
    ) {
      break;
    }
    options.onStatus?.({ kind: "retrying", delayMs });
    await abortableDelay(delayMs, options.signal);
    delayMs = Math.min(delayMs * 2, RECONNECT_MAX_DELAY_MS);
  }

  clearIdleTimer();
  const reason = drainReason ?? "shutdown";
  options.onStatus?.({ kind: "stopped", reason });
  return { reason };
}

const MACHINE_ID_FILE = "machine-id";

/**
 * Durable machine identity: read `machine-id` from the cache directory or
 * create it. The enrollment token binds to this id, so a stable cache
 * directory (--cache-dir) is what lets a worker re-enroll after a restart;
 * the default temp cache directory yields a fresh id per process.
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
 * Enrollment failures that retrying cannot fix — a dead token or a version
 * mismatch needs a new token or a new binary, not patience.
 */
function isPermanentEnrollmentFailure(message: string): boolean {
  return message.includes("revoked") ||
    message.includes("expired") ||
    message.includes("does not match") ||
    message.includes("already bound") ||
    message.includes("protocol version");
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

interface ConnectOnceArgs {
  options: RunWorkerOptions;
  instanceUuid: string;
  machineId: string;
  session: SessionState;
  client: DataPlaneClient;
  bundleCache: WorkerBundleCache;
  onDispatchHandlerRegistered: (
    handle: DispatchHandlerHandle,
    channel: RpcChannel,
    closeConnection: () => void,
  ) => void;
  onDispatchStarted: () => void;
  onDispatchFinished: () => void;
}

/** One socket lifetime: connect, enroll, serve dispatches until close. */
function connectOnce(args: ConnectOnceArgs): Promise<string> {
  const { options, instanceUuid, machineId, session } = args;
  return new Promise<string>((resolve, reject) => {
    const socket = (options.createSocket ?? ((url) => new WebSocket(url)))(
      options.url,
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
      channel.call<EnrollResult>(RemoteMethod.enroll, {
        token: options.token,
        instanceUuid,
        machineId,
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        swampVersion: options.swampVersion,
        platform: Deno.build.os,
        arch: Deno.build.arch,
        labels: options.labels ?? {},
      }).then((result) => {
        enrolled = true;
        session.credential = result.sessionCredential;
        session.expiresAtMs = result.sessionExpiresAtMs;
        const handle = registerDispatchHandler({
          channel,
          client: args.client,
          bundleCache: args.bundleCache,
          onDispatch: (event) => {
            if (event.kind === "dispatch_started") {
              args.onDispatchStarted();
            } else if (event.kind === "dispatch_finished") {
              args.onDispatchFinished();
            }
            options.onStatus?.(event);
          },
        });
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
      }).catch((error: unknown) => {
        finish(
          "enrollment failed",
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    };

    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        channel.handleRaw(event.data);
      }
    };

    socket.onclose = () => {
      finish(
        enrolled ? "control socket closed" : "socket closed before enrollment",
      );
    };

    socket.onerror = () => {
      // onclose follows; nothing to do here, but keep the handler so the
      // runtime does not surface it as an unhandled error event.
    };
  });
}
