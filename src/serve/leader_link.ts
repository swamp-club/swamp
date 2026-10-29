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
 * A follower's route to its team's leader (swamp-club#4120). A follower
 * passes every write on to the node that leads, as the caller sent it: the
 * caller's own credentials go through unchanged and the leader
 * authenticates and authorises the caller itself, so a follower never says
 * who the caller is. The follower keeps one HTTP client per leader address
 * (HTTP/2 carries every forwarded request over one connection), replaced
 * when the leader record names another node.
 *
 * A forward that could not reach the leader is refused as today
 * (`serve_not_leader`, nothing was changed). One that failed after the
 * request reached it is refused `inFlight`: the request may already have
 * run, so it is never retried here.
 *
 * @module
 */

import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  type ServeLeader,
  ServeNotLeaderError,
} from "../domain/datastore_v3/serve_leader.ts";
import { endOnAbort } from "./stream_abort.ts";

const logger = getSwampLogger(["serve", "leader-link"]);

/** Headers that belong to one hop and never pass on to the leader. */
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
 * Errors that mean the request never left this node: the leader could not
 * be resolved, connected to or completed a TLS handshake with. Anything
 * else is taken as in flight, since the leader may have started on it.
 */
const NOT_SENT_PATTERN =
  /tcp connect error|error trying to connect|connection refused|dns error|failed to lookup address|no route to host|network is unreachable|invalid peer certificate|unknownissuer|certificate verify failed/i;

/** Whether a failed forward never reached the leader. */
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

/** The refusal reply an HTTP route gives, as `followerHttpRefusal`'s. */
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

/** What a {@link LeaderLink} needs. */
export interface LeaderLinkOptions {
  /**
   * Whether this node trusts the proxy in front of it (`--trust-proxy`):
   * only then does a caller's own `X-Forwarded-For` pass on.
   */
  readonly trustProxy?: boolean;
  /** The leader as this node last read its record. */
  leader(): ServeLeader | undefined;
  /** PEM CA certificates to trust besides the system store. */
  readonly caCerts?: readonly string[];
  /** Makes the HTTP client for a leader address; replaced in tests. */
  readonly createClient?: (
    caCerts: readonly string[] | undefined,
  ) => Deno.HttpClient | undefined;
  /** Replaced in tests. */
  readonly fetch?: typeof fetch;
}

/** Options for one forwarded HTTP request. */
export interface ForwardOptions {
  /** The caller's address, appended to `X-Forwarded-For`. */
  readonly clientIp?: string;
  /** The body to send when the request's own was already read. */
  readonly body?: Uint8Array;
  /**
   * Whether this node's own refusal names the leader: false for a caller
   * not yet authenticated (a webhook sender), who learns nothing of it.
   */
  readonly nameLeader?: boolean;
}

/** A follower's route to the leader. */
export class LeaderLink {
  readonly #options: LeaderLinkOptions;
  readonly #clients = new Map<string, Deno.HttpClient | undefined>();
  readonly #closed = new AbortController();

  constructor(options: LeaderLinkOptions) {
    this.#options = options;
  }

  /** The leader as last read, which a refusal names. */
  leader(): ServeLeader | undefined {
    return this.#options.leader();
  }

  /** The leader's address, when the leader is known and published one. */
  address(): string | undefined {
    return this.#options.leader()?.address;
  }

  /** The HTTP client for the current leader address, made on first use. */
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
    const target = new URL(url.pathname + url.search, address);
    const headers = forwardedHeaders(
      req.headers,
      options.clientIp,
      this.#options.trustProxy ?? false,
    );
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

  /**
   * Opens a WebSocket to the leader at `pathAndQuery` with `headers` (the
   * caller's credential), or returns undefined when no leader address is
   * known.
   */
  openSocket(
    pathAndQuery: string,
    headers: HeadersInit,
  ): { socket: WebSocket; leader: ServeLeader } | undefined {
    const leader = this.#options.leader();
    const address = leader?.address;
    if (
      leader === undefined || address === undefined ||
      this.#closed.signal.aborted
    ) {
      return undefined;
    }
    const url = new URL(pathAndQuery, address);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const client = this.client(address);
    const socket = new WebSocket(url, {
      headers,
      ...(client !== undefined ? { client } : {}),
    } as unknown as string[]);
    return { socket, leader };
  }

  /** Ends every forwarded body and closes the clients, at shutdown. */
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
 * The caller's headers as the leader gets them: hop-by-hop headers dropped
 * and `X-Forwarded-For` set to the caller's address, after the caller's own
 * only when this node trusts the proxy in front of it (`trustProxy`), so a
 * caller cannot name the address the leader limits and audits it by.
 * Nothing is added that says who the caller is: the leader reads that from
 * the caller's own credential.
 */
export function forwardedHeaders(
  incoming: Headers,
  clientIp: string | undefined,
  trustProxy = false,
): Headers {
  const headers = new Headers(incoming);
  for (const name of HOP_HEADERS) headers.delete(name);
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
