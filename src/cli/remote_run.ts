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
 * Client for running workflows and model methods through a `swamp serve`
 * server (`--server`). Speaks the serve WebSocket protocol
 * (`src/serve/protocol.ts`): sends one request, yields the deserialized run
 * events for the same renderers a local run uses, and finishes on the
 * server's terminal `done` frame. Ctrl-C (signal abort) sends `cancel` and
 * drains until the server confirms.
 *
 * Authentication: when `--auth-mode token` is active on the server, the
 * client appends `?token=<name>.<secret>` to the WebSocket URL. The token
 * comes from (in precedence order): the `--token` flag, the
 * `SWAMP_SERVER_TOKEN` env var, or the `~/.config/swamp/servers.json` file
 * via `ServerCredentialRepository`.
 */

import type { Command } from "@cliffy/command";
import { UserError } from "../domain/errors.ts";
import type {
  ModelMethodRunPayload,
  ServerMessage,
  WorkflowResumePayload,
  WorkflowRunPayload,
} from "../serve/protocol.ts";
import { deserializeEvent } from "../serve/serializer.ts";
import type { ServerCredentialRepository } from "../domain/auth/server_credential.ts";
import { FileServerCredentialRepository } from "../infrastructure/persistence/server_credential_repository.ts";
import { resolveExtraHeaders } from "../domain/auth/extra_headers.ts";

/**
 * Resolves the server URL from the `--server` flag with `SWAMP_SERVE_URL`
 * env var as fallback. Flag takes precedence when both are provided.
 */
export function resolveServeUrl(
  flagValue: string | undefined,
): string | undefined {
  return flagValue ?? Deno.env.get("SWAMP_SERVE_URL");
}

/** How long to keep draining after sending `cancel` before giving up. */
const CANCEL_DRAIN_MS = 10_000;

/** How long to wait for the WebSocket to open. */
const CONNECT_TIMEOUT_MS = 15_000;

/** Max reconnection attempts after a WebSocket drop with a known runId. */
const MAX_RECONNECT_RETRIES = 5;

/** Max retries when the server responds with run.elsewhere. */
const MAX_ELSEWHERE_RETRIES = 10;

/** Base delay (ms) between run.elsewhere retries. */
const ELSEWHERE_RETRY_DELAY_MS = 1_500;

export interface ServerRunOptions {
  /** Server URL: ws://, wss://, http://, or https://. */
  server: string;
  /** Server token (`<name>.<secret>`) for authentication. */
  token?: string;
  signal?: AbortSignal;
  /** Extra headers for proxy/tunnel pass-through (env: SWAMP_SERVE_EXTRA_HEADERS). */
  headers?: Record<string, string>;
  /** Test seam: WebSocket factory. */
  createSocket?: (url: string, headers?: Record<string, string>) => WebSocket;
}

/**
 * Appends a `?token=` query parameter to a WebSocket URL for server token
 * authentication. Returns the original URL unmodified when no token is
 * provided.
 */
export function appendTokenToUrl(url: string, token?: string): string {
  if (!token) return url;
  const parsed = new URL(url);
  parsed.searchParams.set("token", token);
  return parsed.href;
}

/**
 * Converts ws(s) URLs to http(s) for credential lookup — stored credentials
 * are keyed by http(s) URL, but `--server` flags often use ws(s).
 */
function toHttpUrl(serverUrl: string): string {
  try {
    const parsed = new URL(serverUrl);
    if (parsed.protocol === "ws:") parsed.protocol = "http:";
    else if (parsed.protocol === "wss:") parsed.protocol = "https:";
    return parsed.href.replace(/\/+$/, "");
  } catch {
    return serverUrl;
  }
}

/**
 * Resolves the server token for authentication. Precedence:
 * 1. Explicit `--token` flag value
 * 2. `SWAMP_SERVER_TOKEN` env var (via ServerCredentialRepository)
 * 3. Stored credential in `~/.config/swamp/servers.json`
 */
export async function resolveServerToken(
  serverUrl: string,
  explicitToken?: string,
  credentialRepo?: ServerCredentialRepository,
): Promise<string | undefined> {
  if (explicitToken) return explicitToken;
  const repo = credentialRepo ?? new FileServerCredentialRepository();
  const credential = await repo.get(toHttpUrl(serverUrl));
  return credential?.token;
}

