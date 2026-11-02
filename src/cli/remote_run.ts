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

import type { Command } from "@cliffy/command";
import { getLogger } from "@logtape/logtape";
import { errorPaths, markErrorPaths, UserError } from "../domain/errors.ts";
import type { OutputMode } from "../presentation/output/output.ts";
import {
  HTTP_REQUEST_TYPES,
  type ModelMethodRunPayload,
  SERVE_REQUEST_PATH,
  type ServerMessage,
  USE_WEBSOCKET_CODE,
  type WorkflowResumePayload,
  type WorkflowRunPayload,
} from "../serve/protocol.ts";
import { deserializeEvent } from "../serve/serializer.ts";
import type { ServerCredentialRepository } from "../domain/auth/server_credential.ts";
import {
  normalizeServerUrl as normalizeServerUrlForCredentials,
  redactServerUrl,
} from "../domain/auth/server_url.ts";
import { FileServerCredentialRepository } from "../infrastructure/persistence/server_credential_repository.ts";
import { resolveExtraHeaders } from "../domain/auth/extra_headers.ts";
import {
  recordWithheldTokenFile,
  serverLoginHint,
  withheldTokenFileMessage,
  type WithheldTokenFileRemedy,
} from "../domain/auth/server_login_hint.ts";
import { quoteShellWord } from "../domain/shell_word.ts";
import { processLockHolderMarker } from "../domain/datastore/lock_holder_marker.ts";
import {
  gutterLine,
  STATUS_COLORS,
} from "../presentation/output/console_writer.ts";

const logger = getLogger(["swamp", "cli", "remote-run"]);

let _cachedMarkerServerAddress: string | undefined;

export function setMarkerServerAddress(value: string | undefined): void {
  _cachedMarkerServerAddress = value;
}

export function resetMarkerServerAddress(): void {
  _cachedMarkerServerAddress = undefined;
}

/**
 * off for a command that runs locally with serve as its v3 datastore's
 * upstream: only an explicit --server then runs it remotely
 */
let _implicitServeRouting = true;

export function setImplicitServeRouting(on: boolean): void {
  _implicitServeRouting = on;
}

export function resetImplicitServeRouting(): void {
  _implicitServeRouting = true;
}

/**
 * precedence: flag > SWAMP_SERVE_URL > SWAMP_SERVER_URL > .swamp.yaml
 * serverAddress; only the flag counts for a command running locally with serve
 * as its datastore upstream
 */
export function resolveServeUrl(
  flagValue: string | undefined,
  markerValue?: string,
): string | undefined {
  if (flagValue !== undefined) return flagValue;
  return _implicitServeRouting ? implicitServeUrl(markerValue) : undefined;
}

export function implicitServeUrl(markerValue?: string): string | undefined {
  return Deno.env.get("SWAMP_SERVE_URL") ??
    Deno.env.get("SWAMP_SERVER_URL") ?? markerValue ??
    _cachedMarkerServerAddress;
}

/**
 * takes only explicit flag values, since env vars and the repo marker already
 * carry over; the server URL loses userinfo, query and fragment because serve
 * accepts a token as a query parameter
 */
export function formatCommandTarget(
  flags: { server?: string; repoDir?: string },
): string {
  let target = "";
  if (flags.server) {
    const server = serverWithoutCredentials(flags.server);
    if (server) target += ` --server ${quoteShellWord(server)}`;
  }
  if (flags.repoDir) {
    target += ` --repo-dir ${quoteShellWord(flags.repoDir)}`;
  }
  return target;
}

function serverWithoutCredentials(server: string): string | undefined {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    return undefined;
  }
  if (!url.host) return undefined;
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${url.protocol}//${url.host}${path}`;
}

let _remoteIndicatorSilent = false;

/**
 * a JSON error goes to stderr too, so a command routed to serve by the marker
 * or env stays one JSON document; an explicit --server keeps its indicator
 */
export function setRemoteIndicatorMode(
  mode: OutputMode,
  explicitServer: boolean,
): void {
  _remoteIndicatorSilent = mode === "json" && !explicitServer;
}

export function resetRemoteIndicatorMode(): void {
  _remoteIndicatorSilent = false;
}

export function writeRemoteIndicator(serverUrl: string): void {
  if (_remoteIndicatorSilent) return;
  console.error(
    gutterLine(
      "Remote",
      STATUS_COLORS.warn,
      redactServerUrl(serverUrl) ?? "(invalid URL)",
    ),
  );
}

function formatServerError(
  error: { code: string; message: string; details?: unknown },
): string {
  const exType = error.details != null &&
      typeof error.details === "object" &&
      "exceptionType" in error.details &&
      typeof (error.details as Record<string, unknown>).exceptionType ===
        "string"
    ? (error.details as Record<string, unknown>).exceptionType as string
    : undefined;
  const qualifier = exType !== undefined ? ` (${exType})` : "";
  return `Server reported ${error.code}${qualifier}: ${error.message}`;
}

/**
 * keeps the error's details for a command to read; they are the server's and
 * untrusted
 */
export class ServerResponseError extends UserError {
  readonly details: unknown;

  constructor(error: { code: string; message: string; details?: unknown }) {
    super(formatServerError(error), error.code);
    this.name = "UserError";
    this.details = error.details;
  }
}

