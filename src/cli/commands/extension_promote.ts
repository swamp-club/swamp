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
import {
  consumeStream,
  createExtensionPromoteDeps,
  createLibSwampContext,
  extensionPromote,
  extensionPromoteValidate,
  validateExtensionName,
} from "../../libswamp/mod.ts";
import { createExtensionPromoteRenderer } from "../../presentation/renderers/extension_promote.ts";

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
  .option(
    "--from-channel <fromChannel:string>",
    "Source channel ('beta' or 'rc'); skips direction validation if omitted",
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
    const fromChannel = options.fromChannel as string | undefined;
    const input = {
      extensionName: extension,
      version,
      toChannel,
      fromChannel,
    };

    try {
      extensionPromoteValidate(input);
    } catch (error) {
      if ("code" in (error as Record<string, unknown>)) {
        throw new UserError((error as { message: string }).message);
      }
      throw error;
    }

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createExtensionPromoteDeps();

    const renderer = createExtensionPromoteRenderer(cliCtx.outputMode);
    await consumeStream(
      extensionPromote(ctx, deps, input),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Extension promote command completed");
  });
