// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { Command } from "@cliffy/command";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepoUnlocked } from "../repo_context.ts";
import { handleConnection } from "../../serve/connection.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const logger = getSwampLogger(["serve"]);

export const serveCommand = new Command()
  .name("serve")
  .description("Start a WebSocket API server for workflow and model execution")
  .example("Start server", "swamp serve")
  .example("Custom port", "swamp serve --port 8080")
  .example(
    "Bind to all interfaces",
    "swamp serve --host 0.0.0.0 --port 3000",
  )
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--port <port:number>", "Port to listen on", { default: 9090 })
  .option("--host <host:string>", "Host to bind to", { default: "127.0.0.1" })
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["serve"]);
    const repoDir = options.repoDir as string ?? ".";
    const port = options.port as number;
    const host = options.host as string;
    const isJson = ctx.outputMode === "json";

    ctx.logger.info`Initializing repository at ${repoDir}`;

    const { repoDir: resolvedRepoDir, repoContext, datastoreConfig } =
      await requireInitializedRepoUnlocked({
        repoDir,
        outputMode: ctx.outputMode,
      });

    if (host !== "127.0.0.1" && host !== "localhost") {
      logger.warn(
        "Binding to non-loopback address {host} — no authentication is enforced on WebSocket connections",
        { host },
      );
    }
    const connectionCtx = {
      repoDir: resolvedRepoDir,
      repoContext,
      datastoreConfig,
    };

    const ac = new AbortController();

    const server = Deno.serve(
      {
        port,
        hostname: host,
        signal: ac.signal,
        onListen({ hostname, port: listenPort }) {
          if (isJson) {
            console.log(JSON.stringify({
              status: "listening",
              host: hostname,
              port: listenPort,
              url: `ws://${hostname}:${listenPort}`,
            }));
          } else {
            logger.info("WebSocket API server listening on {host}:{port}", {
              host: hostname,
              port: listenPort,
            });
          }
        },
      },
      (req) => {
        // WebSocket upgrade (check first — upgrade requests are also GETs)
        const upgrade = req.headers.get("upgrade") ?? "";
        if (upgrade.toLowerCase() === "websocket") {
          const { socket, response } = Deno.upgradeWebSocket(req);
          handleConnection(socket, connectionCtx);
          return response;
        }

        // Health check endpoint
        if (req.method === "GET") {
          const url = new URL(req.url);
          if (url.pathname === "/" || url.pathname === "/health") {
            return Response.json({ status: "ok", version: "1" });
          }
        }

        return new Response("Not found", { status: 404 });
      },
    );

    // Handle SIGINT/SIGTERM for graceful shutdown
    const shutdown = () => {
      if (isJson) {
        console.log(JSON.stringify({ status: "stopped" }));
      }
      logger.info("Shutting down...");
      ac.abort();
    };
    Deno.addSignalListener("SIGINT", shutdown);
    Deno.addSignalListener("SIGTERM", shutdown);

    await server.finished;

    repoContext.catalogStore?.close();
  });