const CANCEL_DRAIN_MS = 10_000;

const CONNECT_TIMEOUT_MS = 15_000;

const MAX_RECONNECT_RETRIES = 5;

const MAX_ELSEWHERE_RETRIES = 10;

const ELSEWHERE_RETRY_DELAY_MS = 1_500;

export interface ServerRunOptions {
  server: string;
  token?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  caCerts?: string[];
  createSocket?: (url: string, headers?: Record<string, string>) => WebSocket;
}

/** stored credentials are keyed by http(s) URL, but --server often uses ws(s) */
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

export async function readTokenFile(
  path: string,
  flagName: string,
): Promise<string> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw markErrorPaths(
        new UserError(`${flagName} file not found: ${path}`),
        [path],
      );
    }
    if (err instanceof Deno.errors.PermissionDenied) {
      throw markErrorPaths(
        new UserError(`${flagName} file not readable: ${path}`),
        [path],
      );
    }
    throw err;
  }
  const value = raw.replace(/\r?\n$/, "");
  if (value === "") {
    throw markErrorPaths(
      new UserError(`${flagName} file is empty: ${path}`),
      [path],
    );
  }
  return value;
}

/**
 * an unset, empty or unparseable address names nothing, so a .swamp.yaml
 * serverAddress alone never binds the token file
 */
export function tokenFileBoundTo(
  key: string,
  addresses: readonly (string | undefined)[],
): boolean {
  return addresses.some((value) => {
    if (!value) return false;
    try {
      return normalizeServerUrlForCredentials(value) === key;
    } catch {
      return false;
    }
  });
}

/**
 * warns once per address that the token file was not sent and no other source
 * supplied a token, and records it so a 401 says why. names only the normalized
 * address, never the file's path or contents
 */
export function warnWithheldTokenFile(
  key: string,
  remedy: WithheldTokenFileRemedy,
): void {
  if (recordWithheldTokenFile(key, remedy)) {
    logger.warn(withheldTokenFileMessage(key, remedy));
  }
}

/**
 * serverFlag is the raw --server value, never the resolved URL: a .swamp.yaml
 * serverAddress passed there would receive a token file meant for another
 * server
 */
export async function resolveServerToken(
  serverUrl: string,
  explicitToken?: string,
  credentialRepo?: ServerCredentialRepository,
  serverFlag?: string,
): Promise<string | undefined> {
  const key = parseServerFlag(serverUrl);
  if (explicitToken) return explicitToken;
  const envTokenFile = Deno.env.get("SWAMP_SERVER_TOKEN_FILE");
  if (envTokenFile) {
    const bound = tokenFileBoundTo(key, [
      serverFlag,
      Deno.env.get("SWAMP_SERVE_URL"),
      Deno.env.get("SWAMP_SERVER_URL"),
    ]);
    if (bound) return readTokenFile(envTokenFile, "SWAMP_SERVER_TOKEN_FILE");
  }
  const repo = credentialRepo ?? new FileServerCredentialRepository();
  const credential = await repo.get(serverUrl);
  // A set token file that reached here was not bound to the address.
  if (!credential?.token && envTokenFile) {
    warnWithheldTokenFile(key, "flag-or-env");
  }
  return credential?.token;
}

/**
 * options.server must be the --server flag as parsed, not the resolved URL: it
 * is what binds SWAMP_SERVER_TOKEN_FILE
 */
export async function resolveServerTokenFromOptions(
  serverUrl: string,
  options: { server?: unknown; token?: unknown; tokenFile?: unknown },
  credentialRepo?: ServerCredentialRepository,
): Promise<string | undefined> {
  const token = options.token as string | undefined;
  const tokenFile = options.tokenFile as string | undefined;
  if (token && tokenFile) {
    throw new UserError(
      "--token and --token-file are mutually exclusive",
    );
  }
  const explicitToken = tokenFile
    ? await readTokenFile(tokenFile, "--token-file")
    : token;
  return resolveServerToken(
    serverUrl,
    explicitToken,
    credentialRepo,
    options.server as string | undefined,
  );
}

/** the UserError never echoes credentials (userinfo, ?token=) */
function parseServerFlag(server: string): string {
  try {
    return normalizeServerUrlForCredentials(server);
  } catch {
    const shown = redactServerUrl(server);
    throw new UserError(
      `Invalid --server URL${
        shown === undefined ? "" : ` '${shown}'`
      } — expected ws://host:port (or http://)`,
    );
  }
}

export function toWebSocketUrl(server: string): string {
  const parsed = new URL(parseServerFlag(server));
  if (parsed.protocol === "http:") {
    parsed.protocol = "ws:";
  } else if (parsed.protocol === "https:") {
    parsed.protocol = "wss:";
  }
  return parsed.href;
}

/**
 * when the server is the swamp whose step started this process, a nested swamp
 * under the requested run skips that step's lock instead of waiting on it
 */
function withForwardedLocks<P extends { lockHolderTokens?: string }>(
  payload: P,
): P {
  const lockHolderTokens = processLockHolderMarker.forwardedLockTokens();
  return lockHolderTokens === undefined
    ? payload
    : { ...payload, lockHolderTokens };
}

