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
 * a follower forwards writes with the caller's own credentials and never says
 * who the caller is; a forward that never reached the leader is refused, one
 * that failed after reaching it is inFlight and never retried
 */

import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { injectTraceContext } from "../infrastructure/tracing/propagation.ts";
import {
  ServeFollowerBehindError,
  type ServeLeader,
  ServeNotLeaderError,
} from "../domain/datastore_v3/serve_leader.ts";
import {
  answersWithoutConfirm,
  serveRequestDeadlineMs,
} from "../infrastructure/datastore_v3/serve_datastore_client.ts";
import { SERVE_REQUEST_SYNC_DEADLINE_MS } from "../infrastructure/datastore_v3/serve_request_deadlines.ts";
import { endOnAbort } from "./stream_abort.ts";
import { TEAM_PEER_HEADER } from "./peer_auth.ts";
import { MAX_LOCK_WAIT_MS } from "./datastore_locks.ts";

const logger = getSwampLogger(["serve", "leader-link"]);

/**
 * how long the leader may take to start its reply to a forward, past the wait
 * a lock request asks of it and the upload; under a member's own response
 * deadline, so the member reads this node's refusal rather than timing out
 */
export const FORWARD_RESPONSE_BASE_MS = 7_000;

/**
 * a forward that may wait for the leader to confirm a replicated write: past
 * that deadline and a margin, under the member's own for it
 */
export const FORWARD_COMMIT_RESPONSE_BASE_MS = SERVE_REQUEST_SYNC_DEADLINE_MS +
  3_000;

/**
 * timeouts in a row that mark a leader frozen, where a never-sent forward marks
 * it at once; one counts only if sent after the last went unanswered
 */
export const FROZEN_AFTER_TIMEOUTS = 2;

/** how long forwards to a frozen leader are refused before one probes it */
export const FROZEN_LEADER_PROBE_MS = 5_000;

const DATASTORE_PATH = /^\/api\/v1\/datastore\/[^/]+\/(.*)$/;

/** the most bytes of a lock request read to learn the wait it asks for */
const LOCK_BODY_PEEK_BYTES = 64 * 1024;

const HOP_HEADERS = [
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "content-length",
];

/**
 * errors meaning the request never left this node; anything else is taken as in
 * flight, since the leader may have started on it
 */
const NOT_SENT_PATTERN =
  /tcp connect error|error trying to connect|connection refused|dns error|failed to lookup address|no route to host|network is unreachable|invalid peer certificate|unknownissuer|certificate verify failed/i;

export function forwardNeverSent(error: unknown): boolean {
  for (
    let e: unknown = error, depth = 0;
    e !== undefined && e !== null && depth < 4;
    e = (e as { cause?: unknown }).cause, depth++
  ) {
    if (e instanceof Error && NOT_SENT_PATTERN.test(e.message)) return true;
  }
  return false;
}

export function notLeaderResponse(
  refusal: ServeNotLeaderError,
  nameLeader = true,
): Response {
  return Response.json(
    {
      code: refusal.code,
      message: nameLeader
        ? refusal.message
        : "This serve node does not lead the datastore; try again",
      ...(nameLeader && refusal.leader !== undefined
        ? { leader: refusal.leader }
        : {}),
      ...(refusal.inFlight ? { inFlight: true } : {}),
      ...(nameLeader && refusal.reads ? { reads: true } : {}),
    },
    { status: 503, headers: { "Retry-After": "5" } },
  );
}

/**
 * a retryable 503 that names nothing of the leader; the follower is catching
 * up, so retry after a second
 */
export function followerBehindResponse(): Response {
  const refusal = new ServeFollowerBehindError();
  return Response.json(
    { code: refusal.code, message: refusal.message },
    { status: 503, headers: { "Retry-After": "1" } },
  );
}

export interface LeaderLinkOptions {
  /**
   * Whether this node trusts the proxy in front of it (`--trust-proxy`):
   * only then does a caller's own `X-Forwarded-For` pass on.
   */
  readonly trustProxy?: boolean;
  leader(): ServeLeader | undefined;
  readonly caCerts?: readonly string[];
  readonly createClient?: (
    caCerts: readonly string[] | undefined,
  ) => Deno.HttpClient | undefined;
  readonly fetch?: typeof fetch;
  /**
   * sent with every forward so the leader keys it on the caller's address;
   * undefined while this node holds no usable key
   */
  readonly peerToken?: () => string | undefined;
  readonly responseBaseMs?: number;
  readonly commitResponseBaseMs?: number;
  readonly now?: () => number;
}

