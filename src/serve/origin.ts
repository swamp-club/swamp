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

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Parses a `--trusted-hosts` entry as `hostname` or `hostname:port`. Returns
 * null for an entry that is not exactly such an authority (a path, user info,
 * an unbracketed IPv6 literal, a non-ASCII name), which keeps its historic
 * literal comparison.
 */
function parseTrustedHost(
  entry: string,
): { hostname: string; port?: string } | null {
  let url: URL;
  try {
    url = new URL(`http://${entry}`);
  } catch {
    return null;
  }
  // URL drops http's default port, so read an explicit port from the entry.
  const port = /^(?:\[[^\]]*\]|[^:]*):(\d+)$/.exec(entry)?.[1];
  const hostname = url.hostname.toLowerCase();
  const authority = port === undefined ? hostname : `${hostname}:${port}`;
  if (authority !== entry.toLowerCase()) return null;
  return { hostname, port };
}

/**
 * Browser origins this server trusts. `anyPort` holds `protocol//hostname`
 * bases matched on every port: loopback, the TLS bind host and trusted host
 * entries without a port. `exact` holds the full origins of entries that name
 * a port, so `host:9443` trusts only that public origin.
 */
function trustedOrigins(
  bindHost: string,
  tlsEnabled: boolean,
  trustedHosts?: readonly string[],
): { anyPort: Set<string>; exact: Set<string> } {
  const anyPort = new Set([
    "http://127.0.0.1",
    "http://localhost",
    "https://127.0.0.1",
    "https://localhost",
    "http://[::1]",
    "https://[::1]",
  ]);
  const exact = new Set<string>();
  if (tlsEnabled) {
    anyPort.add(`https://${bindHost.toLowerCase()}`);
  }
  if (trustedHosts) {
    for (const host of trustedHosts) {
      const parsed = parseTrustedHost(host);
      if (parsed?.port !== undefined) {
        const authority = `${parsed.hostname}:${parsed.port}`;
        exact.add(new URL(`http://${authority}`).origin);
        exact.add(new URL(`https://${authority}`).origin);
        continue;
      }
      const normalizedHost = host.toLowerCase();
      anyPort.add(`http://${normalizedHost}`);
      anyPort.add(`https://${normalizedHost}`);
    }
  }
  return { anyPort, exact };
}

function validateOrigin(
  origin: string | null,
  bindHost: string,
  tlsEnabled: boolean,
  trustedHosts?: readonly string[],
): { allowed: boolean; reason?: string } {
  // Native HTTP clients do not generally attach Origin. It is only a browser
  // boundary, not authentication for local processes.
  if (origin === null) return { allowed: true };
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return { allowed: false, reason: `malformed origin: ${origin}` };
  }
  const originBase = `${originUrl.protocol}//${originUrl.hostname}`;
  const trusted = trustedOrigins(bindHost, tlsEnabled, trustedHosts);
  if (
    !trusted.anyPort.has(originBase) && !trusted.exact.has(originUrl.origin)
  ) {
    return { allowed: false, reason: `untrusted origin: ${origin}` };
  }
  return { allowed: true };
}

function validateHost(
  hostHeader: string | null,
  bindHost: string,
  trustedHosts?: readonly string[],
): { allowed: boolean; reason?: string } {
  if (hostHeader === null) {
    return { allowed: false, reason: "missing host" };
  }
  let hostName: string;
  try {
    const parsed = new URL(`http://${hostHeader}`);
    hostName = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return { allowed: false, reason: `malformed host: ${hostHeader}` };
  }
  const trusted = new Set([
    ...LOOPBACK_HOSTS,
    bindHost.toLowerCase(),
    // The Host check guards against DNS rebinding, which turns on the
    // hostname alone, so an entry's port does not narrow it.
    ...(trustedHosts?.map((host) =>
      parseTrustedHost(host)?.hostname.replace(/^\[|\]$/g, "") ??
        host.toLowerCase()
    ) ?? []),
  ]);
  if (!trusted.has(hostName)) {
    return { allowed: false, reason: `untrusted host: ${hostHeader}` };
  }
  return { allowed: true };
}

/**
 * Checks a WebSocket upgrade's Origin (always) and Host (when bound off
 * loopback) against the hosts this server trusts. Shared by `swamp serve`
 * and the `swamp start` server.
 */
export function validateWebSocketOrigin(
  origin: string | null,
  hostHeader: string | null,
  bindHost: string,
  tlsEnabled: boolean,
  trustedHosts?: readonly string[],
): { allowed: boolean; reason?: string } {
  const originCheck = validateOrigin(
    // Preserve the historic WebSocket treatment of an empty Origin as absent.
    // HTTP API requests deliberately reject it as malformed.
    origin === "" ? null : origin,
    bindHost,
    tlsEnabled,
    trustedHosts,
  );
  if (!originCheck.allowed) return originCheck;

  // Only validate Host header when binding off-loopback (direct exposure).
  // When bound to loopback, a reverse proxy on the same machine handles
  // external connections and forwards the public domain as the Host header —
  // this is the documented production deployment model (Caddy, nginx).
  if (hostHeader && !LOOPBACK_HOSTS.has(bindHost.toLowerCase())) {
    return validateHost(hostHeader, bindHost, trustedHosts);
  }

  return { allowed: true };
}

/**
 * Checks browser-facing HTTP API traffic to a loopback listener in deprecated
 * no-auth mode. Unlike WebSocket validation, Host is always checked so a DNS
 * rebinding authority cannot read the HTTP API. A configured reverse proxy is
 * admitted only through its explicit trusted host entry.
 */
export function validateNoAuthHttpRequest(
  origin: string | null,
  hostHeader: string | null,
  bindHost: string,
  tlsEnabled: boolean,
  trustedHosts?: readonly string[],
): { allowed: boolean; reason?: string } {
  const originCheck = validateOrigin(
    origin,
    bindHost,
    tlsEnabled,
    trustedHosts,
  );
  if (!originCheck.allowed) return originCheck;
  return validateHost(hostHeader, bindHost, trustedHosts);
}
