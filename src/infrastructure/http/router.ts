/**
 * HTTP router with path pattern matching and method-based dispatch.
 */

export type RouteParams = Record<string, string>;

export interface RouteContext {
  request: Request;
  params: RouteParams;
}

export type RouteHandler = (ctx: RouteContext) => Promise<Response> | Response;

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS";

interface Route {
  method: HttpMethod;
  pattern: string;
  segments: RouteSegment[];
  handler: RouteHandler;
}

type RouteSegment =
  | { type: "static"; value: string }
  | { type: "param"; name: string }
  | { type: "wildcard" };

function parsePattern(pattern: string): RouteSegment[] {
  const segments: RouteSegment[] = [];
  const parts = pattern.split("/").filter((p) => p !== "");

  for (const part of parts) {
    if (part === "*") {
      segments.push({ type: "wildcard" });
    } else if (part.startsWith(":")) {
      segments.push({ type: "param", name: part.slice(1) });
    } else {
      segments.push({ type: "static", value: part });
    }
  }

  return segments;
}

function matchPath(
  pathSegments: string[],
  routeSegments: RouteSegment[],
): RouteParams | null {
  const params: RouteParams = {};

  for (let i = 0; i < routeSegments.length; i++) {
    const routeSeg = routeSegments[i];

    if (routeSeg.type === "wildcard") {
      return params;
    }

    if (i >= pathSegments.length) {
      return null;
    }

    const pathSeg = pathSegments[i];

    if (routeSeg.type === "static") {
      if (routeSeg.value !== pathSeg) {
        return null;
      }
    } else if (routeSeg.type === "param") {
      params[routeSeg.name] = pathSeg;
    }
  }

  if (pathSegments.length !== routeSegments.length) {
    const lastRoute = routeSegments[routeSegments.length - 1];
    if (!lastRoute || lastRoute.type !== "wildcard") {
      return null;
    }
  }

  return params;
}

export class Router {
  private routes: Route[] = [];

  add(method: HttpMethod, pattern: string, handler: RouteHandler): this {
    this.routes.push({
      method,
      pattern,
      segments: parsePattern(pattern),
      handler,
    });
    return this;
  }

  get(pattern: string, handler: RouteHandler): this {
    return this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: RouteHandler): this {
    return this.add("POST", pattern, handler);
  }

  put(pattern: string, handler: RouteHandler): this {
    return this.add("PUT", pattern, handler);
  }

  patch(pattern: string, handler: RouteHandler): this {
    return this.add("PATCH", pattern, handler);
  }

  delete(pattern: string, handler: RouteHandler): this {
    return this.add("DELETE", pattern, handler);
  }

  options(pattern: string, handler: RouteHandler): this {
    return this.add("OPTIONS", pattern, handler);
  }

  match(
    request: Request,
  ): { handler: RouteHandler; params: RouteParams } | null {
    const url = new URL(request.url);
    const method = request.method as HttpMethod;
    const pathSegments = url.pathname.split("/").filter((p) => p !== "");

    for (const route of this.routes) {
      if (route.method !== method) {
        continue;
      }

      const params = matchPath(pathSegments, route.segments);
      if (params !== null) {
        return { handler: route.handler, params };
      }
    }

    return null;
  }

  async handle(request: Request): Promise<Response> {
    const match = this.match(request);

    if (!match) {
      return new Response("Not Found", { status: 404 });
    }

    return await match.handler({ request, params: match.params });
  }
}

export function jsonResponse(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

export function errorResponse(
  message: string,
  status = 500,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse({ error: message }, status, headers);
}