export interface ForwardOptions {
  readonly clientIp?: string;
  readonly body?: Uint8Array;
  /**
   * Whether this node's own refusal names the leader: false for a caller
   * not yet authenticated (a webhook sender), who learns nothing of it.
   */
  readonly nameLeader?: boolean;
}

export class LeaderLink {
  readonly #options: LeaderLinkOptions;
  readonly #clients = new Map<string, Deno.HttpClient | undefined>();
  readonly #closed = new AbortController();
  // each forward until its reply has been relayed, so a stopping follower
  // does not cut off one the leader already took
  readonly #inFlight = new Set<Promise<void>>();
  #superseded = new AbortController();
  #frozen: { key: string; probeAt: number; probing: boolean } | undefined;
  #unanswered: { key: string; count: number; seq: number } | undefined;
  // a clock tick can hold a timeout and the next send alike; a sequence cannot
  #timeoutSeq = 0;

  constructor(options: LeaderLinkOptions) {
    this.#options = options;
  }

  leader(): ServeLeader | undefined {
    return this.#options.leader();
  }

  address(): string | undefined {
    return this.#options.leader()?.address;
  }

  client(address: string): Deno.HttpClient | undefined {
    if (!this.#clients.has(address)) {
      // The leader moved: a client for the old address carries no new
      // request. Requests still in flight on it finish or fail there.
      for (const [old, client] of this.#clients) {
        if (old === address) continue;
        this.#clients.delete(old);
        try {
          client?.close();
        } catch {
          // Already closed.
        }
      }
      const make = this.#options.createClient ?? defaultClient;
      this.#clients.set(address, make(this.#options.caCerts));
    }
    return this.#clients.get(address);
  }

  /**
   * Passes `req` to the leader at the same path and query, with the
   * caller's headers. Resolves to the leader's reply, or to the refusal
   * when the leader is unknown or could not be reached; never retries.
   */
  async forward(req: Request, options: ForwardOptions = {}): Promise<Response> {
    const relayed = Promise.withResolvers<void>();
    this.#inFlight.add(relayed.promise);
    const settle = () => {
      this.#inFlight.delete(relayed.promise);
      relayed.resolve();
    };
    let streaming = false;
    try {
      const reply = await this.#forward(req, options, settle);
      streaming = reply.streaming;
      return reply.response;
    } finally {
      if (!streaming) settle();
    }
  }