export function runWorkflowOverServer(
  options: ServerRunOptions & {
    payload: WorkflowRunPayload;
    /**
     * stop listening once the server has started the run; the socket closes
     * without a cancel so the run carries on. No locks are forwarded, since a
     * detached run outlives the step that holds them
     */
    detach?: boolean;
  },
): AsyncIterable<{ kind: string; [key: string]: unknown }> {
  if (options.detach) {
    return untilRunStarted(streamServerRun(options, {
      type: "workflow.run",
      payload: options.payload,
    }));
  }
  return streamServerRun(options, {
    type: "workflow.run",
    payload: withForwardedLocks(options.payload),
  });
}

/**
 * a nested workflow's started event carries parentRunId and does not end the
 * stream
 */
async function* untilRunStarted(
  stream: AsyncIterable<{ kind: string; [key: string]: unknown }>,
): AsyncIterable<{ kind: string; [key: string]: unknown }> {
  for await (const event of stream) {
    yield event;
    if (event.kind === "started" && !("parentRunId" in event)) return;
  }
}

export function runModelMethodOverServer(
  options: ServerRunOptions & { payload: ModelMethodRunPayload },
): AsyncIterable<{ kind: string; [key: string]: unknown }> {
  return streamServerRun(options, {
    type: "model.method.run",
    payload: withForwardedLocks(options.payload),
  });
}

export function resumeWorkflowOverServer(
  options: ServerRunOptions & { payload: WorkflowResumePayload },
): AsyncIterable<{ kind: string; [key: string]: unknown }> {
  return streamServerRun(options, {
    type: "workflow.resume",
    payload: withForwardedLocks(options.payload),
  });
}

const DEFAULT_TIMEOUT_MS = 30_000;

