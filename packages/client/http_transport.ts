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

import { SwampHttpError } from "./http_errors.ts";

export interface HttpClientOptions {
  /** defaults to the global fetch */
  fetch?: typeof fetch;
  /** per attempt, in milliseconds */
  timeoutMs?: number;
  /** attempts per call, the first included; defaults to 8 */
  maxAttempts?: number;
  /** total time a call may spend waiting between attempts; defaults to 30 s */
  maxRetryWaitMs?: number;
  /** for tests: the source of jitter, in [0, 1) */
  random?: () => number;
}

/**
 * what serve answered; status 0 is no answer, with code connection_refused,
 * network_error or timeout
 */
export interface HttpReply {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly code: string | undefined;
  readonly retryAfterSeconds?: number;
  /** serve's clock at the reply, from its Date header */
  readonly serverDateMs?: number;
  /** this process's clock when the reply arrived */
  readonly receivedAtMs: number;
}

export interface PostOptions {
  readonly route: string;
  readonly actionType?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** whether to send the call again after this reply */
  readonly retry: (reply: HttpReply) => boolean;
}

const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 5_000;
const RETRY_AFTER_JITTER_CAP_MS = 1_000;

// Deno names the OS error only in the cause; other runtimes use ECONNREFUSED
const REFUSED_PATTERN =
  /connection refused|ECONNREFUSED|os error (?:61|111|10061)\b/i;

/** whether a fetch failed because nothing accepted the connection */
export function isConnectionRefused(error: unknown): boolean {
  for (let e = error, depth = 0; e != null && depth < 5; depth++) {
    const record = e as { message?: unknown; code?: unknown; cause?: unknown };
    if (record.code === "ECONNREFUSED") return true;
    if (
      typeof record.message === "string" && REFUSED_PATTERN.test(record.message)
    ) {
      return true;
    }
    e = record.cause;
  }
  return false;
}

/** Retry-After plus up to a quarter of it, at most a second, so clients spread out */
export function retryAfterDelayMs(
  retryAfterSeconds: number,
  random: () => number,
): number {
  const ms = retryAfterSeconds * 1000;
  return ms +
    Math.floor(random() * Math.min(RETRY_AFTER_JITTER_CAP_MS, ms / 4));
}

/** bearer credentials don't belong in a page, where any script could read them */
export function refuseInBrowser(
  what: string,
  scope: object = globalThis,
): void {
  if ("document" in scope) {
    throw new Error(
      `${what} holds bearer credentials and does not run in a browser`,
    );
  }
}

