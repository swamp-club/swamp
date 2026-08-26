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
 * client sends the token via the `Authorization: Bearer` header on the
 * WebSocket upgrade request. The token comes from (in precedence order):
 * the `--token` flag, the `SWAMP_SERVER_TOKEN` env var, or the
 * `~/.config/swamp/servers.json` file via `ServerCredentialRepository`.
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
 * Resolves the server URL from the `--server` flag with env var fallbacks.
 * Precedence: flag > SWAMP_SERVE_URL > SWAMP_SERVER_URL.
 */
export function resolveServeUrl(
  flagValue: string | undefined,
): string | undefined {
  return flagValue ?? Deno.env.get("SWAMP_SERVE_URL") ??
    Deno.env.get("SWAMP_SERVER_URL");
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
  /** PEM-encoded CA certificates to trust for TLS connections. */
  caCerts?: string[];
  /** Test seam: WebSocket factory. */
  createSocket?: (url: string, headers?: Record<string, string>) => WebSocket;
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
  /** PEM-encoded CA certificates to trust for TLS connections. */
  caCerts?: string[];
  createSocket?: (url: string, headers?: Record<string, string>) => WebSocket;
  timeoutMs?: number;
}

export function requestServerResponse<T>(
  options: RequestResponseOptions,
  request: { type: string; id?: string; payload?: unknown },
): Promise<T> {
  const baseUrl = normalizeServerUrl(options.server);
  const extraHeaders = options.headers ?? resolveExtraHeaders();
  const headers: Record<string, string> = { ...extraHeaders };
  if (options.token) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }
  const requestId = request.id ?? crypto.randomUUID();
  const socket = options.createSocket
    ? options.createSocket(baseUrl, headers)
    : createSocket(baseUrl, headers, options.caCerts);
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
      "Run through a 'swamp serve' server (ws:// or http://) instead of locally; no local repo required (env: SWAMP_SERVE_URL or SWAMP_SERVER_URL). For proxy/tunnel pass-through headers see SWAMP_SERVE_EXTRA_HEADERS.",
    )
    .option(
      "--token <token:string>",
      "Server token in <name>.<secret> format; only applies with --server (overrides stored credentials and SWAMP_SERVER_TOKEN)",
    )
    .option(
      "--ca-cert <path:string>",
      "Path to PEM-encoded CA certificate to trust for TLS connections to the server (env: SWAMP_CA_CERT)",
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
    const fetchClient = getCaCertFetchClient();
    const fetchOpts: Record<string, unknown> = {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    };
    if (fetchClient) fetchOpts.client = fetchClient;
    const response = await fetch(healthUrl, fetchOpts);
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
  const statusMatch = originalMessage.match(/Invalid status code: (\d+)/);
  if (statusMatch) {
    const statusCode = parseInt(statusMatch[1], 10);
    if (statusCode === 429) {
      return "Rate-limited by server — try again later";
    }
    if (statusCode === 401 || statusCode === 403) {
      return `Authentication failed — run: swamp auth server-login --server ${wsUrl}`;
    }
  }
  const tlsGuidance = diagnoseTlsMessage(originalMessage);
  if (tlsGuidance) return tlsGuidance;
  if (await probeServerHealth(wsUrl)) {
    return `Authentication failed — run: swamp auth server-login --server ${wsUrl}`;
  }
  return originalMessage;
}

const wsHttpClient = Deno.createHttpClient({});

let resolvedEnvCaCerts: string[] | undefined;

function resolveCaCertPath(): string | undefined {
  const envPath = Deno.env.get("SWAMP_CA_CERT");
  if (envPath) return envPath;
  // Handle both --ca-cert value and --ca-cert=value forms
  for (let i = 0; i < Deno.args.length; i++) {
    if (Deno.args[i] === "--ca-cert" && i + 1 < Deno.args.length) {
      return Deno.args[i + 1];
    }
    if (Deno.args[i].startsWith("--ca-cert=")) {
      return Deno.args[i].slice("--ca-cert=".length);
    }
  }
  return undefined;
}