function resolveRequestTimeoutMs(): number {
  const env = Deno.env.get("SWAMP_SERVE_TIMEOUT_MS");
  if (env !== undefined) {
    const parsed = parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TIMEOUT_MS;
}

/**
 * an older server answers invalid_request, which says nothing useful, so it is
 * reported as needing an upgrade; the caller must send a well-formed request or
 * its own mistake reads the same
 */
export async function requestNewerServerResponse<T>(
  feature: string,
  options: RequestResponseOptions,
  request: { type: string; id?: string; payload?: unknown },
): Promise<T> {
  try {
    return await requestServerResponse<T>(options, request);
  } catch (error) {
    if (error instanceof UserError && error.code === "invalid_request") {
      throw new UserError(
        `The server does not support ${feature}; upgrade swamp on the server.`,
        "unsupported_by_server",
      );
    }
    throw error;
  }
}

export interface RequestResponseOptions {
  server: string;
  token?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  caCerts?: string[];
  createSocket?: (url: string, headers?: Record<string, string>) => WebSocket;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * older servers ignore the parameter and keep sending text frames, which are
 * still handled
 */
function withCompressionOptIn(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("compress", "gzip");
  return parsed.href;
}

async function gunzipFrame(data: ArrayBuffer): Promise<string> {
  const stream = new Blob([data]).stream().pipeThrough(
    new DecompressionStream("gzip"),
  );
  return await new Response(stream).text();
}

/**
 * reads whose replies can outgrow a WebSocket frame go over serve's HTTP
 * route; a serve that predates the route answers 404 and the socket is used
 */
export async function requestServerResponse<T>(
  options: RequestResponseOptions,
  request: { type: string; id?: string; payload?: unknown },
): Promise<T> {
  writeRemoteIndicator(options.server);
  if (HTTP_REQUEST_TYPES.has(request.type)) {
    const outcome = await requestOverHttp<T>(options, request);
    if (outcome.kind === "payload") return outcome.payload;
  }
  return await requestOverSocket<T>(options, request);
}

type HttpRequestOutcome<T> =
  | { kind: "payload"; payload: T }
  | { kind: "route_missing" };

async function requestOverHttp<T>(
  options: RequestResponseOptions,
  request: { type: string; id?: string; payload?: unknown },
): Promise<HttpRequestOutcome<T>> {
  const baseUrl = toWebSocketUrl(options.server);
  const headers: Record<string, string> = {
    ...(options.headers ?? resolveExtraHeaders()),
    "content-type": "application/json",
  };
  if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
  const requestId = request.id ?? crypto.randomUUID();
  const timeoutMs = options.timeoutMs ?? resolveRequestTimeoutMs();
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([timeout, options.signal])
    : timeout;
  const caCerts = options.caCerts ?? getEnvCaCerts();
  const ownClient = caCerts?.length
    ? createTlsHttpClient({ caCerts })
    : undefined;
  const failure = (err: unknown): Error => {
    if (timeout.aborted) {
      return new UserError(
        `Request timed out after ${timeoutMs}ms — if the server needs more time, set SWAMP_SERVE_TIMEOUT_MS to a higher value`,
      );
    }
    if (options.signal?.aborted) {
      return new DOMException("Request was aborted", "AbortError");
    }
    return err instanceof Error ? err : new Error(String(err));
  };
  try {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(
        `${toHttpUrl(baseUrl)}${SERVE_REQUEST_PATH}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ ...request, id: requestId }),
          client: ownClient ?? getDefaultHttpClient(),
          signal,
          // a redirect would carry the token and pass-through headers elsewhere
          redirect: "manual",
        },
      );
    } catch (err) {
      const failed = failure(err);
      if (failed instanceof UserError || failed instanceof DOMException) {
        throw failed;
      }
      throw new UserError(
        await classifyConnectionError(
          baseUrl,
          `Could not connect to ${baseUrl}: ${failed.message}`,
          headers,
          options.caCerts,
        ),
      );
    }
    if (!response.ok) {
      const refusal = await readServeRefusal(response);
      // a serve that predates the route, a proxy that does not pass it, or a
      // route that sends the request back: the socket answered these before
      if (
        response.status === 404 || response.status === 405 ||
        refusal === undefined || refusal.code === USE_WEBSOCKET_CODE
      ) {
        return { kind: "route_missing" };
      }
      throw httpRefusal(baseUrl, response.status, refusal);
    }
    let body: string;
    try {
      body = await response.text();
    } catch (err) {
      const failed = failure(err);
      if (failed instanceof UserError || failed instanceof DOMException) {
        throw failed;
      }
      throw new UserError(
        `Connection to ${baseUrl} closed before a response was received: ${failed.message}`,
      );
    }
    for (const line of body.split("\n")) {
      if (line === "") continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        typeof message !== "object" || message === null ||
        !("id" in message) || message.id !== requestId ||
        !("type" in message)
      ) continue;
      if (message.type === "error" && "error" in message) {
        throw new ServerResponseError(
          message.error as { code: string; message: string; details?: unknown },
        );
      }
      if ("payload" in message) {
        return { kind: "payload", payload: message.payload as T };
      }
    }
    throw new UserError(
      `Connection to ${baseUrl} closed before a response was received`,
    );
  } finally {
    ownClient?.close();
  }
}

interface ServeRefusal {
  readonly code: string;
  readonly message: string;
  readonly leader?: unknown;
}

async function readServeRefusal(
  response: Response,
): Promise<ServeRefusal | undefined> {
  let body: { code?: unknown; message?: unknown; leader?: unknown };
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  if (typeof body?.code !== "string" || typeof body.message !== "string") {
    return undefined;
  }
  return { code: body.code, message: body.message, leader: body.leader };
}

function httpRefusal(
  baseUrl: string,
  status: number,
  refusal: ServeRefusal,
): Error {
  if (status === 401 || status === 403) {
    return new UserError(authFailedMessage(baseUrl));
  }
  if (status === 429) {
    return new UserError(
      describeHandshakeStatus(baseUrl, 429, "Rate-limited by server"),
    );
  }
  return new ServerResponseError({
    code: refusal.code,
    message: refusal.message,
    ...(refusal.leader !== undefined &&
      { details: { leader: refusal.leader } }),
  });
}

function requestOverSocket<T>(
  options: RequestResponseOptions,
  request: { type: string; id?: string; payload?: unknown },
): Promise<T> {
  const baseUrl = toWebSocketUrl(options.server);
  const extraHeaders = options.headers ?? resolveExtraHeaders();
  const headers: Record<string, string> = { ...extraHeaders };
  if (options.token) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }
  const requestId = request.id ?? crypto.randomUUID();
  const socketUrl = withCompressionOptIn(baseUrl);
  const socket = options.createSocket
    ? options.createSocket(socketUrl, headers)
    : createSocket(socketUrl, headers, options.caCerts);
  socket.binaryType = "arraybuffer";
  const timeoutMs = options.timeoutMs ?? resolveRequestTimeoutMs();

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
            `Request timed out after ${timeoutMs}ms — if the server needs more time, set SWAMP_SERVE_TIMEOUT_MS to a higher value`,
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
    let opened = false;
    socket.onerror = (event) => {
      if (event instanceof ErrorEvent && event.message) {
        connectErrorDetail = `: ${event.message}`;
      }
      if (!settled) {
        settled = true;
        cleanup();
        reject(
          new UserError(
            opened
              ? `Connection to ${baseUrl} closed before a response was received${connectErrorDetail}`
              : `Could not connect to ${baseUrl}${connectErrorDetail}`,
          ),
        );
      }
    };

    socket.onclose = (event) => {
      if (!settled) {
        settled = true;
        cleanup();
        const detail = describeServerClose(event);
        reject(
          new UserError(
            connectErrorDetail && !opened
              ? `Could not connect to ${baseUrl}${connectErrorDetail}`
              : `Connection closed before a response was received${detail}`,
          ),
        );
      }
    };

    socket.onopen = () => {
      opened = true;
      socket.send(
        JSON.stringify({ ...request, id: requestId }),
      );
    };

    const handleFrame = (text: string) => {
      try {
        const message = JSON.parse(text);
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
          reject(new ServerResponseError(message.error));
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

    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        handleFrame(event.data);
        return;
      }
      if (!(event.data instanceof ArrayBuffer)) return;
      gunzipFrame(event.data).then(handleFrame).catch((err: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          socket.close();
        } catch { /* already closed */ }
        reject(
          new UserError(
            `Could not decode a compressed response from ${baseUrl}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      });
    };
  });

  return raw.catch(async (err: unknown) => {
    if (
      err instanceof UserError &&
      err.message.startsWith("Could not connect to")
    ) {
      throw new UserError(
        await classifyConnectionError(
          baseUrl,
          err.message,
          headers,
          options.caCerts,
        ),
      );
    }
    throw err;
  });
}