  async #forward(
    req: Request,
    options: ForwardOptions,
    onRelayed: () => void,
  ): Promise<{ response: Response; streaming: boolean }> {
    const leader = this.#options.leader();
    const address = leader?.address;
    const nameLeader = options.nameLeader ?? true;
    if (
      leader === undefined || address === undefined ||
      this.#closed.signal.aborted
    ) {
      return {
        response: notLeaderResponse(
          new ServeNotLeaderError(leader),
          nameLeader,
        ),
        streaming: false,
      };
    }
    const key = leaderKey(leader, address);
    const url = new URL(req.url);
    const target = leaderTarget(address, url.pathname, url.search);
    const headers = forwardedHeaders(
      req.headers,
      options.clientIp,
      this.#options.trustProxy ?? false,
    );
    const peer = this.#options.peerToken?.();
    if (peer !== undefined) headers.set(TEAM_PEER_HEADER, peer);
    // the leader's span joins this node's, not the caller's directly
    for (const [name, value] of Object.entries(injectTraceContext())) {
      headers.set(name, value);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    // other forwards (actions, signals, webhooks) keep their callers' deadlines
    const { responseMs, lockWaitMs } = await this.#responseDeadline(
      req,
      url,
      options.body,
    );
    const client = this.client(address);
    const admitted = this.#admit(key, responseMs, lockWaitMs);
    if (admitted === "refuse") {
      return {
        response: notLeaderResponse(
          new ServeNotLeaderError(leader),
          nameLeader,
        ),
        streaming: false,
      };
    }
    const sentAtSeq = this.#timeoutSeq;
    const superseded = this.#superseded.signal;
    const unanswered = new AbortController();
    const responseTimer = responseMs === undefined
      ? undefined
      : setTimeout(() =>
        unanswered.abort(
          new DOMException(
            `The leader did not start its reply within ${responseMs} ms`,
            "TimeoutError",
          ),
        ), responseMs);
    const signal = AbortSignal.any([
      this.#closed.signal,
      req.signal,
      unanswered.signal,
      superseded,
    ]);
    let upstream: Response;
    try {
      const doFetch = this.#options.fetch ?? fetch;
      upstream = await doFetch(target, {
        method: req.method,
        headers,
        body: hasBody ? (options.body ?? req.body) : undefined,
        redirect: "manual",
        signal,
        ...(client !== undefined ? { client } : {}),
      } as RequestInit);
    } catch (error) {
      const inFlight = !forwardNeverSent(error);
      const timedOut = unanswered.signal.aborted && !req.signal.aborted;
      if (timedOut) {
        // its connections may reach a leader that no longer answers
        this.#dropClient(address);
      }
      this.#failed(key, admitted === "probe", sentAtSeq, {
        neverSent: !inFlight,
        timedOut,
        abandoned: req.signal.aborted || this.#closed.signal.aborted ||
          superseded.aborted,
      });
      logger
        .info`Forwarding ${req.method} ${url.pathname} to the leader at ${address} failed${
        inFlight ? " after it was sent" : ""
      }: ${error}`;
      return {
        response: notLeaderResponse(
          new ServeNotLeaderError(leader, false, inFlight),
          nameLeader,
        ),
        streaming: false,
      };
    } finally {
      clearTimeout(responseTimer);
    }
    this.#answered(key);
    if (!upstream.body) {
      return {
        response: new Response(null, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: upstream.headers,
        }),
        streaming: false,
      };
    }
    return {
      response: new Response(
        endOnAbort(upstream.body, this.#closed.signal, onRelayed),
        {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: upstream.headers,
        },
      ),
      streaming: true,
    };
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  /**
   * Ends every forward still waiting on a leader's reply as in flight, as when
   * this node takes the lead: the old leader's fence keeps it from landing them.
   */
  abortForwards(): void {
    const superseded = this.#superseded;
    this.#superseded = new AbortController();
    superseded.abort(
      new DOMException("This node took the lead", "AbortError"),
    );
  }

  /** a mark or count kept for another leader ends when the leader changes */
  #admit(
    key: string,
    responseMs: number | undefined,
    lockWaitMs: number,
  ): "send" | "probe" | "refuse" {
    if (this.#unanswered !== undefined && this.#unanswered.key !== key) {
      this.#unanswered = undefined;
    }
    const frozen = this.#frozen;
    if (frozen === undefined) return "send";
    if (frozen.key !== key) {
      this.#frozen = undefined;
      return "send";
    }
    // a lock wait would hold its caller past a takeover; the caller retries
    if (lockWaitMs > 0) return "refuse";
    if (frozen.probing || this.#now() < frozen.probeAt) return "refuse";
    // one with no deadline of its own goes out without the probe slot; its
    // answer still clears the mark
    if (responseMs === undefined) return "send";
    frozen.probing = true;
    return "probe";
  }

  #answered(key: string): void {
    if (this.#unanswered?.key === key) this.#unanswered = undefined;
    if (this.#frozen?.key === key) {
      this.#frozen = undefined;
      logger
        .info`The leader answered a forward again; forwarding to it resumes`;
    }
  }

  #failed(
    key: string,
    probe: boolean,
    sentAtSeq: number,
    how: { neverSent: boolean; timedOut: boolean; abandoned: boolean },
  ): void {
    const frozen = this.#frozen?.key === key ? this.#frozen : undefined;
    if (how.abandoned) {
      if (probe && frozen !== undefined) frozen.probing = false;
      return;
    }
    if (how.neverSent || probe) {
      this.#markFrozen(key);
      return;
    }
    if (!how.timedOut) return;
    const prior = this.#unanswered?.key === key ? this.#unanswered : undefined;
    if (prior !== undefined && sentAtSeq < prior.seq) return;
    const count = (prior?.count ?? 0) + 1;
    this.#unanswered = { key, count, seq: ++this.#timeoutSeq };
    if (count >= FROZEN_AFTER_TIMEOUTS) this.#markFrozen(key);
  }

  #markFrozen(key: string): void {
    if (this.#frozen?.key !== key) {
      logger
        .info`The leader stopped answering forwards; they are refused at once, and one is let through every ${FROZEN_LEADER_PROBE_MS} ms to see if it answers again`;
    }
    this.#frozen = {
      key,
      probeAt: this.#now() + FROZEN_LEADER_PROBE_MS,
      probing: false,
    };
  }

  async #responseDeadline(
    req: Request,
    url: URL,
    body: Uint8Array | undefined,
  ): Promise<{ responseMs: number | undefined; lockWaitMs: number }> {
    const datastorePath = DATASTORE_PATH.exec(url.pathname)?.[1];
    if (datastorePath === undefined) {
      return { responseMs: undefined, lockWaitMs: 0 };
    }
    const base = answersWithoutConfirm(req.method, datastorePath)
      ? this.#options.responseBaseMs ?? FORWARD_RESPONSE_BASE_MS
      : this.#options.commitResponseBaseMs ?? FORWARD_COMMIT_RESPONSE_BASE_MS;
    const declared = req.headers.get("content-length");
    const length = body?.byteLength ?? Number(declared ?? 0);
    const bytes = Number.isSafeInteger(length) && length > 0 ? length : 0;
    let waitMs = 0;
    // a body of unknown length is never read here: its lock wait goes unknown
    if (
      req.method === "POST" && datastorePath === "locks" &&
      (body !== undefined || declared !== null) &&
      bytes <= LOCK_BODY_PEEK_BYTES
    ) {
      try {
        const fields = body !== undefined
          ? JSON.parse(new TextDecoder().decode(body))
          : await req.clone().json();
        const asked = (fields as { waitMs?: unknown })?.waitMs;
        if (typeof asked === "number" && Number.isFinite(asked) && asked > 0) {
          waitMs = Math.min(asked, MAX_LOCK_WAIT_MS);
        }
      } catch {
        // the leader refuses a body it cannot read
      }
    }
    return {
      responseMs: serveRequestDeadlineMs(base, bytes) + waitMs,
      lockWaitMs: waitMs,
    };
  }

  #dropClient(address: string): void {
    const client = this.#clients.get(address);
    if (!this.#clients.delete(address)) return;
    try {
      client?.close();
    } catch {
      // Already closed.
    }
  }

  openSocket(
    pathAndQuery: string,
    headers: Readonly<Record<string, string>>,
  ): { socket: WebSocket; leader: ServeLeader } | undefined {
    const leader = this.#options.leader();
    const address = leader?.address;
    if (
      leader === undefined || address === undefined ||
      this.#closed.signal.aborted
    ) {
      return undefined;
    }
    const parsed = new URL(pathAndQuery, "http://path.invalid");
    const url = leaderTarget(address, parsed.pathname, parsed.search);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const client = this.client(address);
    const peer = this.#options.peerToken?.();
    const socket = new WebSocket(url, {
      headers: peer === undefined
        ? headers
        : { ...headers, [TEAM_PEER_HEADER]: peer },
      ...(client !== undefined ? { client } : {}),
    } as unknown as string[]);
    return { socket, leader };
  }

  /** forwards that start while it waits are waited for too */
  async drain(waitMs: number): Promise<void> {
    const deadline = this.#now() + waitMs;
    while (this.#inFlight.size > 0 && !this.#closed.signal.aborted) {
      const left = deadline - this.#now();
      if (left <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...this.#inFlight]),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, left);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    this.close();
  }

  close(): void {
    this.#closed.abort();
    for (const client of this.#clients.values()) {
      try {
        client?.close();
      } catch {
        // Already closed.
      }
    }
    this.#clients.clear();
  }
}

function leaderKey(leader: ServeLeader, address: string): string {
  return `${leader.instanceId}\n${leader.fence}\n${address}`;
}

/**
 * the origin is always the leader's, so a target like //internal-host/x never
 * sends the caller's credential anywhere but the leader
 */
export function leaderTarget(
  address: string,
  pathname: string,
  search: string,
): URL {
  const target = new URL(address);
  target.pathname = pathname;
  target.search = search;
  if (target.origin !== new URL(address).origin) {
    throw new Error("Internal error: a forward left the leader's origin");
  }
  return target;
}

// One client per leader address, so every forward to it shares one
// connection. The roots are the process-wide store plus `--ca-cert`'s.
function defaultClient(
  caCerts: readonly string[] | undefined,
): Deno.HttpClient | undefined {
  return Deno.createHttpClient(
    caCerts !== undefined && caCerts.length > 0
      ? { caCerts: [...caCerts] }
      : {},
  );
}

/**
 * X-Forwarded-For follows the caller's own only when trustProxy is set, so a
 * caller cannot name the address the leader limits and audits by; nothing says
 * who the caller is
 */
export function forwardedHeaders(
  incoming: Headers,
  clientIp: string | undefined,
  trustProxy = false,
): Headers {
  const headers = new Headers(incoming);
  for (const name of HOP_HEADERS) headers.delete(name);
  // Only this node says it is a team peer, never a caller.
  headers.delete(TEAM_PEER_HEADER);
  if (!trustProxy) headers.delete("x-forwarded-for");
  if (clientIp !== undefined && clientIp !== "") {
    const prior = headers.get("x-forwarded-for");
    headers.set(
      "x-forwarded-for",
      prior ? `${prior}, ${clientIp}` : clientIp,
    );
  }
  return headers;
}
