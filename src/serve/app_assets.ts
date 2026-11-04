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

import {
  dirname,
  extname,
  join,
  normalize,
  resolve,
  SEPARATOR,
} from "@std/path";
import { appResponseHeaders } from "@swamp-club/app-sdk/headers";
import {
  type AppApprovalRepository,
  appState,
} from "../domain/apps/app_approval.ts";
import type {
  AppCatalog,
  AppCatalogListing,
} from "../domain/apps/app_catalog.ts";
import { capabilityKey } from "../domain/apps/app_descriptor.ts";
import { realAppBuildDir } from "../domain/apps/app_build_dir.ts";
import {
  APP_FILES_PATH,
  APP_LAUNCH_TOKEN_PATTERN,
  type AppLaunchKey,
  launchMatchesApproval,
  verifyAppLaunchToken,
} from "../domain/apps/app_launch.ts";

export const APP_BASE_HEADER = "x-swamp-app-base";

const APP_PATH = new RegExp(`^${APP_FILES_PATH}/([^/]+)/(.*)$`);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

export interface AppRouteDeps {
  readonly launchKey: AppLaunchKey;
  readonly catalog: AppCatalog;
  readonly approvals: AppApprovalRepository;
  /** Only the hub's child answers: the hub forwards the browser-facing base, not the child's loopback one. */
  readonly trustBaseHeader?: boolean;
  /** Behind `--trust-proxy` the browser's host is in `X-Forwarded-Host`. */
  readonly trustProxy?: boolean;
  readonly now?: () => Date;
}

const CATALOG_CACHE_MS = 5_000;

// the host lands in the CSP, so nothing that could end or add a source passes
const HOST_PATTERN =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/;
// a source no browser reaches, so a bad host stops the app instead of widening it
const UNUSABLE_HOST = "host.invalid";

/** a listing walks every pulled extension, too much for each file of a page */
export function cachedAppCatalog(catalog: AppCatalog): AppCatalog {
  let cached: { at: number; listing: Promise<AppCatalogListing> } | null = null;
  return {
    list() {
      const now = Date.now();
      if (cached === null || now - cached.at >= CATALOG_CACHE_MS) {
        const listing = catalog.list();
        const entry = { at: now, listing };
        cached = entry;
        listing.catch(() => {
          if (cached === entry) cached = null;
        });
      }
      return cached.listing;
    },
  };
}

export function isAppPath(pathname: string): boolean {
  return APP_PATH.test(pathname);
}

function refusal(status: number, message: string, appBase: string): Response {
  return new Response(message, {
    status,
    headers: appResponseHeaders({
      appBase,
      contentType: "text/plain; charset=utf-8",
    }),
  });
}

/**
 * The launch token in the path is the only thing checked. A frame's document
 * request arrives with the session cookie, because its navigation starts on
 * the dashboard, so nothing here may read the request's credentials.
 */
export async function serveAppRoute(
  req: Request,
  deps: AppRouteDeps,
): Promise<Response | null> {
  const url = new URL(req.url);
  const match = APP_PATH.exec(url.pathname);
  if (match === null) return null;
  const [, launchToken, encodedPath] = match;
  const forwarded = deps.trustProxy
    ? req.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
    : undefined;
  const host = [forwarded, req.headers.get("host"), url.host].find((
    candidate,
  ) => candidate && HOST_PATTERN.test(candidate)) ?? UNUSABLE_HOST;
  // checked before the token reaches a header or any work
  if (!APP_LAUNCH_TOKEN_PATTERN.test(launchToken)) {
    return refusal(404, "Not found", `${host}${APP_FILES_PATH}/`);
  }
  const appBase =
    (deps.trustBaseHeader ? req.headers.get(APP_BASE_HEADER) : null) ??
      `${host}${APP_FILES_PATH}/${launchToken}/`;

  if (req.method !== "GET" && req.method !== "HEAD") {
    return refusal(405, "Method not allowed", appBase);
  }
  try {
    return await answer(req, deps, launchToken, encodedPath, appBase);
  } catch {
    return refusal(500, "Could not read the app", appBase);
  }
}

async function answer(
  req: Request,
  deps: AppRouteDeps,
  launchToken: string,
  encodedPath: string,
  appBase: string,
): Promise<Response> {
  const key = await deps.launchKey.verifying();
  const now = (deps.now?.() ?? new Date()).getTime();
  const launch = key === undefined
    ? null
    : await verifyAppLaunchToken(key, launchToken, now);
  if (launch === null) return refusal(404, "Not found", appBase);
  const { apps } = await deps.catalog.list();
  const app = apps.find((entry) => entry.descriptor.name === launch.name);
  if (app === undefined) return refusal(404, "Not found", appBase);
  // read on every file, so a revoke stops a frame's next load on any instance
  const approval = await deps.approvals.get(launch.name);
  if (
    approval === null ||
    appState(capabilityKey(app.descriptor, app.origin), approval) !==
      "enabled" ||
    !await launchMatchesApproval(launch, approval)
  ) {
    return refusal(404, "Not found", appBase);
  }

  let path: string;
  try {
    path = decodeURIComponent(encodedPath);
  } catch {
    return refusal(400, "Bad path", appBase);
  }
  // the entry's folder, so a local app's sources and node_modules stay private
  const root = resolve(dirname(join(app.root, app.descriptor.entry)));
  const target = resolve(join(root, normalize(path)));
  if (!target.startsWith(root + SEPARATOR) || path.includes("\0")) {
    return refusal(403, "Forbidden", appBase);
  }
  const contentType = MIME_TYPES[extname(target).toLowerCase()];
  if (contentType === undefined) return refusal(404, "Not found", appBase);

  let real: string;
  let realRoot: string | null;
  try {
    [real, realRoot] = await Promise.all([
      Deno.realPath(target),
      realAppBuildDir(app.root, app.descriptor.entry),
    ]);
  } catch {
    return refusal(404, "Not found", appBase);
  }
  if (realRoot === null || !real.startsWith(realRoot + SEPARATOR)) {
    return refusal(403, "Forbidden", appBase);
  }
  try {
    const content = await Deno.readFile(real);
    return new Response(req.method === "HEAD" ? null : content, {
      headers: appResponseHeaders({ appBase, contentType }),
    });
  } catch {
    return refusal(404, "Not found", appBase);
  }
}
