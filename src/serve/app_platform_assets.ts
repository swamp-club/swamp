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
  extname,
  join,
  normalize,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import {
  APP_PLATFORM_PATH,
  type HeldPlatform,
} from "../domain/apps/app_platform.ts";
import { resourcePath } from "../infrastructure/runtime/resource_root.ts";

export function getAppPlatformDistDir(): string {
  return resourcePath("packages", "app-platform", "dist");
}

const ROUTE = new RegExp(`^${APP_PLATFORM_PATH}/([1-9][0-9]{0,2})/(.+)$`);

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".ts": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
};

// chunks/ and assets/ names carry a content hash; entries keep fixed names
// across minors and import those hashes, so a stale entry asks for a gone chunk
const HASHED = /^(chunks|assets)\//;
const HASHED_CACHE_CONTROL = "public, max-age=31536000, immutable";
const ENTRY_CACHE_CONTROL = "no-cache";

/** The platforms this swamp carries, from each build's `platform.json`. */
export async function readHeldPlatforms(
  distDir: string = getAppPlatformDistDir(),
): Promise<HeldPlatform[]> {
  const held: HeldPlatform[] = [];
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(distDir);
  } catch {
    return held;
  }
  try {
    for await (const entry of entries) {
      if (!entry.isDirectory || !/^[1-9][0-9]*$/.test(entry.name)) continue;
      try {
        const manifest = JSON.parse(
          await Deno.readTextFile(join(distDir, entry.name, "platform.json")),
        ) as { major?: unknown; minor?: unknown };
        if (
          typeof manifest.major === "number" &&
          typeof manifest.minor === "number" &&
          String(manifest.major) === entry.name
        ) {
          held.push({ major: manifest.major, minor: manifest.minor });
        }
      } catch {
        // A major without a readable manifest is not offered.
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return held.sort((a, b) => a.major - b.major);
}

export function isAppPlatformPath(pathname: string): boolean {
  return ROUTE.test(pathname);
}

/** Public and the same for every app, so no launch id; CORS because a frame's origin is opaque. */
export async function serveAppPlatformRoute(
  req: Request,
  distDir: string = getAppPlatformDistDir(),
  etags: Map<string, PlatformEtag> = defaultEtags,
): Promise<Response | null> {
  const url = new URL(req.url);
  const match = ROUTE.exec(url.pathname);
  if (match === null) return null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    return plain(405, "Method not allowed");
  }
  let path: string;
  try {
    path = decodeURIComponent(match[2]);
  } catch {
    return plain(404, "Not found");
  }
  const root = resolve(join(distDir, match[1]));
  const target = resolve(join(root, normalize(path)));
  if (path.includes("\0") || !target.startsWith(root + SEPARATOR)) {
    return plain(404, "Not found");
  }
  let body: Uint8Array<ArrayBuffer>;
  let stamp: string;
  try {
    // stamped before the read, so a file rewritten mid-read is hashed again
    const info = await Deno.stat(target);
    stamp = `${info.mtime?.getTime() ?? 0}:${info.size}`;
    body = await Deno.readFile(target);
  } catch {
    return plain(404, "Not found");
  }
  const cached = etags.get(target);
  let etag = cached?.stamp === stamp ? cached.etag : undefined;
  if (etag === undefined) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
    etag = `"${
      Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, "0"))
        .join("")
    }"`;
    etags.set(target, { stamp, etag });
  }
  const headers = {
    "content-type": CONTENT_TYPES[extname(target)] ??
      "application/octet-stream",
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
    "cache-control":
      HASHED.test(relative(root, target).split(SEPARATOR).join("/"))
        ? HASHED_CACHE_CONTROL
        : ENTRY_CACHE_CONTROL,
    etag,
  };
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(req.method === "HEAD" ? null : body, { headers });
}

/** A file's hash, kept while its mtime and size stay what was hashed. */
export interface PlatformEtag {
  readonly stamp: string;
  readonly etag: string;
}

const defaultEtags = new Map<string, PlatformEtag>();

function plain(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    },
  });
}
