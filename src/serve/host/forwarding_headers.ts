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

export type ListenerProtocol = "http" | "https";

export interface ForwardingOptions {
  /** the caller's address as the router's listener saw it */
  readonly peer: string;
  readonly protocol: ListenerProtocol;
  /** whether the router itself sits behind a proxy whose forwarding headers it believes */
  readonly trustProxy: boolean;
}

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

// Deno.serve already answered a caller's 100-continue, so the child is never
// asked for a second one; Forwarded is dropped because only the X-Forwarded-*
// headers below are vouched for
const REQUEST_ONLY = ["expect", "forwarded"];

const WEBSOCKET_HANDSHAKE = [
  "host",
  "content-length",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
];

export function forwardRequestHeaders(
  req: Request,
  options: ForwardingOptions,
): Headers {
  const headers = new Headers(req.headers);
  const prior = {
    for: options.trustProxy ? req.headers.get("x-forwarded-for") : null,
    host: options.trustProxy
      ? firstEntry(req.headers.get("x-forwarded-host"))
      : null,
    proto: options.trustProxy
      ? firstEntry(req.headers.get("x-forwarded-proto"))?.toLowerCase()
      : undefined,
  };
  // a chunked body's length is not the declared one; node frames it afresh
  if (req.headers.has("transfer-encoding")) headers.delete("content-length");
  dropHopByHop(headers);
  for (const name of REQUEST_ONLY) headers.delete(name);
  // HTTP/2 carries the authority in :authority, which Deno exposes through
  // Request.url instead of a Host header
  const host = req.headers.get("host") ?? new URL(req.url).host;
  headers.set("host", host);
  headers.set(
    "x-forwarded-for",
    prior.for ? `${prior.for}, ${options.peer}` : options.peer,
  );
  headers.set("x-forwarded-host", prior.host ?? host);
  headers.set(
    "x-forwarded-proto",
    prior.proto === "http" || prior.proto === "https"
      ? prior.proto
      : options.protocol,
  );
  return headers;
}

/** the request headers for the router's own handshake with the child */
export function forwardWebSocketHeaders(
  req: Request,
  options: ForwardingOptions,
): Headers {
  const headers = forwardRequestHeaders(req, options);
  for (const name of WEBSOCKET_HANDSHAKE) headers.delete(name);
  return headers;
}

/** the subprotocols a WebSocket caller offered, in its order of preference */
export function offeredSubprotocols(req: Request): string[] {
  return (req.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol.length > 0);
}

/**
 * takes node's raw name/value list so a repeated header such as Set-Cookie
 * reaches the caller once per value
 */
export function forwardResponseHeaders(rawHeaders: readonly string[]): Headers {
  const headers = new Headers();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    headers.append(rawHeaders[i], rawHeaders[i + 1]);
  }
  dropHopByHop(headers);
  return headers;
}

function dropHopByHop(headers: Headers): void {
  const named = (headers.get("connection") ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  for (const name of [...HOP_BY_HOP, ...named]) headers.delete(name);
}

function firstEntry(value: string | null): string | null {
  const first = value?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : null;
}
