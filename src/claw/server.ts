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

import { getLogger } from "@logtape/logtape";
import type { PlatformAdapter } from "./platform_adapter.ts";
import type { CommandRouterDeps } from "./command_router.ts";
import { parseCommand } from "./command_parser.ts";
import { routeCommand } from "./command_router.ts";

const logger = getLogger(["swamp", "claw"]);

export interface ClawServerConfig {
  readonly port: number;
  readonly adapters: PlatformAdapter[];
  readonly routerDeps: CommandRouterDeps;
}

/**
 * Create and start the Claw webhook server.
 * Routes inbound webhooks to the appropriate platform adapter,
 * parses commands, executes them via the command router, and
 * sends responses back through the adapter.
 */
export function startClawServer(
  config: ClawServerConfig,
): Deno.HttpServer<Deno.NetAddr> {
  const adapterMap = new Map(
    config.adapters.map((a) => [`/webhook/${a.platformId}`, a]),
  );

  const server = Deno.serve({ port: config.port }, async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === "/health") {
      return Response.json({ status: "ok" });
    }

    // Route to platform adapter
    const adapter = adapterMap.get(path);
    if (!adapter) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    // Verify webhook signature
    const valid = await adapter.verifyRequest(request.clone());
    if (!valid) {
      logger.warn`Invalid webhook signature from ${adapter.platformId}`;
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Parse inbound message
    const message = await adapter.parseMessage(request);
    if (!message) {
      // Not actionable (e.g., a ping, or non-command message)
      return Response.json({ ok: true });
    }

    logger.info`[${adapter.platformId}] ${message.userName}: ${message.text}`;

    // Parse command from message text
    const command = parseCommand(message.text);
    if (!command) {
      await adapter.sendResponse(message.channelId, {
        text:
          "I didn't understand that command. Try: `/swamp workflow run <name>`, `/swamp model search`, `/swamp data list`, or `/status`",
        success: false,
      });
      return Response.json({ ok: true });
    }

    // Execute command in the background and respond
    // For platforms that need immediate acknowledgment (Discord),
    // the adapter handles the deferred response pattern internally.
    const response = await routeCommand(
      config.routerDeps,
      command,
      (progress) => {
        adapter.sendProgress(message.channelId, progress).catch((err) => {
          logger.warn`Failed to send progress: ${err}`;
        });
      },
    );

    await adapter.sendResponse(message.channelId, response);
    return Response.json({ ok: true });
  });

  logger.info`Claw server listening on port ${config.port}`;
  for (const adapter of config.adapters) {
    logger
      .info`  ${adapter.platformId}: /webhook/${adapter.platformId}`;
  }

  return server;
}
