/**
 * CORS middleware for handling cross-origin requests.
 */

import type { Middleware } from "../server.ts";

export interface CorsConfig {
  origins?: string[];
  methods?: string[];
  headers?: string[];
  exposeHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

const DEFAULT_CONFIG: CorsConfig = {
  origins: ["*"],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  headers: ["Content-Type", "Authorization"],
  exposeHeaders: [],
  credentials: false,
  maxAge: 86400,
};

export function cors(config: CorsConfig = {}): Middleware {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  return async (request: Request, next: () => Promise<Response>) => {
    const origin = request.headers.get("Origin") ?? "";

    const isAllowed = mergedConfig.origins?.includes("*") ||
      mergedConfig.origins?.includes(origin);

    if (request.method === "OPTIONS") {
      if (!isAllowed) {
        return new Response(null, { status: 403 });
      }

      const headers: Record<string, string> = {
        "Access-Control-Allow-Methods": mergedConfig.methods?.join(", ") ?? "",
        "Access-Control-Allow-Headers": mergedConfig.headers?.join(", ") ?? "",
        "Access-Control-Max-Age": String(mergedConfig.maxAge ?? 86400),
      };

      if (mergedConfig.origins?.includes("*")) {
        headers["Access-Control-Allow-Origin"] = "*";
      } else if (isAllowed) {
        headers["Access-Control-Allow-Origin"] = origin;
        headers["Vary"] = "Origin";
      }

      if (mergedConfig.credentials) {
        headers["Access-Control-Allow-Credentials"] = "true";
      }

      return new Response(null, { status: 204, headers });
    }

    const response = await next();
    const newHeaders = new Headers(response.headers);

    if (mergedConfig.origins?.includes("*")) {
      newHeaders.set("Access-Control-Allow-Origin", "*");
    } else if (isAllowed) {
      newHeaders.set("Access-Control-Allow-Origin", origin);
      newHeaders.set("Vary", "Origin");
    }

    if (mergedConfig.credentials) {
      newHeaders.set("Access-Control-Allow-Credentials", "true");
    }

    if (mergedConfig.exposeHeaders?.length) {
      newHeaders.set(
        "Access-Control-Expose-Headers",
        mergedConfig.exposeHeaders.join(", "),
      );
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  };
}