/** Normalizes http(s) URLs to ws(s) so `--server http://host:4000` works. */
export function normalizeServerUrl(server: string): string {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new UserError(
      `Invalid --server URL '${server}' — expected ws://host:port (or http://)`,
    );
  }
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new UserError(
      `Invalid --server URL '${server}' — expected ws://, wss://, http://, or https://`,
    );
  }
  return url.href;
}

export function runWorkflowOverServer(
  options: ServerRunOptions & { payload: WorkflowRunPayload },
): AsyncIterable<{ kind: string; [key: string]: unknown }> {
  return streamServerRun(options, {
    type: "workflow.run",
    payload: options.payload,
  });
}

export function runModelMethodOverServer(
  options: ServerRunOptions & { payload: ModelMethodRunPayload },
): AsyncIterable<{ kind: string; [key: string]: unknown }> {
  return streamServerRun(options, {
    type: "model.method.run",
    payload: options.payload,
  });
}

export function resumeWorkflowOverServer(
  options: ServerRunOptions & { payload: WorkflowResumePayload },
): AsyncIterable<{ kind: string; [key: string]: unknown }> {
  return streamServerRun(options, {
    type: "workflow.resume",
    payload: options.payload,
  });
}

/** Default timeout for request-response operations (30 seconds). */
const REQUEST_RESPONSE_TIMEOUT_MS = 30_000;

export interface RequestResponseOptions {
  server: string;
  token?: string;
  signal?: AbortSignal;
  /** Extra headers for proxy/tunnel pass-through (env: SWAMP_SERVE_EXTRA_HEADERS). */
  headers?: Record<string, string>;
  createSocket?: (url: string, headers?: Record<string, string>) => WebSocket;
  timeoutMs?: number;
}

export function requestServerResponse<T>(
  options: RequestResponseOptions,
  request: { type: string; id?: string; payload?: unknown },
): Promise<T> {
  const baseUrl = normalizeServerUrl(options.server);
  const url = appendTokenToUrl(baseUrl, options.token);
  const headers = options.headers ?? resolveExtraHeaders();
  const requestId = request.id ?? crypto.randomUUID();
  const socket = (options.createSocket ?? defaultCreateSocket)(url, headers);
  const timeoutMs = options.timeoutMs ?? REQUEST_RESPONSE_TIMEOUT_MS;

  const raw = new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          socket.close();
        } catch { /* already closed */ }
        reject(
          new UserError(
            `Request timed out after ${timeoutMs}ms — the server may not support this operation`,
          ),
        );
      }
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      if (!settled) {
        settled = true;
        cleanup();
        try {
          socket.close();
        } catch { /* already closed */ }
        reject(new DOMException("Request was aborted", "AbortError"));
      }
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });

    let connectErrorDetail = "";
    socket.onerror = (event) => {
      if (event instanceof ErrorEvent && event.message) {
        connectErrorDetail = `: ${event.message}`;
      }
      if (!settled) {
        settled = true;
        cleanup();
        reject(
          new UserError(
            `Could not connect to ${baseUrl}${connectErrorDetail}`,
          ),
        );
      }
    };

    socket.onclose = (event) => {
      if (!settled) {
        settled = true;
        cleanup();
        const parts: string[] = [];
        if (event.code !== 1000 && event.code !== 1005) {
          parts.push(`code ${event.code}`);
        }
        if (event.reason) {
          parts.push(event.reason);
        }
        const detail = parts.length > 0 ? ` (${parts.join(": ")})` : "";
        reject(
          new UserError(
            connectErrorDetail
              ? `Could not connect to ${baseUrl}${connectErrorDetail}`
              : `Connection closed before a response was received${detail}`,
          ),
        );
      }
    };

    socket.onopen = () => {
      socket.send(
        JSON.stringify({ ...request, id: requestId }),
      );
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const message = JSON.parse(event.data);
        if (
          typeof message !== "object" || message === null ||
          !("type" in message) || typeof message.type !== "string" ||
          !("id" in message) || message.id !== requestId
        ) {
          return;
        }
        if (message.type === "error") {
          settled = true;
          cleanup();
          try {
            socket.close();
          } catch { /* already closed */ }
          reject(
            new UserError(
              `Server reported ${message.error.code}: ${message.error.message}`,
            ),
          );
          return;
        }
        if ("payload" in message) {
          settled = true;
          cleanup();
          try {
            socket.close();
          } catch { /* already closed */ }
          resolve(message.payload as T);
        }
      } catch { /* not a protocol frame */ }
    };
  });

  return raw.catch(async (err: unknown) => {
    if (
      err instanceof UserError &&
      err.message.startsWith("Could not connect to")
    ) {
      throw new UserError(
        await classifyConnectionError(baseUrl, err.message),
      );
    }
    throw err;
  });
}

