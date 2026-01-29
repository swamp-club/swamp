/**
 * Static file handler for serving the Vue SPA.
 */

import { extname, join, resolve } from "@std/path";
import type { RouteContext } from "../router.ts";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".otf": "font/otf",
  ".map": "application/json",
};

export function createStaticHandler(baseDir: string) {
  async function serveStatic(ctx: RouteContext): Promise<Response> {
    const url = new URL(ctx.request.url);
    let filePath = url.pathname;

    filePath = decodeURIComponent(filePath.replace(/^\//, ""));

    if (filePath.startsWith("api/")) {
      return new Response("Not Found", { status: 404 });
    }

    const resolvedBase = resolve(baseDir);
    const fullPath = resolve(baseDir, filePath);

    // Prevent path traversal by ensuring resolved path is within base directory
    if (!fullPath.startsWith(resolvedBase + "/") && fullPath !== resolvedBase) {
      return new Response("Forbidden", { status: 403 });
    }

    try {
      const stat = await Deno.stat(fullPath);

      if (stat.isFile) {
        const content = await Deno.readFile(fullPath);
        const ext = extname(fullPath);
        const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

        return new Response(content, {
          headers: {
            "Content-Type": contentType,
            "Cache-Control": ext === ".html"
              ? "no-cache"
              : "public, max-age=31536000",
          },
        });
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    try {
      const indexPath = join(baseDir, "index.html");
      const content = await Deno.readFile(indexPath);

      return new Response(content, {
        headers: {
          "Content-Type": "text/html",
          "Cache-Control": "no-cache",
        },
      });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return new Response("Not Found - webapp not built", { status: 404 });
      }
      throw error;
    }
  }

  return { serveStatic };
}
