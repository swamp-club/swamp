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
  createInboxListDeps,
  DEFAULT_INBOX_LIST_LIMIT,
  inboxList,
  MAX_INBOX_LIST_LIMIT,
} from "../../libswamp/inbox/list.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { createInboxListRenderer } from "../../presentation/renderers/inbox_list.ts";
import { loadIdentity } from "../load_identity.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

// The action sits on `inbox` itself, so `swamp inbox read` can join as a
// subcommand later without changing what `swamp inbox` does.
export const inboxCommand = new Command()
  .name("inbox")
  .description(
    "List your Swamp Club inbox messages, newest first: unread ones unless " +
      "--all is given. Shows each message's date, kind and title; it does " +
      "not mark anything read.",
  )
  .option("--all", "Include messages you have already read")
  .option(
    "--limit <n:integer>",
    `How many messages to list, 1 to ${MAX_INBOX_LIST_LIMIT} (default ${DEFAULT_INBOX_LIST_LIMIT})`,
  )
  .option(
    "--before <id:string>",
    "List the messages older than this message id",
  )
  .example("List unread messages", "swamp inbox")
  .example("List read and unread messages as JSON", "swamp inbox --all --json")
  .example(
    "List the next page",
    "swamp inbox --all --before 01JBX5Q8ZK00000000000000ZP",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, ["inbox"]);
    cliCtx.logger.debug("Executing inbox command");

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const identity = await loadIdentity();
    const deps = createInboxListDeps({
      serverUrlOverride: Deno.env.get("SWAMP_CLUB_URL"),
      identity,
    });

    const renderer = createInboxListRenderer(cliCtx.outputMode);
    await consumeStream(
      inboxList(ctx, deps, {
        all: options.all === true,
        limit: options.limit,
        before: options.before,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Inbox command completed");
  });
