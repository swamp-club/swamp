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
  basename,
  extname,
  isAbsolute,
  join,
  normalize,
  resolve,
} from "@std/path";

/**
 * The built dashboard bundle (`packages/dashboard/dist`), resolved from this
 * file. Compiled binaries embed it with `--include`.
 */
export const DASHBOARD_DIST_DIR = resolve(
  import.meta.dirname ?? ".",
  "..",
  "..",
  "packages",
  "dashboard",
  "dist",
);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

/** True when the bundle's `index.html` is present. */
export async function dashboardBundleExists(
  distDir: string = DASHBOARD_DIST_DIR,
): Promise<boolean> {
  try {
    return (await Deno.stat(join(distDir, "index.html"))).isFile;
  } catch {
    return false;
  }
}

/**
 * Serves one file from the bundle, or null when it does not exist. A path
 * that escapes the bundle gets a 403.
 */
export async function serveDashboardFile(
  distDir: string,
  filePath: string,
): Promise<Response | null> {
  const root = resolve(distDir);
  const target = resolve(join(root, normalize(filePath)));
  if (
    isAbsolute(filePath) || filePath.includes("..") ||
    (!target.startsWith(root + "/") && target !== root &&
      !target.startsWith(root + "\\"))
  ) {
    return new Response("Forbidden", { status: 403 });
  }
  try {
    const content = await Deno.readFile(target);
    const ext = extname(target);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    const isIndexHtml = basename(target) === "index.html";
    return new Response(content, {
      headers: {
        "content-type": contentType,
        "cache-control": isIndexHtml
          ? "no-cache"
          : "public, max-age=31536000, immutable",
      },
    });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

/**
 * Answers a request under `/dashboard` from the bundle: the file when it
 * exists, else `index.html` (the SPA routes client-side). Returns null for
 * a path outside `/dashboard`.
 */
export async function serveDashboardRoute(
  distDir: string,
  req: Request,
): Promise<Response | null> {
  const url = new URL(req.url);
  if (
    url.pathname !== "/dashboard" && !url.pathname.startsWith("/dashboard/")
  ) {
    return null;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }
  const subPath = url.pathname === "/dashboard"
    ? "index.html"
    : url.pathname.slice("/dashboard/".length) || "index.html";
  const fileResponse = await serveDashboardFile(distDir, subPath);
  if (fileResponse) return fileResponse;
  const indexResponse = await serveDashboardFile(distDir, "index.html");
  if (indexResponse) return indexResponse;
  return new Response(
    "Dashboard assets not available in this build",
    { status: 404, headers: { "content-type": "text/plain" } },
  );
}
