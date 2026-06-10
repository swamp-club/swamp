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

import { Command } from "@cliffy/command";
import { createContext, type GlobalOptions } from "../context.ts";
import { UserError } from "../../domain/errors.ts";
import { resolveServerUrl, validateExtensionName } from "../../libswamp/mod.ts";
import { ExtensionApiClient } from "../../infrastructure/http/extension_api_client.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { loadIdentity } from "../load_identity.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const extensionPromoteCommand = new Command()
  .name("promote")
  .description(
    "Promote an extension version to a higher release channel (beta→rc, beta→stable, rc→stable)",
  )
  .example(
    "Promote beta to rc",
    "swamp extension promote @myorg/ext 2026.06.10.1 --channel rc",
  )
  .example(
    "Promote rc to stable",
    "swamp extension promote @myorg/ext 2026.06.10.1 --channel stable",
  )
  .arguments("<extension:string> <version:string>")
  .option(
    "--channel <channel:string>",
    "Target channel to promote to: 'rc' or 'stable'",
    { required: true },
  )
  .action(async function (
    options: AnyOptions,
    extension: string,
    version: string,
  ) {
    const cliCtx = createContext(options as GlobalOptions, [
      "extension",
      "promote",
    ]);
    cliCtx.logger.debug`Starting extension promote`;

    validateExtensionName(extension);

    const toChannel = options.channel as string;
    if (toChannel !== "rc" && toChannel !== "stable") {
      throw new UserError(
        `Invalid target channel: "${toChannel}". Must be 'rc' or 'stable'.`,
      );
    }

    const authRepo = new AuthRepository();
    const creds = await authRepo.load();
    if (!creds) {
      throw new UserError(
        "Not authenticated. Run 'swamp auth login' first.",
      );
    }

    const serverUrl = creds.serverUrl ?? resolveServerUrl();
    const identity = await loadIdentity();
    const client = new ExtensionApiClient(serverUrl, identity);

    const result = await client.promoteExtension(
      extension,
      version,
      toChannel,
      creds.apiKey,
    );

    if (cliCtx.outputMode === "json") {
      console.log(JSON.stringify(result));
    } else {
      console.log(result.message);
    }

    cliCtx.logger.debug("Extension promote command completed");
  });
