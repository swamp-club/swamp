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
import { requireInitializedRepoUnlocked } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { startClawServer } from "../../claw/server.ts";
import { createDiscordAdapter } from "../../claw/adapters/discord.ts";
import { createAuthDeps } from "../../libswamp/mod.ts";
import type { PlatformAdapter } from "../../claw/platform_adapter.ts";

export const clawServeCommand = new Command()
  .name("serve")
  .description("Start the Claw webhook server for chat platform integration")
  .option("--port <port:number>", "Port to listen on", { default: 8787 })
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option(
    "--discord-public-key <key:string>",
    "Discord application public key",
  )
  .option("--discord-bot-token <token:string>", "Discord bot token")
  .option("--discord-app-id <id:string>", "Discord application ID")
  .action(async function (options) {
    const repoDir = (options.repoDir as string) ?? ".";

    // Initialize repo context once at startup
    const { repoContext } = await requireInitializedRepoUnlocked({
      repoDir,
      outputMode: "log",
    });

    // Build platform adapters from provided config
    const adapters: PlatformAdapter[] = [];

    const discordPublicKey = options.discordPublicKey as string | undefined ??
      Deno.env.get("DISCORD_PUBLIC_KEY");
    const discordBotToken = options.discordBotToken as string | undefined ??
      Deno.env.get("DISCORD_BOT_TOKEN");
    const discordAppId = options.discordAppId as string | undefined ??
      Deno.env.get("DISCORD_APP_ID");

    if (discordPublicKey && discordBotToken && discordAppId) {
      adapters.push(
        createDiscordAdapter({
          publicKey: discordPublicKey,
          botToken: discordBotToken,
          applicationId: discordAppId,
        }),
      );
    }

    if (adapters.length === 0) {
      throw new UserError(
        "No platform adapters configured. Provide Discord credentials via flags or environment variables:\n" +
          "  --discord-public-key / DISCORD_PUBLIC_KEY\n" +
          "  --discord-bot-token  / DISCORD_BOT_TOKEN\n" +
          "  --discord-app-id     / DISCORD_APP_ID",
      );
    }

    const authDeps = createAuthDeps();

    startClawServer({
      port: options.port as number,
      adapters,
      routerDeps: {
        repoDir,
        repoContext,
        authDeps,
      },
    });

    // Keep the process alive
    await new Promise(() => {});
  });
