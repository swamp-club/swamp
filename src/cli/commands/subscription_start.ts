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
import { consumeStream } from "../../libswamp/stream.ts";
import {
  createSubscriptionStartDeps,
  subscriptionStart,
} from "../../libswamp/subscription/start.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { createSubscriptionStartRenderer } from "../../presentation/renderers/subscription_start.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const subscriptionStartCommand = new Command()
  .name("start")
  .description(
    "Open the swamp-club billing page in your browser to upgrade or manage " +
      "billing, for yourself or a collective.",
  )
  .example("Open your billing page", "swamp subscription start")
  .example(
    "Open a collective's billing page",
    "swamp subscription start --collective acme",
  )
  .example(
    "Print the billing URL instead of opening a browser",
    "swamp subscription start --no-browser",
  )
  .option(
    "--collective <slug:string>",
    "Open this collective's billing page instead of your own",
  )
  .option("--no-browser", "Print the URL instead of opening a browser")
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "subscription",
      "start",
    ]);
    cliCtx.logger.debug("Executing subscription start command");

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const renderer = createSubscriptionStartRenderer(cliCtx.outputMode);
    await consumeStream(
      subscriptionStart(ctx, createSubscriptionStartDeps(), {
        collective: options.collective,
        noBrowser: options.browser === false,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Subscription start command completed");
  });
