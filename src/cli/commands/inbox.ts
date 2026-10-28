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
  inboxList,
  type InboxListInput,
  MAX_INBOX_LIST_LIMIT,
} from "../../libswamp/inbox/list.ts";
import {
  createInboxReadDeps,
  inboxReadNext,
  markRead,
} from "../../libswamp/inbox/read.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { createInboxListRenderer } from "../../presentation/renderers/inbox_list.ts";
import { createInboxPickerRenderer } from "../../presentation/renderers/inbox_picker.tsx";
import {
  createInboxReadRenderer,
  createMarkReadRenderer,
} from "../../presentation/renderers/inbox_read.ts";
import type { OutputMode } from "../../presentation/output/output.ts";
import { loadIdentity } from "../load_identity.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Whether the inbox opens its interactive picker: only in log mode with both
 * stdin and stdout on a terminal. `interactiveOutputMode` does not fit here:
 * it checks stdin alone and falls back to JSON, while piped `swamp inbox`
 * must keep printing its plain list.
 */
export function inboxPickerApplies(
  outputMode: OutputMode,
  stdinIsTty: boolean,
  stdoutIsTty: boolean,
): boolean {
  return outputMode === "log" && stdinIsTty && stdoutIsTty;
}

/**
 * Opens the picker over one page of messages, then marks read what the user
 * chose. Esc changes nothing.
 */
async function runInboxPicker(
  logger: ReturnType<typeof createContext>["logger"],
  input: InboxListInput,
  highlightNewestUnread: boolean,
): Promise<void> {
  const ctx = createLibSwampContext({ logger });
  const identity = await loadIdentity();
  const serverUrlOverride = Deno.env.get("SWAMP_CLUB_URL");

  const picker = createInboxPickerRenderer({ highlightNewestUnread });
  await consumeStream(
    inboxBrowse(
      ctx,
      createInboxListDeps({ serverUrlOverride, identity }),
      input,
    ),
    picker.handlers(),
  );

  const selection = picker.selection();
  if (selection.kind !== "cancelled") {
    // Enter on an unread message marks it; one already read marks nothing,
    // so there is nothing for Swamp Club to confirm.
    const openedId = selection.kind === "open" ? selection.ids[0] : undefined;
    await consumeStream(
      markRead(
        ctx,
        createInboxReadDeps({ serverUrlOverride, identity }),
        selection.ids,
      ),
      createMarkReadRenderer({
        announce: selection.kind !== "open",
        ...(openedId !== undefined ? { openedId } : {}),
      }).handlers(),
    );
  }
  picker.printOlderPageLine();
}

const inboxReadCommand = new Command()
  .name("read")
  .description(
    "Read your Swamp Club inbox. In a terminal, opens the inbox picker with " +
      "the newest unread message highlighted. Otherwise prints the newest " +
      "unread message and marks it read.",
  )
  .example("Read the newest unread message", "swamp inbox read")
  .example("Read it as JSON", "swamp inbox read --json")
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, ["inbox", "read"]);
    cliCtx.logger.debug("Executing inbox read command");

    if (inboxPickerApplies(cliCtx.outputMode, isStdinTty(), isStdoutTty())) {
      await runInboxPicker(cliCtx.logger, {}, true);
    } else {
      const ctx = createLibSwampContext({ logger: cliCtx.logger });
      const identity = await loadIdentity();
      await consumeStream(
        inboxReadNext(
          ctx,
          createInboxReadDeps({
            serverUrlOverride: Deno.env.get("SWAMP_CLUB_URL"),
            identity,
          }),
        ),
        createInboxReadRenderer(cliCtx.outputMode).handlers(),
      );
    }

    cliCtx.logger.debug("Inbox read command completed");
  });

// The action sits on `inbox` itself; `read` is a subcommand beside it.
export const inboxCommand = new Command()
  .name("inbox")
  .description(
    "Your Swamp Club inbox, newest first. In a terminal, opens a picker to " +
      "browse, preview and open messages; opening one marks it read. " +
      "Otherwise lists unread messages (all with --all) by date, kind and " +
      "title, and marks nothing read.",
  )
  .option(
    "--all",
    "Include messages you have already read; the terminal picker always includes them",
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
      await runInboxPicker(cliCtx.logger, input, false);
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