export async function* streamServerResponse<T extends { done?: boolean }>(
  options: RequestResponseOptions,
  request: { type: string; id?: string; payload?: unknown },
): AsyncGenerator<T> {
  writeRemoteIndicator(options.server);
  const baseUrl = toWebSocketUrl(options.server);
  const extraHeaders = options.headers ?? resolveExtraHeaders();
  const headers: Record<string, string> = { ...extraHeaders };
  if (options.token) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }
  const requestId = request.id ?? crypto.randomUUID();
  const socket = options.createSocket
    ? options.createSocket(baseUrl, headers)
    : createSocket(baseUrl, headers, options.caCerts);
  const timeoutMs = options.timeoutMs ?? resolveRequestTimeoutMs();

  type QueueItem =
    | { kind: "message"; data: T }
    | { kind: "error"; error: Error }
    | { kind: "close" };

  const queue: QueueItem[] = [];
  let resolve: (() => void) | null = null;

  function enqueue(item: QueueItem) {
    queue.push(item);
    if (resolve) {
      resolve();
      resolve = null;
    }
  }

  function waitForItem(): Promise<void> {
    if (queue.length > 0) return Promise.resolve();
    return new Promise<void>((r) => {
      resolve = r;
    });
  }

  const timer = setTimeout(() => {
    try {
      socket.close();
    } catch { /* already closed */ }
    enqueue({
      kind: "error",
      error: new UserError(
        `Request timed out after ${timeoutMs}ms — if the server needs more time, set SWAMP_SERVE_TIMEOUT_MS to a higher value`,
      ),
    });
  }, timeoutMs);

  const onAbort = () => {
    clearTimeout(timer);
    try {
      socket.close();
    } catch { /* already closed */ }
    enqueue({ kind: "close" });
  };

  options.signal?.addEventListener("abort", onAbort, { once: true });

  socket.onerror = (event) => {
    const msg = event instanceof ErrorEvent ? event.message : "unknown";
    enqueue({ kind: "error", error: new UserError(`WebSocket error: ${msg}`) });
  };

  socket.onclose = () => {
    enqueue({ kind: "close" });
  };

  socket.onopen = () => {
    socket.send(JSON.stringify({ ...request, id: requestId }));
  };

  socket.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    try {
      const message = JSON.parse(event.data) as Record<string, unknown>;
      if (typeof message !== "object" || message === null) return;
      if (message.id !== requestId) return;
      if (message.type === "error") {
        enqueue({
          kind: "error",
          error: new UserError(
            formatServerError(
              message.error as { code: string; message: string },
            ),
          ),
        });
        return;
      }
      if ("payload" in message) {
        enqueue({ kind: "message", data: message.payload as T });
      }
    } catch { /* not a protocol frame */ }
  };

  try {
    while (true) {
      await waitForItem();
      while (queue.length > 0) {
        const item = queue.shift()!;
        if (item.kind === "close") return;
        if (item.kind === "error") throw item.error;
        yield item.data;
        if (item.data.done) return;
      }
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    try {
      socket.close();
    } catch { /* already closed */ }
  }
}

export interface SubscribeServerOptions {
  readonly server: string;
  readonly token: string | undefined;
  readonly signal?: AbortSignal;
  readonly caCerts?: string[];
  readonly headers?: Record<string, string>;
}