export function getEnvCaCerts(): string[] | undefined {
  if (resolvedEnvCaCerts !== undefined) {
    return resolvedEnvCaCerts.length > 0 ? resolvedEnvCaCerts : undefined;
  }
  const certPath = resolveCaCertPath();
  if (!certPath) {
    resolvedEnvCaCerts = [];
    return undefined;
  }
  try {
    resolvedEnvCaCerts = [Deno.readTextFileSync(certPath)];
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new UserError(
      `Could not read CA certificate file '${certPath}': ${detail}`,
    );
  }
  return resolvedEnvCaCerts;
}

let cachedCaCertClient: Deno.HttpClient | undefined;

let cachedCaCertFetchClient: Deno.HttpClient | undefined;

function getCaCertFetchClient(): Deno.HttpClient | undefined {
  const caCerts = getEnvCaCerts();
  if (!caCerts?.length) return undefined;
  if (!cachedCaCertFetchClient) {
    cachedCaCertFetchClient = Deno.createHttpClient({ caCerts });
  }
  return cachedCaCertFetchClient;
}

function createSocket(
  url: string,
  headers?: Record<string, string>,
  caCerts?: string[],
): WebSocket {
  const effectiveCaCerts = caCerts ?? getEnvCaCerts();
  let client: Deno.HttpClient;
  if (effectiveCaCerts?.length) {
    if (!cachedCaCertClient) {
      cachedCaCertClient = Deno.createHttpClient({
        caCerts: effectiveCaCerts,
      });
    }
    client = cachedCaCertClient;
  } else {
    client = wsHttpClient;
  }
  const opts: Record<string, unknown> = { client };
  if (headers && Object.keys(headers).length > 0) {
    opts.headers = headers;
  }
  return new WebSocket(url, opts);
}

/**
 * Matches known TLS error patterns in the WebSocket error message and
 * returns user-friendly guidance. Returns `undefined` when the message
 * does not look like a TLS error.
 */
export function diagnoseTlsMessage(
  message: string,
): string | undefined {
  if (message.includes("CaUsedAsEndEntity")) {
    return (
      `TLS certificate rejected: the server certificate has ` +
      `basicConstraints CA:TRUE, which is invalid for a server ` +
      `(end-entity) certificate. Regenerate with ` +
      `"basicConstraints=critical,CA:FALSE" — restart swamp serve ` +
      `to see the exact openssl command`
    );
  }

  if (message.includes("UnknownIssuer")) {
    return (
      `TLS certificate rejected: the server's certificate issuer is ` +
      `not trusted. If using a self-signed certificate, pass it with ` +
      `--ca-cert /path/to/cert.pem or set SWAMP_CA_CERT=/path/to/cert.pem`
    );
  }

  if (message.includes("not valid for name")) {
    return (
      `TLS certificate rejected: the server's certificate does not ` +
      `match the hostname you connected to. Check that the URL matches ` +
      `the certificate's subject or SAN entries`
    );
  }

  if (message.includes("expired") || message.includes("NotValidYet")) {
    return `TLS certificate rejected: ${message}`;
  }

  if (message.includes("invalid peer certificate")) {
    return `TLS certificate rejected: ${message}`;
  }

  return undefined;
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
  const extraHeaders = options.headers ?? resolveExtraHeaders();
  const headers: Record<string, string> = { ...extraHeaders };
  if (options.token) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }
  const requestId = crypto.randomUUID();
  const socket = options.createSocket
    ? options.createSocket(baseUrl, headers)
    : createSocket(baseUrl, headers, options.caCerts);

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
  const logger = getReconnectLogger();

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
        err instanceof UserError || !(err instanceof Error)
      ) {
        throw err;
      }
      const msg = err.message ?? "";
      if (
        !msg.includes("connect") && !msg.includes("closed") &&
        !msg.includes("Connection")
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

function getReconnectLogger(): (msg: string) => void {
  const isTty = Deno.stderr.isTerminal();
  return (msg: string) => {
    try {
      const prefix = isTty ? "\r\x1b[K" : "";
      Deno.stderr.writeSync(new TextEncoder().encode(`${prefix}${msg}\n`));
    } catch {
      // Ignore write errors (piped, closed, etc.)
    }
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
