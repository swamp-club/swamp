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
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { SwampClubClient } from "../../infrastructure/http/swamp_club_client.ts";
import { UserError } from "../../domain/errors.ts";
import { renderApiKeyDelete } from "../../presentation/output/auth_apikey_output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { yellow } from "@std/fmt/colors";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const authApikeyDeleteCommand = new Command()
  .name("delete")
  .description("Permanently delete an API key")
  .arguments("<key-id:string>")
  .action(async function (options: AnyOptions, keyId: string) {
    const ctx = createContext(options as GlobalOptions, [
      "auth",
      "apikey",
      "delete",
    ]);
    ctx.logger.debug("Executing auth apikey delete command");

    const repo = new AuthRepository();
    const credentials = await repo.load();

    if (!credentials) {
      throw new UserError(
        "Not authenticated. Run 'swamp auth login' to sign in.",
      );
    }

    if (keyId === credentials.apiKeyId && ctx.outputMode !== "json") {
      writeOutput(
        `${
          yellow("⚠")
        } Warning: You are deleting the API key used by this CLI session.`,
      );
    }

    const serverUrl = Deno.env.get("SWAMP_CLUB_URL") ?? credentials.serverUrl;
    const client = new SwampClubClient(serverUrl);
    await client.deleteApiKey(credentials.apiKey, keyId);

    renderApiKeyDelete(keyId, ctx.outputMode);

    ctx.logger.debug("Auth apikey delete command completed");
  });
