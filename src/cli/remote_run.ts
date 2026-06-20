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
  WorkflowRunPayload,
} from "../serve/protocol.ts";
import { deserializeEvent } from "../serve/serializer.ts";
import type { ServerCredentialRepository } from "../domain/auth/server_credential.ts";
import { FileServerCredentialRepository } from "../infrastructure/persistence/server_credential_repository.ts";

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

export interface ServerRunOptions {
  /** Server URL: ws://, wss://, http://, or https://. */
  server: string;
  /** Server token (`<name>.<secret>`) for authentication. */
  token?: string;
  signal?: AbortSignal;
  /** Test seam: WebSocket factory. */
  createSocket?: (url: string) => WebSocket;
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

/** Default timeout for request-response operations (30 seconds). */
const REQUEST_RESPONSE_TIMEOUT_MS = 30_000;

export interface RequestResponseOptions {
  server: string;
  token?: string;
  signal?: AbortSignal;
  createSocket?: (url: string) => WebSocket;
  timeoutMs?: number;
}

export function requestServerResponse<T>(
  options: RequestResponseOptions,
  request: { type: string; id?: string; payload?: unknown },
): Promise<T> {
  const baseUrl = normalizeServerUrl(options.server);
  const url = appendTokenToUrl(baseUrl, options.token);
  const requestId = request.id ?? crypto.randomUUID();
  const socket = (options.createSocket ?? ((u) => new WebSocket(u)))(url);
  const timeoutMs = options.timeoutMs ?? REQUEST_RESPONSE_TIMEOUT_MS;

  return new Promise<T>((resolve, reject) => {
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

    socket.onerror = () => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(
          new UserError(`Could not connect to ${baseUrl}`),
        );
      }
    };

    socket.onclose = () => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(
          new UserError(
            "Connection closed before a response was received",
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
        const message = JSON.parse(event.data) as ServerMessage;
        if (
          typeof message !== "object" || message === null ||
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
      "Run through a 'swamp serve' server (ws:// or http://) instead of locally; no local repo required (env: SWAMP_SERVE_URL).",
    )
    .option(
      "--token <token:string>",
      "Server token in <name>.<secret> format; only applies with --server (overrides stored credentials and SWAMP_SERVER_TOKEN)",
    ) as T;
}

interface OutboundRequest {
  type: "workflow.run" | "model.method.run";
  payload: WorkflowRunPayload | ModelMethodRunPayload;
}

/**
 * One request, one event stream. The generator completes on `done`, throws
 * UserError on an `error` frame, and treats a premature socket close as a
 * failure — a run whose end we never saw is not a success.
 */
async function* streamServerRun(
  options: ServerRunOptions,
  request: OutboundRequest,
): AsyncIterable<{ kind: string; [key: string]: unknown }> {
  const baseUrl = normalizeServerUrl(options.server);
  const url = appendTokenToUrl(baseUrl, options.token);
  const requestId = crypto.randomUUID();
  const socket = (options.createSocket ?? ((u) => new WebSocket(u)))(url);

  // Push-queue bridging socket callbacks to the generator.
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
  socket.onerror = () => {
    connectError = `Could not connect to ${baseUrl}`;
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
    const earlyFail = () => {
      clearTimeout(timer);
      reject(
        new UserError(
          connectError ?? `Connection to ${baseUrl} closed before it opened`,
        ),
      );
    };
    const prevClose = socket.onclose;
    socket.onclose = (event) => {
      prevClose?.call(socket, event);
      earlyFail();
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
    await opened;
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      throw new DOMException("Run was aborted", "AbortError");
    }
    socket.send(JSON.stringify({ ...request, id: requestId }));

    while (true) {
      const message = queue.shift();
      if (message !== undefined) {
        if (message.type === "done") {
          return;
        }
        if (message.type === "error") {
          if (cancelSent || message.error.code === "cancelled") {
            throw new DOMException("Run was cancelled", "AbortError");
          }
          throw new UserError(
            `Server reported ${message.error.code}: ${message.error.message}`,
          );
        }
        if (message.type === "event") {
          yield deserializeEvent(message.event);
        }
        continue;
      }
      if (socketClosed) {
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
      // Wait for the next frame, close, or cancel-drain tick.
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
