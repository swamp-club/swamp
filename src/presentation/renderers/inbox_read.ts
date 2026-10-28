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

import { yellow } from "@std/fmt/colors";
import type { InboxMessageView } from "../../libswamp/inbox/list.ts";
import type {
  InboxReadNextEvent,
  InboxReadNextView,
  MarkReadEvent,
} from "../../libswamp/inbox/read.ts";
import { userErrorFromSwampError } from "../../libswamp/errors.ts";
import type { EventHandlers } from "../../libswamp/stream.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { renderMarkdownPlain } from "../markdown_renderer.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { droppedWarning, localDate } from "./inbox_list.ts";

export const NOT_MARKED_WARNING =
  "Swamp Club did not confirm this message as read, so it is still unread.";

/** One message as plain text, for output that is not a terminal. */
function plainMessageLines(message: InboxMessageView): string[] {
  const lines = [
    `${message.kind} · ${localDate(message.createdAt)}`,
    message.title,
    "",
    renderMarkdownPlain(message.body).trimEnd(),
  ];
  if (message.link !== undefined || message.action !== undefined) {
    lines.push("");
  }
  if (message.link !== undefined) {
    lines.push(`${yellow("Link:")}  ${message.link}`);
  }
  if (message.action !== undefined) {
    lines.push(`${yellow("Next:")}  ${message.action.command}`);
  }
  return lines;
}

function readLines(view: InboxReadNextView): string[] {
  if (view.message === null) {
    // Listing stopped before reaching a message it could show.
    return view.moreUnread
      ? ["No unread message could be shown; more unread messages remain."]
      : ["No unread messages."];
  }
  const lines = plainMessageLines(view.message);
  if (view.moreUnread) {
    lines.push("", `${yellow("To read the next:")}  swamp inbox read`);
  }
  return lines;
}

class LogInboxReadRenderer implements Renderer<InboxReadNextEvent> {
  handlers(): EventHandlers<InboxReadNextEvent> {
    return {
      loading_credentials: () => {},
      contacting_server: () => {},
      completed: ({ view }) => {
        writeOutput(readLines(view).join("\n"));
        // stderr, so neither warning mixes into the message itself.
        if (view.message !== null && !view.marked) {
          console.error(yellow(NOT_MARKED_WARNING));
        }
        const warning = droppedWarning(view.dropped);
        if (warning) console.error(yellow(warning));
      },
      error: (e) => {
        throw userErrorFromSwampError(e.error);
      },
    };
  }
}

class JsonInboxReadRenderer implements Renderer<InboxReadNextEvent> {
  handlers(): EventHandlers<InboxReadNextEvent> {
    return {
      loading_credentials: () => {},
      contacting_server: () => {},
      completed: ({ view }) => {
        const m = view.message;
        // Built key by key, so the document never grows a field by accident.
        console.log(JSON.stringify(
          {
            message: m === null ? null : {
              id: m.id,
              kind: m.kind,
              title: m.title,
              body: m.body,
              createdAt: m.createdAt,
              ...(m.link !== undefined ? { link: m.link } : {}),
              ...(m.action !== undefined
                ? {
                  action: { label: m.action.label, command: m.action.command },
                }
                : {}),
              readAt: m.readAt,
            },
            moreUnread: view.moreUnread,
            dropped: view.dropped,
          },
          null,
          2,
        ));
      },
      error: (e) => {
        throw userErrorFromSwampError(e.error);
      },
    };
  }
}

/** Renders `swamp inbox read` where no picker opens. */
export function createInboxReadRenderer(
  mode: OutputMode,
): Renderer<InboxReadNextEvent> {
  switch (mode) {
    case "json":
      return new JsonInboxReadRenderer();
    case "log":
      return new LogInboxReadRenderer();
  }
}

/**
 * Renders marking read from the picker. With `announce`, as after Ctrl-r and
 * Ctrl-a, it says how many were marked; after Enter the opened message in
 * the scrollback already says enough. With `openedId`, the unread message
 * Enter opened, it warns when Swamp Club did not confirm it as read, as
 * `swamp inbox read` does.
 */
export function createMarkReadRenderer(
  options: { announce: boolean; openedId?: string },
): Renderer<MarkReadEvent> {
  return {
    handlers: () => ({
      loading_credentials: () => {},
      contacting_server: () => {},
      completed: ({ marked }) => {
        const { openedId } = options;
        if (
          openedId !== undefined &&
          !marked.some((id) => id.toUpperCase() === openedId.toUpperCase())
        ) {
          console.error(yellow(NOT_MARKED_WARNING));
        }
        if (!options.announce) return;
        writeOutput(
          marked.length === 1
            ? "Marked 1 message read."
            : `Marked ${marked.length} messages read.`,
        );
      },
      error: (e) => {
        throw userErrorFromSwampError(e.error);
      },
    }),
  };
}