// deno-lint-ignore no-explicit-any
type AnyCommand = Command<any, any, any, any, any, any, any, any>;

/**
 * Adds `--server` and `--token` options to a Cliffy command. New
 * remote-capable commands should use this instead of duplicating the
 * option definitions from model_method_run.ts / workflow_run.ts.
 */
export function withRemoteOptions<T extends AnyCommand>(command: T): T {
  return command
    .option(
      "--server <url:string>",
      "Run through a 'swamp serve' server (ws:// or http://) instead of locally; no local repo required (env: SWAMP_SERVE_URL). For proxy/tunnel pass-through headers see SWAMP_SERVE_EXTRA_HEADERS.",
    )
    .option(
      "--token <token:string>",
      "Server token in <name>.<secret> format; only applies with --server (overrides stored credentials and SWAMP_SERVER_TOKEN)",
    ) as T;
}

/** Timeout for the health probe on connection failure (ms). */
const HEALTH_PROBE_TIMEOUT_MS = 3_000;

/**
 * Probes the server's unauthenticated /health endpoint to check if the
 * server is reachable and healthy. Used to disambiguate auth rejections
 * (server is up but returned 401/403) from genuine transport errors.
 */
export async function probeServerHealth(wsUrl: string): Promise<boolean> {
  const httpUrl = toHttpUrl(wsUrl);
  try {
    const healthUrl = new URL("/health", httpUrl);
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return typeof body === "object" && body !== null &&
      (body as Record<string, unknown>).status === "ok";
  } catch {
    return false;
  }
}

async function classifyConnectionError(
  wsUrl: string,
  originalMessage: string,
): Promise<string> {
  if (await probeServerHealth(wsUrl)) {
    return `Authentication failed — run: swamp auth server-login --server ${wsUrl}`;
  }
  return originalMessage;
}

// Force HTTP/1.1 ALPN for wss:// connections so WebSocket upgrades succeed
// through HTTP/2-capable reverse proxies (Caddy, Traefik, nginx). Without
// this, Deno's default client advertises h2 ALPN, the proxy selects h2, and
// the HTTP/1.1 WebSocket Upgrade is invalid over HTTP/2.
// See: https://github.com/denoland/deno/issues/16923
const wsHttpClient = Deno.createHttpClient({ http2: false });

function defaultCreateSocket(
  url: string,
  headers?: Record<string, string>,
): WebSocket {
  const opts: Record<string, unknown> = { client: wsHttpClient };
  if (headers && Object.keys(headers).length > 0) {
    opts.headers = headers;
  }
  return new WebSocket(url, opts);
}

interface OutboundRequest {
  type: "workflow.run" | "model.method.run" | "workflow.resume";
  payload: WorkflowRunPayload | ModelMethodRunPayload | WorkflowResumePayload;
}

type StreamOutcome =
  | { kind: "done" }
  | { kind: "disconnected" }
  | { kind: "elsewhere"; instanceId: string }
  | { kind: "interrupted"; instanceId: string; reason: string };

/**
 * Single-connection event stream. Yields deserialized run events and returns
 * an outcome indicating why the connection ended. The `state` object tracks
 * the runId and last seen seq across reconnections.
 */
