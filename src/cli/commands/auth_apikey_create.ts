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
import { renderApiKeyCreate } from "../../presentation/output/auth_apikey_output.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const authApikeyCreateCommand = new Command()
  .name("create")
  .description("Create a new API key")
  .option("-n, --name <name:string>", "Name for the API key (max 32 chars)")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "auth",
      "apikey",
      "create",
    ]);
    ctx.logger.debug("Executing auth apikey create command");

    const repo = new AuthRepository();
    const credentials = await repo.load();

    if (!credentials) {
      throw new UserError(
        "Not authenticated. Run 'swamp auth login' to sign in.",
      );
    }

    const name: string = options.name ?? "swamp-cli";

    if (name.length > 32) {
      throw new UserError("API key name must be 32 characters or fewer.");
    }

    const serverUrl = Deno.env.get("SWAMP_CLUB_URL") ?? credentials.serverUrl;
    const client = new SwampClubClient(serverUrl);
    const result = await client.createApiKey(credentials.apiKey, name, "api-key");

    renderApiKeyCreate({ ...result, name }, ctx.outputMode);

    ctx.logger.debug("Auth apikey create command completed");
  });
