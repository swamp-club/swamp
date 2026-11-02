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
import {
  ServeFollowerBehindError,
  type ServeLeader,
  ServeNotLeaderError,
} from "../domain/datastore_v3/serve_leader.ts";
import { endOnAbort } from "./stream_abort.ts";
import { TEAM_PEER_HEADER } from "./peer_auth.ts";

const logger = getSwampLogger(["serve", "leader-link"]);

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
    const leader = this.#options.leader();
    const address = leader?.address;
    const nameLeader = options.nameLeader ?? true;
    if (address === undefined || this.#closed.signal.aborted) {
      return notLeaderResponse(new ServeNotLeaderError(leader), nameLeader);
    }
    const url = new URL(req.url);
    const target = leaderTarget(address, url.pathname, url.search);
    const headers = forwardedHeaders(
      req.headers,
      options.clientIp,
      this.#options.trustProxy ?? false,
    );
    const peer = this.#options.peerToken?.();
    if (peer !== undefined) headers.set(TEAM_PEER_HEADER, peer);
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const signal = AbortSignal.any([this.#closed.signal, req.signal]);
    const client = this.client(address);
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
      logger
        .info`Forwarding ${req.method} ${url.pathname} to the leader at ${address} failed${
        inFlight ? " after it was sent" : ""
      }: ${error}`;
      return notLeaderResponse(
        new ServeNotLeaderError(leader, false, inFlight),
        nameLeader,
      );
    }
    if (!upstream.body) {
      return new Response(null, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      });
    }
    return new Response(endOnAbort(upstream.body, this.#closed.signal), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
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