async function* singleConnectionStream(
  options: ServerRunOptions,
  request: OutboundRequest | {
    type: "run.attach";
    payload: { runId: string; afterSeq: number };
  },
  state: { runId: string | undefined; lastSeq: number },
): AsyncGenerator<
  { kind: string; [key: string]: unknown },
  StreamOutcome
> {
  const baseUrl = normalizeServerUrl(options.server);
  const url = appendTokenToUrl(baseUrl, options.token);
  const headers = options.headers ?? resolveExtraHeaders();
  const requestId = crypto.randomUUID();
  const socket = (options.createSocket ?? defaultCreateSocket)(url, headers);

  const queue: ServerMessage[] = [];
  let wake: (() => void) | null = null;
  let socketClosed = false;
  let connectError: string | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };

  socket.onmessage = (event) => {
    if (typeof event.data !== "string") {
      return;
    }
    try {
      const message = JSON.parse(event.data) as ServerMessage;
      if (
        typeof message === "object" && message !== null &&
        "id" in message && message.id === requestId
      ) {
        queue.push(message);
        notify();
      }
    } catch {
      // Not a protocol frame — ignore.
    }
  };
  socket.onclose = () => {
    socketClosed = true;
    notify();
  };
  socket.onerror = (event) => {
    const detail = event instanceof ErrorEvent && event.message
      ? `: ${event.message}`
      : "";
    connectError = `Could not connect to ${baseUrl}${detail}`;
    notify();
  };

  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new UserError(
          `Timed out connecting to ${baseUrl} after ${CONNECT_TIMEOUT_MS}ms — is 'swamp serve' running?`,
        ),
      );
    }, CONNECT_TIMEOUT_MS);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    const earlyFail = (closeEvent?: CloseEvent) => {
      clearTimeout(timer);
      let message = connectError ??
        `Connection to ${baseUrl} closed before it opened`;
      if (closeEvent && !connectError) {
        const parts: string[] = [];
        if (closeEvent.code !== 1000 && closeEvent.code !== 1005) {
          parts.push(`code ${closeEvent.code}`);
        }
        if (closeEvent.reason) {
          parts.push(closeEvent.reason);
        }
        if (parts.length > 0) {
          message += ` (${parts.join(": ")})`;
        }
      }
      reject(new UserError(message));
    };
    const prevClose = socket.onclose;
    socket.onclose = (event) => {
      prevClose?.call(socket, event);
      earlyFail(event);
    };
  });

  let cancelSent = false;
  let cancelDeadline = Infinity;
  const onAbort = () => {
    if (!cancelSent && socket.readyState === WebSocket.OPEN) {
      cancelSent = true;
      cancelDeadline = Date.now() + CANCEL_DRAIN_MS;
      socket.send(JSON.stringify({ type: "cancel", id: requestId }));
      notify();
    }
  };

  try {
    try {
      await opened;
    } catch (err) {
      if (
        err instanceof UserError && (
          err.message.startsWith("Could not connect to") ||
          err.message.includes("closed before it opened")
        )
      ) {
        throw new UserError(
          await classifyConnectionError(baseUrl, err.message),
        );
      }
      throw err;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      throw new DOMException("Run was aborted", "AbortError");
    }
    socket.send(JSON.stringify({ ...request, id: requestId }));

    while (true) {
      const message = queue.shift();
      if (message !== undefined) {
        if (message.type === "done") {
          return { kind: "done" as const };
        }
        if (message.type === "error") {
          if (cancelSent || message.error.code === "cancelled") {
            throw new DOMException("Run was cancelled", "AbortError");
          }
          throw new UserError(
            `Server reported ${message.error.code}: ${message.error.message}`,
          );
        }
        if (message.type === "run.elsewhere") {
          return {
            kind: "elsewhere" as const,
            instanceId: message.payload.instanceId,
          };
        }
        if (message.type === "run.interrupted") {
          return {
            kind: "interrupted" as const,
            instanceId: message.payload.instanceId,
            reason: message.payload.reason,
          };
        }
        if (message.type === "event") {
          const event = deserializeEvent(message.event);
          if (
            typeof event === "object" && event !== null && "kind" in event &&
            "runId" in event
          ) {
            state.runId = event.runId as string;
          }
          if (
            typeof message.event === "object" && message.event !== null &&
            "seq" in message.event &&
            typeof message.event.seq === "number"
          ) {
            state.lastSeq = message.event.seq;
          }
          if (
            typeof event === "object" && event !== null && "kind" in event &&
            event.kind === "run.accepted"
          ) {
            continue;
          }
          yield event;
        }
        continue;
      }
      if (socketClosed) {
        if (state.runId) {
          return { kind: "disconnected" as const };
        }
        throw new UserError(
          "Connection to the server closed before the run completed",
        );
      }
      if (cancelSent && Date.now() > cancelDeadline) {
        throw new DOMException(
          "Run was cancelled (server did not confirm in time)",
          "AbortError",
        );
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (cancelSent) {
          setTimeout(resolve, 250);
        }
      });
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }
}

