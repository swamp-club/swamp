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
import { createAuthDeps } from "../../libswamp/auth/whoami.ts";
import { subscriptionStatus } from "../../libswamp/subscription/status.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { createSubscriptionStatusRenderer } from "../../presentation/renderers/subscription_status.ts";
import { loadIdentity } from "../load_identity.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const subscriptionStatusCommand = new Command()
  .name("status")
  .description(
    "Show the plan and billing standing of the signed-in user and each " +
      "collective they belong to, and how to open swamp-club billing.",
  )
  .example("Show subscription standing", "swamp subscription status")
  .example(
    "Show subscription standing as JSON",
    "swamp subscription status --json",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "subscription",
      "status",
    ]);
    cliCtx.logger.debug("Executing subscription status command");

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const identity = await loadIdentity();
    const deps = createAuthDeps({
      serverUrlOverride: Deno.env.get("SWAMP_CLUB_URL"),
      identity,
    });

    const renderer = createSubscriptionStatusRenderer(cliCtx.outputMode);
    await consumeStream(subscriptionStatus(ctx, deps), renderer.handlers());

    cliCtx.logger.debug("Subscription status command completed");
  });
