/**
 * HTTP server wrapper using Deno.serve() with graceful shutdown.
 */

import type { Logger } from "@logtape/logtape";
import { type RouteHandler, Router } from "./router.ts";

export interface ServerConfig {
  port: number;
  host: string;
  logger: Logger;
}

export type Middleware = (
  request: Request,
  next: () => Promise<Response>,
) => Promise<Response>;

export class HttpServer {
  private router: Router;
  private middlewares: Middleware[] = [];
  private abortController: AbortController | null = null;

  constructor(private config: ServerConfig) {
    this.router = new Router();
  }

  use(middleware: Middleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  getRouter(): Router {
    return this.router;
  }

  get(pattern: string, handler: RouteHandler): this {
    this.router.get(pattern, handler);
    return this;
  }

  post(pattern: string, handler: RouteHandler): this {
    this.router.post(pattern, handler);
    return this;
  }

  put(pattern: string, handler: RouteHandler): this {
    this.router.put(pattern, handler);
    return this;
  }

  patch(pattern: string, handler: RouteHandler): this {
    this.router.patch(pattern, handler);
    return this;
  }

  delete(pattern: string, handler: RouteHandler): this {
    this.router.delete(pattern, handler);
    return this;
  }

  options(pattern: string, handler: RouteHandler): this {
    this.router.options(pattern, handler);
    return this;
  }

  private async handleRequest(request: Request): Promise<Response> {
    let index = 0;

    const next = async (): Promise<Response> => {
      if (index < this.middlewares.length) {
        const middleware = this.middlewares[index++];
        return await middleware(request, next);
      }
      return await this.router.handle(request);
    };

    try {
      return await next();
    } catch (error) {
      this.config.logger.error`Request error: ${error}`;
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  async start(): Promise<void> {
    this.abortController = new AbortController();

    const server = Deno.serve(
      {
        port: this.config.port,
        hostname: this.config.host,
        signal: this.abortController.signal,
        onListen: ({ hostname, port }) => {
          this.config.logger
            .info`Server listening on http://${hostname}:${port}`;
        },
      },
      (request) => this.handleRequest(request),
    );

    const shutdown = async () => {
      this.config.logger.info`Shutting down server...`;
      this.stop();
      await server.finished;
    };

    Deno.addSignalListener("SIGINT", shutdown);
    Deno.addSignalListener("SIGTERM", shutdown);

    await server.finished;
  }

  stop(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}

export function createServer(config: ServerConfig): HttpServer {
  return new HttpServer(config);
}
