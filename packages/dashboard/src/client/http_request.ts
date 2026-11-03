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

import { RequestError, settleRequest, type WireFrame } from "./stream.ts";

/** a copy of `SERVE_REQUEST_PATH` in core's `src/serve/protocol.ts` */
export const SERVE_REQUEST_PATH = "/api/v1/request";

const USE_WEBSOCKET_CODE = "use_websocket";

/**
 * a copy of `HTTP_REQUEST_TYPES` in core's `src/serve/protocol.ts`: reads
 * whose replies can outgrow a WebSocket frame
 */
export const HTTP_REQUEST_TYPES: ReadonlySet<string> = new Set([
  "data.get",
  "data.query",
  "data.list",
  "data.versions",
  "model.output.data",
  "model.output.logs",
  "model.output.search",
  "model.method.history.get",
  "model.method.history.logs",
  "model.method.history.search",
  "workflow.history.get",
  "workflow.history.logs",
  "workflow.history.search",
  "report.get",
]);

export type HttpReadOutcome =
  | { kind: "payload"; value: unknown }
  | { kind: "route_missing" };

export interface HttpReadRequest {
  readonly type: string;
  readonly id: string;
  readonly payload?: Record<string, unknown>;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Sends one read over serve's HTTP route. `route_missing` means the socket
 * should answer it, as the CLI's `requestServerResponse` decides.
 */
export async function requestOverHttp(
  fetchFn: Fetch,
  url: string,
  headers: Record<string, string>,
  request: HttpReadRequest,
  signal?: AbortSignal,
): Promise<HttpReadOutcome> {
  const response = await fetchFn(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(request),
    credentials: "same-origin",
    redirect: "manual",
    signal,
  });
  if (!response.ok) {
    const refusal = await readServeRefusal(response);
    if (
      response.status === 404 || response.status === 405 ||
      refusal === undefined || refusal.code === USE_WEBSOCKET_CODE
    ) {
      return { kind: "route_missing" };
    }
    throw new RequestError(
      refusal.message,
      refusal.code,
      refusal.leader === undefined ? undefined : { leader: refusal.leader },
    );
  }
  const body = await response.text();
  for (const line of body.split("\n")) {
    if (line === "") continue;
    let frame: WireFrame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof frame !== "object" || frame === null) continue;
    if (frame.id !== request.id) continue;
    const outcome = settleRequest(frame);
    if (outcome.kind === "reject") {
      throw new RequestError(outcome.message, outcome.code, outcome.details);
    }
    if (outcome.kind === "resolve") {
      return { kind: "payload", value: outcome.value };
    }
  }
  throw new Error("Connection closed before a response was received");
}

interface ServeRefusal {
  readonly code: string;
  readonly message: string;
  readonly leader?: unknown;
}

async function readServeRefusal(
  response: Response,
): Promise<ServeRefusal | undefined> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null) return undefined;
  const { code, message, leader } = body as Record<string, unknown>;
  if (typeof code !== "string" || typeof message !== "string") {
    return undefined;
  }
  return { code, message, ...(leader !== undefined && { leader }) };
}

/**
 * HTTP reads settle as socket reads do: refused while the socket is down,
 * and rejected when it closes.
 */
export class HttpReads {
  readonly #controllers = new Set<AbortController>();

  async run<T>(
    connected: boolean,
    read: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (!connected) throw new Error("Not connected");
    const controller = new AbortController();
    this.#controllers.add(controller);
    try {
      return await read(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw new Error("WebSocket closed");
      throw error;
    } finally {
      this.#controllers.delete(controller);
    }
  }

  abortAll(): void {
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
  }
}
