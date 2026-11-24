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

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

function trimTrailingSlashes(path: string): string {
  return path.replace(/\/+$/, "");
}

function withoutSuffix(path: string, suffix: string): string | undefined {
  const trimmed = trimTrailingSlashes(path);
  const end = trimTrailingSlashes(suffix);
  if (end === "") return trimmed;
  return trimmed.endsWith(end) ? trimmed.slice(0, -end.length) : undefined;
}

function httpScheme(url: URL): URL {
  const copy = new URL(url.href);
  if (copy.protocol === "ws:") copy.protocol = "http:";
  else if (copy.protocol === "wss:") copy.protocol = "https:";
  return copy;
}

const POINT_DIRECTLY =
  "swamp does not follow redirects, so point --server at the address that serves swamp directly";

/**
 * the error for a refused redirect; an address to pass instead is offered only
 * when the redirect kept the path, since a path change is not a moved serve
 */
export function describeRefusedRedirect(
  requestUrl: string,
  endpointPath: string,
  status: number,
  location: string | null,
): string {
  const request = new URL(requestUrl);
  const basePath = withoutSuffix(request.pathname, endpointPath) ??
    trimTrailingSlashes(request.pathname);
  const baseUrl = new URL(request.href);
  baseUrl.pathname = basePath === "" ? "/" : basePath;
  const base = redactServerUrl(baseUrl.href) ?? "the server";
  let target: URL | undefined;
  try {
    target = location ? new URL(location, httpScheme(request)) : undefined;
  } catch {
    target = undefined;
  }
  const shownTarget = target ? redactServerUrl(target.href) : undefined;
  if (!target || shownTarget === undefined) {
    return `${base} answered with a redirect (HTTP ${status}) that names no usable target; ${POINT_DIRECTLY}`;
  }
  const targetBase = withoutSuffix(target.pathname, endpointPath);
  // never suggest an address --server refuses or one that drops TLS
  const targetHttp = httpScheme(target);
  const suggestable = targetHttp.protocol === "https:" ||
    (targetHttp.protocol === "http:" &&
      httpScheme(request).protocol === "http:");
  const movedOnly = suggestable && targetBase === basePath &&
    targetHttp.origin !== httpScheme(baseUrl).origin;
  if (!movedOnly) {
    return `${base} redirected to ${shownTarget} (HTTP ${status}); ${POINT_DIRECTLY}`;
  }
  return `${base} redirected to ${shownTarget} (HTTP ${status}); swamp does not follow redirects, so pass --server ${target.protocol}//${target.host}${basePath}`;
}

export type EnvServerTokenBinding =
  | { readonly kind: "bound" }
  | { readonly kind: "unnamed" }
  | {
    readonly kind: "paired";
    readonly invalidUrl: boolean;
    // whether unsetting SWAMP_SERVER_URL would let a named address bind it
    readonly unsetBinds: boolean;
  };

/**
 * SWAMP_SERVER_URL, when set, pairs SWAMP_SERVER_TOKEN with that server alone;
 * otherwise an address the user named outside the repository binds it
 */
export function envServerTokenBinding(
  key: string,
  serverUrl: string | undefined,
  named: readonly (string | undefined)[],
): EnvServerTokenBinding {
  const namedBinds = named.some((value) => value && namesServer(value, key));
  if (serverUrl) {
    if (namesServer(serverUrl, key)) return { kind: "bound" };
    return {
      kind: "paired",
      invalidUrl: !parses(serverUrl),
      unsetBinds: namedBinds,
    };
  }
  return { kind: namedBinds ? "bound" : "unnamed" };
}

function parses(value: string): boolean {
  try {
    normalizeServerUrl(value);
    return true;
  } catch {
    return false;
  }
}

function namesServer(value: string, key: string): boolean {
  try {
    return normalizeServerUrl(value) === key;
  } catch {
    return false;
  }
}