/**
 * One request, one event stream with automatic reconnection. The generator
 * completes on `done`, throws UserError on an `error` frame, and reconnects
 * transparently when the socket drops mid-run (if a runId is known).
 */
async function* streamServerRun(
  options: ServerRunOptions,
  request: OutboundRequest,
): AsyncIterable<{ kind: string; [key: string]: unknown }> {
  const state = { runId: undefined as string | undefined, lastSeq: 0 };
  let reconnectRetries = 0;
  let elsewhereRetries = 0;
  let currentRequest: OutboundRequest | {
    type: "run.attach";
    payload: { runId: string; afterSeq: number };
  } = request;
  const logger = getReconnectLogger(options);

  while (true) {
    let outcome: StreamOutcome;
    let receivedEvents = false;
    try {
      const stream = singleConnectionStream(options, currentRequest, state);
      while (true) {
        const result = await stream.next();
        if (result.done) {
          outcome = result.value;
          break;
        }
        receivedEvents = true;
        yield result.value;
      }
    } catch (err) {
      if (
        !state.runId || err instanceof DOMException ||
        err instanceof UserError
      ) {
        throw err;
      }
      outcome = { kind: "disconnected" };
    }

    if (receivedEvents) {
      reconnectRetries = 0;
      elsewhereRetries = 0;
    }

    if (outcome.kind === "done") {
      return;
    }

    if (outcome.kind === "interrupted") {
      throw new UserError(
        `Run was interrupted — the instance running it (${outcome.instanceId}) ` +
          "is no longer active. " +
          "Check the run's final status with: swamp run history",
      );
    }

    if (outcome.kind === "elsewhere") {
      elsewhereRetries++;
      if (elsewhereRetries > MAX_ELSEWHERE_RETRIES) {
        throw new UserError(
          "Run is on another instance but could not reach it after " +
            `${MAX_ELSEWHERE_RETRIES} retries. ` +
            "Check the run's final status with: swamp run history",
        );
      }
      logger(
        `Run is on another instance, retrying (${elsewhereRetries}/${MAX_ELSEWHERE_RETRIES})...`,
      );
      await delay(ELSEWHERE_RETRY_DELAY_MS, options.signal);
      currentRequest = {
        type: "run.attach",
        payload: { runId: state.runId!, afterSeq: state.lastSeq },
      };
      continue;
    }

    // disconnected — attempt reconnection
    reconnectRetries++;
    if (reconnectRetries > MAX_RECONNECT_RETRIES) {
      throw new UserError(
        "Connection lost and could not reconnect after " +
          `${MAX_RECONNECT_RETRIES} retries. ` +
          "Check the run's final status with: swamp run history",
      );
    }
    logger(
      `Connection dropped, reconnecting (${reconnectRetries}/${MAX_RECONNECT_RETRIES})...`,
    );
    await delay(1_000 * reconnectRetries, options.signal);
    currentRequest = {
      type: "run.attach",
      payload: { runId: state.runId!, afterSeq: state.lastSeq },
    };
  }
}

function getReconnectLogger(
  _options: ServerRunOptions,
): (msg: string) => void {
  return (msg: string) => {
    try {
      Deno.stderr.writeSync(new TextEncoder().encode(`\r\x1b[K${msg}\n`));
    } catch {
      // Ignore write errors (piped, closed, etc.)
    }
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
