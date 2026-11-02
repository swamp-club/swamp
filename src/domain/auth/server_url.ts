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

export function normalizeServerUrl(url: string): string {
  const parsed = new URL(url);

  if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  } else if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  } else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(
      `Unsupported protocol: ${parsed.protocol} (expected http:, https:, ws: or wss:)`,
    );
  }

  // new URL already lowercases the hostname.
  // Strip default ports — URL parser stores them in .port as "" when they
  // match the scheme default, but explicit ":443" / ":80" may be present
  // in the original string and preserved by some environments.
  let host = parsed.hostname;
  if (parsed.port) {
    const isDefaultPort =
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80");
    if (!isDefaultPort) {
      host = `${host}:${parsed.port}`;
    }
  }

  const pathname = parsed.pathname.replace(/\/+$/, "") || "";

  return `${parsed.protocol}//${host}${pathname}`;
}

/**
 * drops userinfo, query and fragment, which can carry credentials; display
 * only, lookups use the normalized form; returns undefined for an unparseable
 * value and callers must not fall back to the raw one
 */
export function redactServerUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!parsed.host) return undefined;
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}
