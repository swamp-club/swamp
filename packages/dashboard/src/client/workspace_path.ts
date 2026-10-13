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
 * The local dashboard (`swamp start` / `swamp dashboard`) serves every
 * workspace from one origin, each under `/dashboard/w/<workspace>/`, and
 * forwards that workspace's server calls under `/w/<workspace>/`. Under
 * `swamp serve` there is no workspace segment and every path is unchanged.
 */

const WORKSPACE_PATH = /^\/dashboard\/w\/([^/]+)(?=\/|$)/;

/** The workspace a dashboard path addresses, or null for serve's paths. */
export function workspaceFromPath(pathname: string): string | null {
  const match = WORKSPACE_PATH.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** The page's workspace, read once: switching workspace reloads the page. */
export const PAGE_WORKSPACE: string | null = workspaceFromPath(
  globalThis.location?.pathname ?? "",
);

/** The dashboard's base path for a workspace (or serve, for null). */
export function dashboardBaseFor(workspace: string | null): string {
  return workspace === null
    ? "/dashboard"
    : `/dashboard/w/${encodeURIComponent(workspace)}`;
}

/** A server path (`/auth/info`, `/api/v1/health`, `/`) for a workspace. */
export function serverPathFor(workspace: string | null, path: string): string {
  return workspace === null
    ? path
    : `/w/${encodeURIComponent(workspace)}${path}`;
}

/** {@link serverPathFor} for the page's own workspace. */
export function serverPath(path: string): string {
  return serverPathFor(PAGE_WORKSPACE, path);
}

/**
 * Where the local dashboard keeps its token for other tabs: per origin, so
 * per hub (each runs on its own port). The tab's own copy is the start
 * page's sessionStorage entry.
 */
export const LOCAL_TOKEN_KEY = "swamp-local-token";
/** The start page's sessionStorage key (`views/start/helpers.ts`). */
const START_TOKEN_KEY = "swamp-start-token";

/** The header the hub reads the local token from on HTTP requests. */
export const LOCAL_TOKEN_HEADER = "x-swamp-local-token";

function stored(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

/**
 * The local dashboard's token: what `swamp start` or `swamp dashboard`
 * handed the page in its URL. Null under serve, and on a workspace page
 * opened without it.
 */
export function localToken(): string | null {
  if (PAGE_WORKSPACE === null) return null;
  return stored(() => sessionStorage, START_TOKEN_KEY) ??
    stored(() => localStorage, LOCAL_TOKEN_KEY);
}

/** Keeps a token the page was handed, for this tab and later ones. */
export function keepLocalToken(token: string): void {
  for (
    const [storage, key] of [
      [() => sessionStorage, START_TOKEN_KEY],
      [() => localStorage, LOCAL_TOKEN_KEY],
    ] as const
  ) {
    try {
      storage().setItem(key, token);
    } catch {
      // Storage blocked: the token lasts for this page load only.
    }
  }
}

/** `headers` plus the local token, when the page has one. */
export function withLocalToken(
  headers: Record<string, string> = {},
): Record<string, string> {
  const token = localToken();
  return token === null ? headers : { ...headers, [LOCAL_TOKEN_HEADER]: token };
}

/**
 * The subprotocols a local dashboard socket offers (the hub echoes the
 * bearer one), or undefined under serve.
 */
export function localSocketProtocols(): string[] | undefined {
  const token = localToken();
  return token === null ? undefined : [`bearer.${token}`];
}
