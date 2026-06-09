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
 * socket outbound, enrolls (or re-authenticates the same instance after a
 * blip), keeps the data-plane session credential sliding, and executes
 * dispatches until told to stop. The instance UUID lives in memory only —
 * a process restart is a new worker that needs an unexpired token.
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
import { registerDispatchHandler } from "./dispatch_handler.ts";
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
  | { kind: "stopped"; reason: string };

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
  /** Test seam: WebSocket factory. */
  createSocket?: (url: string) => WebSocket;
}

interface SessionState {
  credential: string;
  expiresAtMs: number;
}

/**
 * Run the worker until the signal aborts, enrollment is permanently
 * rejected, or (with reconnect disabled) the socket closes.
 */
export async function runWorker(options: RunWorkerOptions): Promise<void> {
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
  const bundleCache = new WorkerBundleCache(join(cacheDir, "bundles"), client);

  let attempt = 0;
  let delayMs = RECONNECT_BASE_DELAY_MS;
  while (!(options.signal?.aborted ?? false)) {
    attempt++;
    options.onStatus?.({ kind: "connecting", url: options.url, attempt });
    try {
      const outcome = await connectOnce({
        options,
        instanceUuid,
        session,
        client,
        bundleCache,
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
    if (options.reconnect === false || (options.signal?.aborted ?? false)) {
      break;
    }
    options.onStatus?.({ kind: "retrying", delayMs });
    await abortableDelay(delayMs, options.signal);
    delayMs = Math.min(delayMs * 2, RECONNECT_MAX_DELAY_MS);
  }
  options.onStatus?.({ kind: "stopped", reason: "shutdown" });
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
  session: SessionState;
  client: DataPlaneClient;
  bundleCache: WorkerBundleCache;
}

/** One socket lifetime: connect, enroll, serve dispatches until close. */
function connectOnce(args: ConnectOnceArgs): Promise<string> {
  const { options, instanceUuid, session } = args;
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
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        swampVersion: options.swampVersion,
        platform: Deno.build.os,
        arch: Deno.build.arch,
        labels: options.labels ?? {},
      }).then((result) => {
        enrolled = true;
        session.credential = result.sessionCredential;
        session.expiresAtMs = result.sessionExpiresAtMs;
        registerDispatchHandler({
          channel,
          client: args.client,
          bundleCache: args.bundleCache,
        });
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
