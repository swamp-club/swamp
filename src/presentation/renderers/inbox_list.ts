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

import { cyan, yellow } from "@std/fmt/colors";
import { maxOf } from "../../domain/array_extrema.ts";
import type {
  InboxListEvent,
  InboxListView,
} from "../../libswamp/inbox/list.ts";
import { userErrorFromSwampError } from "../../libswamp/errors.ts";
import type { EventHandlers } from "../../libswamp/stream.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";

const UNREAD_MARKER = "●";

/** The local calendar date of an ISO 8601 timestamp, as YYYY-MM-DD. */
export function localDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The stderr warning for entries left out of a page, if any were. */
export function droppedWarning(dropped: number): string | undefined {
  if (dropped <= 0) return undefined;
  return dropped === 1
    ? "1 message from Swamp Club did not match the inbox format and was left out."
    : `${dropped} messages from Swamp Club did not match the inbox format and were left out.`;
}

function listLines(view: InboxListView): string[] {
  const all = view.status === "all";
  if (view.messages.length === 0) {
    return [
      all
        ? "Your inbox is empty."
        : `No unread messages. ${
          yellow("To include read ones:")
        }  swamp inbox --all`,
    ];
  }

  const kindWidth = maxOf(view.messages.map((m) => m.kind.length)) ?? 0;
  const lines = view.messages.map((m) => {
    const marker = m.readAt === null ? cyan(UNREAD_MARKER) : " ";
    return `${marker}  ${localDate(m.createdAt)}  ${
      m.kind.padEnd(kindWidth)
    }  ${m.title}`;
  });
  const unread = view.messages.filter((m) => m.readAt === null).length;
  lines.push("", `${unread} unread of ${view.messages.length} shown.`);
  return lines;
}

/** The line naming the command that lists the page older than this one. */
export function olderPageLine(nextCursor: string, all: boolean): string {
  return `${yellow("To see older:")}  swamp inbox${
    all ? " --all" : ""
  } --before ${nextCursor}`;
}

class LogInboxListRenderer implements Renderer<InboxListEvent> {
  handlers(): EventHandlers<InboxListEvent> {
    return {
      loading_credentials: () => {},
      contacting_server: () => {},
      completed: ({ view }) => {
        const lines = listLines(view);
        if (view.nextCursor !== null) {
          lines.push(olderPageLine(view.nextCursor, view.status === "all"));
        }
        writeOutput(lines.join("\n"));

        const warning = droppedWarning(view.dropped);
        // stderr, so a server drifting from the contract shows up without
        // mixing into the list itself.
        if (warning) console.error(yellow(warning));
      },
      error: (e) => {
        throw userErrorFromSwampError(e.error);
      },
    };
  }
}

class JsonInboxListRenderer implements Renderer<InboxListEvent> {
  handlers(): EventHandlers<InboxListEvent> {
    return {
      loading_credentials: () => {},
      contacting_server: () => {},
      completed: ({ view }) => {
        // Built key by key, so the document never grows a field by accident.
        console.log(JSON.stringify(
          {
            status: view.status,
            messages: view.messages.map((m) => ({
              id: m.id,
              kind: m.kind,
              title: m.title,
              createdAt: m.createdAt,
              readAt: m.readAt,
            })),
            nextCursor: view.nextCursor,
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

export function createInboxListRenderer(
  mode: OutputMode,
): Renderer<InboxListEvent> {
  switch (mode) {
    case "json":
      return new JsonInboxListRenderer();
    case "log":
      return new LogInboxListRenderer();
  }
}