export async function* subscribeServerEvents(
  options: SubscribeServerOptions,
  request: { type: string; payload?: unknown },
): AsyncGenerator<Record<string, unknown>> {
  const baseUrl = toWebSocketUrl(options.server);
  const extraHeaders = options.headers ?? resolveExtraHeaders();
  const headers: Record<string, string> = { ...extraHeaders };
  if (options.token) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }
  const requestId = crypto.randomUUID();
  const socket = createSocket(baseUrl, headers, options.caCerts);

  type QueueItem =
    | { kind: "message"; data: Record<string, unknown> }
    | { kind: "error"; error: Error }
    | { kind: "close" };

  const queue: QueueItem[] = [];
  let resolve: (() => void) | null = null;
  let subscriptionId: string | undefined;

  function enqueue(item: QueueItem) {
    queue.push(item);
    if (resolve) {
      resolve();
      resolve = null;
    }
  }

  function waitForItem(): Promise<void> {
    if (queue.length > 0) return Promise.resolve();
    return new Promise<void>((r) => {
      resolve = r;
    });
  }

  const onAbort = () => {
    if (socket.readyState === WebSocket.OPEN && subscriptionId) {
      socket.send(JSON.stringify({
        type: "audit.unsubscribe",
        id: crypto.randomUUID(),
      }));
    }
    try {
      socket.close();
    } catch { /* already closed */ }
    enqueue({ kind: "close" });
  };

  options.signal?.addEventListener("abort", onAbort, { once: true });

  socket.onerror = (event) => {
    const msg = event instanceof ErrorEvent ? event.message : "unknown";
    enqueue({ kind: "error", error: new UserError(`WebSocket error: ${msg}`) });
  };

  socket.onclose = () => {
    enqueue({ kind: "close" });
  };

  socket.onopen = () => {
    socket.send(JSON.stringify({ ...request, id: requestId }));
  };

  socket.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    try {
      const message = JSON.parse(event.data) as Record<string, unknown>;
      if (typeof message !== "object" || message === null) return;

      if (message.type === "error" && message.id === requestId) {
        enqueue({
          kind: "error",
          error: new UserError(
            formatServerError(
              message.error as { code: string; message: string },
            ),
          ),
        });
        return;
      }

      if (
        message.type === "audit.subscribe" && message.id === requestId &&
        message.payload
      ) {
        const payload = message.payload as { subscriptionId: string };
        subscriptionId = payload.subscriptionId;
        return;
      }

      if (message.type === "audit.event" && message.payload) {
        enqueue({
          kind: "message",
          data: (message.payload as { event: Record<string, unknown> }).event,
        });
      }
    } catch { /* not a protocol frame */ }
  };

  try {
    while (true) {
      await waitForItem();
      while (queue.length > 0) {
        const item = queue.shift()!;
        if (item.kind === "close") return;
        if (item.kind === "error") throw item.error;
        yield item.data;
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    try {
      socket.close();
    } catch { /* already closed */ }
  }
}

// deno-lint-ignore no-explicit-any
type AnyCommand = Command<any, any, any, any, any, any, any, any>;

/**
 * every command that takes --server must declare it: the TLS UnknownIssuer
 * guidance tells users to pass it, and resolveCaCertPath reads it from
 * Deno.args once Cliffy accepts it
 */
export const CA_CERT_FLAG = "--ca-cert <path:string>";
export const TOKEN_FILE_DESCRIPTION =
  "Path to a file containing the server token; mutually exclusive with --token (env: SWAMP_SERVER_TOKEN_FILE, used only for the server named by --server, SWAMP_SERVE_URL or SWAMP_SERVER_URL)";
export const CA_CERT_DESCRIPTION =
  "Path to PEM-encoded CA certificate to trust for TLS connections to the server (env: SWAMP_CA_CERT)";

export const SERVER_DESCRIPTION =
  "Run through a 'swamp serve' server (ws:// or http://) instead of locally; no local repo required (env: SWAMP_SERVE_URL or SWAMP_SERVER_URL; in a checkout whose datastore is format 3, only this flag runs it on serve, and the env makes serve its datastore's upstream). For proxy/tunnel pass-through headers see SWAMP_SERVE_EXTRA_HEADERS.";

/** for commands serve decides, which go to a named serve without --server */
export const DECIDED_ON_SERVE_SERVER_DESCRIPTION =
  "The 'swamp serve' server (ws:// or http://) to send this to; no local repo required. Without it, this goes to the serve named by SWAMP_SERVE_URL, SWAMP_SERVER_URL or serverAddress in .swamp.yaml, which every checkout in team mode has, and runs locally when none is named. For proxy/tunnel pass-through headers see SWAMP_SERVE_EXTRA_HEADERS.";

export const TOKEN_DESCRIPTION =
  "Server token in <name>.<secret> format; only applies with --server (overrides stored credentials and SWAMP_SERVER_TOKEN)";

export const DECIDED_ON_SERVE_TOKEN_DESCRIPTION =
  "Server token in <name>.<secret> format for the serve this command reaches, with or without --server (overrides stored credentials and SWAMP_SERVER_TOKEN)";

export interface RemoteOptionTexts {
  readonly server?: string;
  readonly token?: string;
}

export const DECIDED_ON_SERVE_OPTION_TEXTS: RemoteOptionTexts = {
  server: DECIDED_ON_SERVE_SERVER_DESCRIPTION,
  token: DECIDED_ON_SERVE_TOKEN_DESCRIPTION,
};

export function withRemoteOptions<T extends AnyCommand>(
  command: T,
  texts: RemoteOptionTexts = {},
): T {
  return command
    .option("--server <url:string>", texts.server ?? SERVER_DESCRIPTION)
    .option("--token <token:string>", texts.token ?? TOKEN_DESCRIPTION)
    .option(
      "--token-file <path:string>",
      TOKEN_FILE_DESCRIPTION,
    )
    .option(CA_CERT_FLAG, CA_CERT_DESCRIPTION) as T;
}

export function serverReloadCommand(server: string): string {
  return `swamp serve reload${formatCommandTarget({ server })}`;
}

const HANDSHAKE_PROBE_TIMEOUT_MS = 3_000;

/**
 * over TLS Deno's WebSocket negotiates HTTP/2, which hides a rejected
 * handshake's status; HTTP/1.1 shows it. The probe omits Authorization so it
 * cannot lock a token out
 */
export async function probeHandshakeStatus(
  wsUrl: string,
  headers: Record<string, string> = {},
  caCerts?: string[],
): Promise<number | undefined> {
  let client: Deno.HttpClient | undefined;
  try {
    const effectiveCaCerts = caCerts ?? getEnvCaCerts();
    client = createTlsHttpClient({
      http1: true,
      http2: false,
      ...(effectiveCaCerts?.length ? { caCerts: effectiveCaCerts } : {}),
    });
    const probeHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() !== "authorization") probeHeaders[name] = value;
    }
    const response = await fetch(toHttpUrl(wsUrl), {
      client,
      headers: {
        ...probeHeaders,
        "Upgrade": "websocket",
        "Connection": "Upgrade",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomWebSocketKey(),
      },
      // A WebSocket handshake never follows a redirect; following one would
      // carry the pass-through headers (often proxy credentials) elsewhere.
      redirect: "manual",
      signal: AbortSignal.timeout(HANDSHAKE_PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.status;
  } catch {
    return undefined;
  } finally {
    client?.close();
  }
}

function randomWebSocketKey(): string {
  let binary = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function describeHandshakeStatus(
  wsUrl: string,
  statusCode: number,
  originalMessage: string,
): string {
  if (statusCode === 429) {
    return "Rate-limited by server — try again later";
  }
  if (statusCode === 401 || statusCode === 403) {
    return authFailedMessage(wsUrl);
  }
  if (statusCode >= 500) {
    return `Server error (HTTP ${statusCode}) while connecting to ${wsUrl} — check the server log for the cause`;
  }
  return originalMessage;
}

function authFailedMessage(wsUrl: string): string {
  return serverLoginHint(wsUrl);
}

/**
 * a 401/403 to the tokenless probe only shows the server wants a token; over
 * ws:// a rejected token would have carried its own status, over wss:// it may
 * be hidden behind HTTP/2, so auth guidance stays
 */
export function describeStatuslessFailure(
  wsUrl: string,
  originalMessage: string,
  probedStatus: number | undefined,
  sentToken: boolean,
): string {
  if (probedStatus === undefined) return originalMessage;
  if (probedStatus === 401 || probedStatus === 403) {
    if (!sentToken) return authFailedMessage(wsUrl);
    if (new URL(wsUrl).protocol === "wss:") {
      return `${authFailedMessage(wsUrl)} (${originalMessage})`;
    }
    return originalMessage;
  }
  return describeHandshakeStatus(wsUrl, probedStatus, originalMessage);
}

async function classifyConnectionError(
  wsUrl: string,
  originalMessage: string,
  headers: Record<string, string>,
  caCerts: string[] | undefined,
): Promise<string> {
  const statusMatch = originalMessage.match(/Invalid status code: (\d+)/);
  if (statusMatch) {
    // the server answered with a status of its own; the probe below only covers
    // connections that never got one
    return describeHandshakeStatus(
      wsUrl,
      parseInt(statusMatch[1], 10),
      originalMessage,
    );
  }
  const tlsGuidance = diagnoseTlsMessage(originalMessage);
  if (tlsGuidance) return tlsGuidance;
  const sentToken = Object.keys(headers).some((name) =>
    name.toLowerCase() === "authorization"
  );
  return describeStatuslessFailure(
    wsUrl,
    originalMessage,
    await probeHandshakeStatus(wsUrl, headers, caCerts),
    sentToken,
  );
}

/**
 * every client shares the process-wide rustls root store; caCerts are added on top,
 * so --ca-cert does not avoid a failing store read, only DENO_TLS_CA_STORE=mozilla
 * does. create is injected so the failure path can be tested
 */
export function createTlsHttpClient(
  options: Deno.CreateHttpClientOptions = {},
  create: typeof Deno.createHttpClient = Deno.createHttpClient,
): Deno.HttpClient {
  try {
    return create(options);
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new UserError(
      `Could not read the OS certificate store: ${detail} — swamp defaults ` +
        `DENO_TLS_CA_STORE to "system,mozilla"; re-run with ` +
        `DENO_TLS_CA_STORE=mozilla to use Deno's bundled roots instead ` +
        `(also pass --ca-cert /path/to/ca.pem if the server needs a ` +
        `private root)`,
    );
  }
}

let wsHttpClient: Deno.HttpClient | undefined;

/**
 * created on first use: creating it at module load crashed offline commands on
 * machines whose platform certificate store cannot be read
 */
export function getDefaultHttpClient(): Deno.HttpClient {
  if (!wsHttpClient) wsHttpClient = createTlsHttpClient();
  return wsHttpClient;
}

let resolvedEnvCaCerts: string[] | undefined;

/** an empty value from either source counts as unset */
export function resolveCaCertPath(
  args: readonly string[],
  envPath: string | undefined,
): string | undefined {
  for (let i = 0; i < args.length; i++) {
    let flagPath: string | undefined;
    if (args[i] === "--ca-cert" && i + 1 < args.length) {
      flagPath = args[i + 1];
    } else if (args[i].startsWith("--ca-cert=")) {
      flagPath = args[i].slice("--ca-cert=".length);
    }
    if (flagPath) return flagPath;
  }
  return envPath || undefined;
}

export function getEnvCaCerts(): string[] | undefined {
  if (resolvedEnvCaCerts !== undefined) {
    return resolvedEnvCaCerts.length > 0 ? resolvedEnvCaCerts : undefined;
  }
  const certPath = resolveCaCertPath(
    Deno.args,
    Deno.env.get("SWAMP_CA_CERT"),
  );
  if (!certPath) {
    resolvedEnvCaCerts = [];
    return undefined;
  }
  try {
    resolvedEnvCaCerts = [Deno.readTextFileSync(certPath)];
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : String(e);
    throw markErrorPaths(
      new UserError(
        `Could not read CA certificate file '${certPath}': ${detail}`,
      ),
      [certPath, ...errorPaths(e)],
    );
  }
  return resolvedEnvCaCerts;
}

/**
 * forgets the certificates read, so a test that points SWAMP_CA_CERT at a fresh
 * CA reads it on every repeat
 */
export function resetEnvCaCertsForTesting(): void {
  resolvedEnvCaCerts = undefined;
}

let cachedCaCertClient: Deno.HttpClient | undefined;

function createSocket(
  url: string,
  headers?: Record<string, string>,
  caCerts?: string[],
): WebSocket {
  const effectiveCaCerts = caCerts ?? getEnvCaCerts();
  let client: Deno.HttpClient;
  if (effectiveCaCerts?.length) {
    if (!cachedCaCertClient) {
      cachedCaCertClient = createTlsHttpClient({
        caCerts: effectiveCaCerts,
      });
    }
    client = cachedCaCertClient;
  } else {
    client = getDefaultHttpClient();
  }
  const opts: Record<string, unknown> = { client };
  if (headers && Object.keys(headers).length > 0) {
    opts.headers = headers;
  }
  return new WebSocket(url, opts);
}

/**
 * close code serve uses when it revokes a session's credential (token revoked,
 * rotated or deleted, or principal deprovisioned)
 */
const SESSION_REVOKED_CLOSE_CODE = 4003;

function describeServerClose(event: CloseEvent): string {
  const parts: string[] = [];
  if (event.code !== 1000 && event.code !== 1005) {
    parts.push(`code ${event.code}`);
  }
  if (event.reason) {
    parts.push(event.reason);
  }
  return parts.length > 0 ? ` (${parts.join(": ")})` : "";
}

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
  | { kind: "disconnected"; closeDetail?: string }
  | { kind: "elsewhere"; instanceId: string }
  | { kind: "interrupted"; instanceId: string; reason: string };

/** the state object tracks the runId and last seen seq across reconnections */
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
  const baseUrl = toWebSocketUrl(options.server);
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
  let closeDetail = "";
  let closeCode: number | undefined;
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
  socket.onclose = (event) => {
    socketClosed = true;
    closeDetail = describeServerClose(event);
    closeCode = event.code;
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
        message += describeServerClose(closeEvent);
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
          await classifyConnectionError(
            baseUrl,
            err.message,
            headers,
            options.caCerts,
          ),
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
          throw new ServerResponseError(message.error);
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
          // a nested workflow's started event carries the child's run id; a
          // reconnect reattaches to the run this request started. an older
          // serve sends no parentRunId and keys the run on the child, which
          // this then follows
          if (
            typeof event === "object" && event !== null && "kind" in event &&
            "runId" in event && !("parentRunId" in event)
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
        // 4003: the server revoked this session's credential. Reconnecting
        // with the same credential cannot succeed, so report why instead.
        if (state.runId && closeCode === SESSION_REVOKED_CLOSE_CODE) {
          throw new UserError(
            `The server ended this session${closeDetail}. ` +
              "Check the run's final status with: swamp run history",
          );
        }
        if (state.runId) {
          return { kind: "disconnected" as const, closeDetail };
        }
        throw new UserError(
          `Connection to the server closed before the run completed${closeDetail}`,
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

async function* streamServerRun(
  options: ServerRunOptions,
  request: OutboundRequest,
): AsyncIterable<{ kind: string; [key: string]: unknown }> {
  writeRemoteIndicator(options.server);
  const state = { runId: undefined as string | undefined, lastSeq: 0 };
  let reconnectRetries = 0;
  let elsewhereRetries = 0;
  let currentRequest: OutboundRequest | {
    type: "run.attach";
    payload: { runId: string; afterSeq: number };
  } = request;
  const logger = getReconnectLogger();
  // why the server closed the last connection, so a reconnect that fails can
  // say why
  let lastCloseDetail = "";

  while (true) {
    let outcome: StreamOutcome;
    let receivedEvents = false;
    try {
      const stream = singleConnectionStream(options, currentRequest, state);
      try {
        while (true) {
          const result = await stream.next();
          if (result.done) {
            outcome = result.value;
            break;
          }
          receivedEvents = true;
          yield result.value;
        }
      } finally {
        // A consumer that stops early ends this generator at the yield above;
        // the connection is closed with it rather than left open.
        await stream.return({ kind: "done" });
      }
    } catch (err) {
      if (err instanceof UserError && lastCloseDetail && !receivedEvents) {
        // A reconnect after the server closed the session failed — most often
        // because the token expired. Say why the session ended, not just why
        // the reconnect was refused.
        throw new UserError(
          `The server ended this session${lastCloseDetail} and reconnecting ` +
            `failed: ${err.message}. ` +
            "Check the run's final status with: swamp run history",
        );
      }
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
      lastCloseDetail = "";
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

    if (outcome.closeDetail) lastCloseDetail = outcome.closeDetail;
    reconnectRetries++;
    if (reconnectRetries > MAX_RECONNECT_RETRIES) {
      throw new UserError(
        `Connection lost${lastCloseDetail} and could not reconnect after ` +
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
