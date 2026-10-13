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
  if (origin) {
    const TRUSTED_ORIGINS = new Set([
      "http://127.0.0.1",
      "http://localhost",
      "https://127.0.0.1",
      "https://localhost",
      "http://[::1]",
      "https://[::1]",
    ]);
    if (tlsEnabled) {
      TRUSTED_ORIGINS.add(`https://${bindHost.toLowerCase()}`);
    }
    if (trustedHosts) {
      for (const h of trustedHosts) {
        const lh = h.toLowerCase();
        TRUSTED_ORIGINS.add(`http://${lh}`);
        TRUSTED_ORIGINS.add(`https://${lh}`);
      }
    }

    let originBase: string;
    try {
      const originUrl = new URL(origin);
      originBase = `${originUrl.protocol}//${originUrl.hostname}`;
    } catch {
      return { allowed: false, reason: `malformed origin: ${origin}` };
    }

    if (!TRUSTED_ORIGINS.has(originBase)) {
      return { allowed: false, reason: `untrusted origin: ${origin}` };
    }
  }

  // Only validate Host header when binding off-loopback (direct exposure).
  // When bound to loopback, a reverse proxy on the same machine handles
  // external connections and forwards the public domain as the Host header —
  // this is the documented production deployment model (Caddy, nginx).
  const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
  if (hostHeader && !LOOPBACK_HOSTS.has(bindHost.toLowerCase())) {
    let hostName: string;
    try {
      const parsed = new URL(`http://${hostHeader}`);
      hostName = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    } catch {
      return { allowed: false, reason: `malformed host: ${hostHeader}` };
    }
    const TRUSTED_HOSTS = new Set([
      "127.0.0.1",
      "localhost",
      "::1",
      bindHost.toLowerCase(),
    ]);
    if (trustedHosts) {
      for (const h of trustedHosts) {
        TRUSTED_HOSTS.add(h.toLowerCase());
      }
    }
    if (!TRUSTED_HOSTS.has(hostName)) {
      return { allowed: false, reason: `untrusted host: ${hostHeader}` };
    }
  }

  return { allowed: true };
}