export function serveBaseUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The serve URL must use http: or https:");
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class HttpTransport {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #maxRetryWaitMs: number;
  readonly #random: () => number;

  constructor(
    baseUrl: string,
    defaultTimeoutMs: number,
    options: HttpClientOptions = {},
  ) {
    this.#baseUrl = serveBaseUrl(baseUrl);
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? 8);
    this.#maxRetryWaitMs = options.maxRetryWaitMs ?? 30_000;
    this.#random = options.random ?? Math.random;
  }

  /** POSTs JSON with a bearer, retrying only where the caller's policy allows */
  async post(
    path: string,
    bearer: string,
    body: unknown,
    options: PostOptions,
  ): Promise<HttpReply> {
    let waited = 0;
    for (let attempt = 1;; attempt++) {
      const reply = await this.#once(path, bearer, body, options);
      if (attempt >= this.#maxAttempts || !options.retry(reply)) return reply;
      const delay = reply.retryAfterSeconds !== undefined
        ? retryAfterDelayMs(reply.retryAfterSeconds, this.#random)
        : Math.floor(
          this.#random() *
            Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1)),
        );
      if (waited + delay > this.#maxRetryWaitMs) return reply;
      waited += delay;
      await wait(delay, options.signal);
    }
  }

  async #once(
    path: string,
    bearer: string,
    body: unknown,
    options: PostOptions,
  ): Promise<HttpReply> {
    if (options.signal?.aborted) throw abortReason(options.signal);
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.#timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${bearer}`,
          "content-type": "application/json",
          "accept": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      // the fetch error names the URL, so only its kind is kept
      if (options.signal?.aborted) throw abortReason(options.signal);
      return noAnswer(
        timeout.aborted
          ? "timeout"
          : isConnectionRefused(error)
          ? "connection_refused"
          : "network_error",
      );
    }
    const receivedAtMs = Date.now();
    const isJson = (response.headers.get("content-type") ?? "").includes(
      "application/json",
    );
    let parsed: unknown = undefined;
    try {
      parsed = isJson ? await response.json() : undefined;
      if (!isJson) await response.body?.cancel();
    } catch {
      if (options.signal?.aborted) throw abortReason(options.signal);
      return noAnswer(timeout.aborted ? "timeout" : "network_error");
    }
    const replyBody = parsed !== null && typeof parsed === "object" &&
        !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
    const retryAfter = Number(response.headers.get("retry-after"));
    const date = Date.parse(response.headers.get("date") ?? "");
    // an older serve has no such route and answers plain text
    const code = response.status === 404 && !isJson
      ? "route_unavailable"
      : typeof replyBody.code === "string"
      ? replyBody.code
      : undefined;
    return {
      status: response.status,
      body: replyBody,
      code,
      ...(Number.isFinite(retryAfter) && retryAfter >= 0 &&
          response.headers.has("retry-after")
        ? { retryAfterSeconds: retryAfter }
        : {}),
      ...(Number.isFinite(date) ? { serverDateMs: date } : {}),
      receivedAtMs,
    };
  }
}

function noAnswer(
  code: "timeout" | "network_error" | "connection_refused",
): HttpReply {
  return { status: 0, body: {}, code, receivedAtMs: Date.now() };
}

/** the typed error for a reply the caller has no outcome for */
export function errorFrom(
  reply: HttpReply,
  route: string,
  actionType?: string,
): SwampHttpError {
  const message = reply.status === 0
    ? reply.code === "timeout"
      ? "The request to serve timed out"
      : reply.code === "connection_refused"
      ? "Serve refused the connection; it may be restarting"
      : "Serve could not be reached"
    : reply.code === "route_unavailable"
    ? `This serve has no ${route} route; upgrade serve`
    : typeof reply.body.message === "string"
    ? reply.body.message
    : `Serve answered ${reply.status}`;
  return new SwampHttpError({
    status: reply.status,
    code: reply.code ?? "unexpected_reply",
    message,
    route,
    ...(actionType !== undefined ? { actionType } : {}),
    ...(typeof reply.body.requestId === "string"
      ? { requestId: reply.body.requestId }
      : {}),
    ...(reply.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: reply.retryAfterSeconds }
      : {}),
    ...(typeof reply.body.reason === "string"
      ? { reason: reply.body.reason }
      : {}),
  });
}

/**
 * a refusal given before anything is done, so sending again is safe: a
 * refused connection, rate limits, a starting serve, and 503s or busy replies
 * that name a time to retry
 */
export function refusedBeforeActing(reply: HttpReply): boolean {
  if (reply.code === "connection_refused") return true;
  if (reply.status === 429) return true;
  if (reply.status === 503 && reply.code === "not_ready") return true;
  if (reply.status === 409 && reply.code === "busy") return true;
  return reply.status === 503 && reply.retryAfterSeconds !== undefined &&
    reply.code !== "outcome_unknown" && reply.code !== "still_working";
}

/** no answer, or one that says the action may or may not have happened */
export function outcomeUnknown(reply: HttpReply): boolean {
  // a refused connection sent nothing
  if (reply.code === "connection_refused") return false;
  return reply.status === 0 || reply.code === "outcome_unknown" ||
    reply.code === "still_working";
}
