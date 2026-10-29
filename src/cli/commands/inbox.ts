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
import {
  createContext,
  type GlobalOptions,
  isStdinTty,
  isStdoutTty,
} from "../context.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import {
  createInboxListDeps,
  DEFAULT_INBOX_LIST_LIMIT,
  inboxBrowse,
  type InboxBrowseView,
  inboxList,
  type InboxListInput,
  MAX_INBOX_LIST_LIMIT,
} from "../../libswamp/inbox/list.ts";
import {
  createInboxMarkSession,
  createInboxReadDeps,
  inboxReadById,
  inboxReadNext,
} from "../../libswamp/inbox/read.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { userErrorFromSwampError } from "../../libswamp/errors.ts";
import { createInboxListRenderer } from "../../presentation/renderers/inbox_list.ts";
import { createInboxTuiRenderer } from "../../presentation/renderers/inbox_tui.tsx";
import { createInboxReadRenderer } from "../../presentation/renderers/inbox_read.ts";
import type { OutputMode } from "../../presentation/output/output.ts";
import { loadIdentity } from "../load_identity.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Whether `swamp inbox` opens the interactive inbox: only in log mode with
 * both stdin and stdout on a terminal. `interactiveOutputMode` does not fit
 * here: it checks stdin alone and falls back to JSON, while piped
 * `swamp inbox` must keep printing its plain list. `swamp inbox read` never
 * opens it.
 */
export function inboxPickerApplies(
  outputMode: OutputMode,
  stdinIsTty: boolean,
  stdoutIsTty: boolean,
): boolean {
  return outputMode === "log" && stdinIsTty && stdoutIsTty;
}

/**
 * Opens the inbox over the first page of messages. It marks read in the
 * background while open, loads older pages as the user reaches them, and
 * once closed prints what was read and marked.
 */
async function runInbox(
  logger: ReturnType<typeof createContext>["logger"],
  input: InboxListInput,
): Promise<void> {
  const ctx = createLibSwampContext({ logger });
  const identity = await loadIdentity();
  const serverUrlOverride = Deno.env.get("SWAMP_CLUB_URL");
  const listDeps = createInboxListDeps({ serverUrlOverride, identity });

  const loadOlder = async (
    cursor: string,
    signal: AbortSignal,
  ): Promise<InboxBrowseView> => {
    let page: InboxBrowseView | undefined;
    await consumeStream(
      inboxBrowse(ctx.withSignal(signal), listDeps, {
        ...input,
        before: cursor,
      }),
      {
        loading_credentials: () => {},
        contacting_server: () => {},
        completed: ({ view }) => {
          page = view;
        },
        error: (e) => {
          throw userErrorFromSwampError(e.error);
        },
      },
    );
    if (page === undefined) throw new Error("No page was loaded.");
    return page;
  };

  await consumeStream(
    inboxBrowse(ctx, listDeps, input),
    createInboxTuiRenderer({
      markSession: createInboxMarkSession(
        ctx,
        createInboxReadDeps({ serverUrlOverride, identity }),
      ),
      loadOlder,
    }).handlers(),
  );
}

const inboxReadCommand = new Command()
  .name("read")
  .description(
    "Print one message and mark it read: the message with that id, or else " +
      "the next one to read. Never interactive.",
  )
  .arguments("[id:string]")
  .example("Read the next message", "swamp inbox read")
  .example(
    "Read one message by its id",
    "swamp inbox read 01JBX5Q8ZK0000000000000104",
  )
  .example("Read it as JSON", "swamp inbox read --json")
  .action(async function (options: AnyOptions, id?: string) {
    const cliCtx = createContext(options as GlobalOptions, ["inbox", "read"]);
    cliCtx.logger.debug("Executing inbox read command");

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const identity = await loadIdentity();
    const deps = createInboxReadDeps({
      serverUrlOverride: Deno.env.get("SWAMP_CLUB_URL"),
      identity,
    });
    await consumeStream(
      id === undefined
        ? inboxReadNext(ctx, deps)
        : inboxReadById(ctx, deps, id),
      createInboxReadRenderer(cliCtx.outputMode).handlers(),
    );

    cliCtx.logger.debug("Inbox read command completed");
  });

// The action sits on `inbox` itself; `read` is a subcommand beside it.
export const inboxCommand = new Command()
  .name("inbox")
  .description(
    "Browse your Swamp Club inbox: an interactive inbox in a terminal; " +
      "otherwise a list of messages with their ids. Marks nothing read.",
  )
  .option(
    "--all",
    "Include messages you have already read; the interactive inbox always includes them",
  )
  .option(
    "--limit <n:integer>",
    `How many messages to load, 1 to ${MAX_INBOX_LIST_LIMIT} (default ${DEFAULT_INBOX_LIST_LIMIT})`,
  )
  .option(
    "--before <id:string>",
    "Load the messages older than this message id",
  )
  .example("Browse your inbox", "swamp inbox")
  .example("List read and unread messages as JSON", "swamp inbox --all --json")
  .example(
    "List the next page",
    "swamp inbox --all --before 01JBX5Q8ZK00000000000000ZP",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, ["inbox"]);
    cliCtx.logger.debug("Executing inbox command");

    const input: InboxListInput = {
      all: options.all === true,
      limit: options.limit,
      before: options.before,
    };

    if (inboxPickerApplies(cliCtx.outputMode, isStdinTty(), isStdoutTty())) {
      await runInbox(cliCtx.logger, input);
    } else {
      const ctx = createLibSwampContext({ logger: cliCtx.logger });
      const identity = await loadIdentity();
      const deps = createInboxListDeps({
        serverUrlOverride: Deno.env.get("SWAMP_CLUB_URL"),
        identity,
      });
      await consumeStream(
        inboxList(ctx, deps, input),
        createInboxListRenderer(cliCtx.outputMode).handlers(),
      );
    }

    cliCtx.logger.debug("Inbox command completed");
  })
  .command("read", inboxReadCommand);
