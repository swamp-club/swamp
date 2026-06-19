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
import { requestServerResponse } from "../../cli/remote_run.ts";
import type { AccessCanIResponse } from "../../serve/protocol.ts";
import { createAccessCanIRenderer } from "../../presentation/renderers/access_can_i.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const accessCanICommand = new Command()
  .name("can-i")
  .description(
    "Check your own permissions against the server's grants",
  )
  .example(
    "Check a specific permission",
    "swamp access can-i --action run --on workflow:@acme/deploy --server wss://swamp.acme.internal:9090",
  )
  .example(
    "List everything you can do",
    "swamp access can-i --server wss://swamp.acme.internal:9090",
  )
  .option(
    "--server <url:string>",
    "Server to check permissions against (required)",
    { required: true },
  )
  .option(
    "--token <token:string>",
    "Server token (falls back to stored credential)",
  )
  .option(
    "--action <action:string>",
    "Action to check (run, read, write, admin)",
  )
  .option(
    "--on <resource:string>",
    "Resource to check (e.g. workflow:@acme/deploy)",
  )
  .option(
    "--collectives <collectives:string>",
    "Comma-separated IdP group memberships to simulate",
  )
  .action(async function (options: AnyOptions) {
    if (!!options.action !== !!options.on) {
      throw new UserError(
        "--action and --on must be used together; omit both to list all permissions",
      );
    }

    const ctx = createContext(options as GlobalOptions, [
      "access",
      "can-i",
    ]);

    const collectives = options.collectives
      ? (options.collectives as string).split(",").map((c: string) => c.trim())
        .filter((c: string) => c.length > 0)
      : undefined;

    const response = await requestServerResponse<AccessCanIResponse>(
      {
        server: options.server as string,
        ...(options.token ? { token: options.token as string } : {}),
      },
      {
        type: "access.can-i",
        payload: {
          ...(options.action ? { action: options.action as string } : {}),
          ...(options.on ? { resource: options.on as string } : {}),
          ...(collectives ? { collectives } : {}),
        },
      },
    );

    const renderer = createAccessCanIRenderer(ctx.outputMode);
    renderer.render(response);

    if (options.action && options.on) {
      const isDenied = response.decisions.length === 0 ||
        response.decisions[0].effect !== "allow";
      if (isDenied) Deno.exitCode = 1;
    }
  });
