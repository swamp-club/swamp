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

export async function dashboardBundleExists(
  distDir: string = DASHBOARD_DIST_DIR,
): Promise<boolean> {
  try {
    return (await Deno.stat(join(distDir, "index.html"))).isFile;
  } catch {
    return false;
  }
}

export interface DashboardAsset {
  readonly file: string;
  readonly contentType: string;
  readonly cacheControl: string;
}

/** null for a file the bundle lacks; "forbidden" for a path outside it */
export async function locateDashboardFile(
  distDir: string,
  filePath: string,
): Promise<DashboardAsset | "forbidden" | null> {
  const root = resolve(distDir);
  const target = resolve(join(root, normalize(filePath)));
  if (
    isAbsolute(filePath) || filePath.includes("..") ||
    (!target.startsWith(root + "/") && target !== root &&
      !target.startsWith(root + "\\"))
  ) {
    return "forbidden";
  }
  try {
    if (!(await Deno.stat(target)).isFile) return null;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
  return {
    file: target,
    contentType: MIME_TYPES[extname(target)] ?? "application/octet-stream",
    cacheControl: basename(target) === "index.html"
      ? "no-cache"
      : "public, max-age=31536000, immutable",
  };
}

/**
 * The file a `/dashboard/<subPath>` request is answered with: the SPA falls
 * back to index.html for any path the bundle lacks.
 */
export async function locateDashboardRoute(
  distDir: string,
  subPath: string,
): Promise<DashboardAsset | "forbidden" | null> {
  const found = await locateDashboardFile(distDir, subPath || "index.html");
  if (found !== null) return found;
  return await locateDashboardFile(distDir, "index.html");
}

export async function serveDashboardFile(
  distDir: string,
  filePath: string,
): Promise<Response | null> {
  const asset = await locateDashboardFile(distDir, filePath);
  if (asset === "forbidden") return new Response("Forbidden", { status: 403 });
  if (asset === null) return null;
  try {
    return new Response(await Deno.readFile(asset.file), {
      headers: {
        "content-type": asset.contentType,
        "cache-control": asset.cacheControl,
      },
    });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

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

/** up to `length` bytes from `offset`, and the file's size */
export async function readDashboardChunk(
  file: string,
  offset: number,
  length: number,
): Promise<{ bytes: Uint8Array; size: number }> {
  using handle = await Deno.open(file, { read: true });
  const size = (await handle.stat()).size;
  await handle.seek(Math.min(offset, size), Deno.SeekMode.Start);
  const bytes = new Uint8Array(Math.max(0, Math.min(length, size - offset)));
  let read = 0;
  while (read < bytes.length) {
    const n = await handle.read(bytes.subarray(read));
    if (n === null) break;
    read += n;
  }
  return { bytes: bytes.subarray(0, read), size };
}
