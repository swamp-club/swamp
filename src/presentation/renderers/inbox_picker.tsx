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

// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import { bold, cyan, dim, yellow } from "@std/fmt/colors";
import wrapAnsi from "wrap-ansi";
import { maxOf } from "../../domain/array_extrema.ts";
import type {
  InboxBrowseEvent,
  InboxBrowseView,
  InboxMessageView,
} from "../../libswamp/inbox/list.ts";
import { userErrorFromSwampError } from "../../libswamp/errors.ts";
import type { EventHandlers } from "../../libswamp/stream.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { renderUntrustedMarkdownToTerminal } from "../markdown_renderer.ts";
import type { Renderer } from "../renderer.ts";
import type { ActionDef } from "./components/help_bar.tsx";
import {
  type PickerResult,
  renderInteractivePicker,
} from "./components/search_picker.tsx";
import { droppedWarning, localDate, olderPageLine } from "./inbox_list.ts";

const UNREAD_MARKER = "●";

/**
 * The picker's own keys. Action keys need Ctrl, since plain letters type
 * into the filter, and Ctrl-m is Enter, so "mark read" takes Ctrl-r.
 */
export const INBOX_PICKER_ACTIONS: ActionDef[] = [
  { key: "r", label: "Mark read", action: "mark" },
  { key: "a", label: "Mark all read", action: "mark_all" },
];

/** What the user chose in the picker, and the ids it marks read. */
export interface InboxPickerSelection {
  kind: "open" | "mark" | "mark_all" | "cancelled";
  /** The unread messages the choice marks read; empty when none are. */
  ids: string[];
  /** The message opened or marked, when the choice was about one. */
  message?: InboxMessageView;
}

/** The newest unread message's row, or 0 when the page has none unread. */
export function newestUnreadIndex(messages: InboxMessageView[]): number {
  const index = messages.findIndex((m) => m.readAt === null);
  return index === -1 ? 0 : index;
}

/** Maps the picker's result onto the messages it marks read. */
export function toInboxPickerSelection(
  result: PickerResult<InboxMessageView> | undefined,
  messages: InboxMessageView[],
): InboxPickerSelection {
  if (result === undefined) return { kind: "cancelled", ids: [] };
  const unreadIds = (list: InboxMessageView[]) =>
    list.filter((m) => m.readAt === null).map((m) => m.id);
  switch (result.action) {
    case undefined:
      return {
        kind: "open",
        ids: unreadIds([result.item]),
        message: result.item,
      };
    case "mark":
      return {
        kind: "mark",
        ids: unreadIds([result.item]),
        message: result.item,
      };
    // The whole loaded page, not just the rows the filter left showing.
    case "mark_all":
      return { kind: "mark_all", ids: unreadIds(messages) };
    default:
      return { kind: "cancelled", ids: [] };
  }
}

/** The preview's width inside the pane, past its left margin. */
function previewInnerWidth(width: number): number {
  return Math.max(10, width - 1);
}

/**
 * The message as text: heading, body, then its link and suggested command.
 * With `width`, every line is wrapped to it, breaking a word longer than the
 * width, so each entry is exactly one rendered row: nothing is cut off, and
 * a long link always shows whole rather than as a trusted-looking start.
 */
export function inboxMessageLines(
  message: InboxMessageView,
  width?: number,
): string[] {
  const lines = [
    dim(`${message.kind} · ${localDate(message.createdAt)}`),
    bold(message.title),
    "",
    ...renderUntrustedMarkdownToTerminal(
      message.body,
      width !== undefined ? { maxWidth: width } : undefined,
    ).trimEnd().split("\n"),
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
  if (width === undefined) return lines;
  return lines.flatMap((line) =>
    wrapAnsi(line, width, { hard: true, trim: false }).split("\n")
  );
}

export interface InboxPickerConfig {
  items: InboxMessageView[];
  selector: (item: InboxMessageView) => string;
  renderResultLine: (item: InboxMessageView) => React.ReactElement;
  renderPreview: (
    item: InboxMessageView,
    detail: unknown,
    width: number,
    height: number,
  ) => React.ReactElement;
  renderScrollback: (item: InboxMessageView, detail: unknown) => string;
  previewLineCount: (
    item: InboxMessageView,
    detail: unknown,
    width: number,
  ) => number;
  actions: ActionDef[];
  initialIndex: number;
}

/**
 * Everything the shared picker needs for one page of messages. Previewing
 * makes no request and marks nothing read: every field is already loaded.
 */
export function inboxPickerConfig(
  view: InboxBrowseView,
  highlightNewestUnread: boolean,
): InboxPickerConfig {
  const kindWidth = maxOf(view.messages.map((m) => m.kind.length)) ?? 0;
  return {
    items: view.messages,
    selector: (m) => `${m.title} ${m.kind}`,
    renderResultLine: (m) => (
      <Text>
        {m.readAt === null ? cyan(UNREAD_MARKER) : " "}
        {`  ${localDate(m.createdAt)}  ${m.kind.padEnd(kindWidth)}  ${m.title}`}
      </Text>
    ),
    renderPreview: (m, _detail, width) => {
      const innerWidth = previewInnerWidth(width);
      return (
        <Box flexDirection="column" marginLeft={1} width={innerWidth}>
          {inboxMessageLines(m, innerWidth).map((line, i) => (
            <Text key={i} wrap="truncate-end">{line}</Text>
          ))}
        </Box>
      );
    },
    renderScrollback: (m) => inboxMessageLines(m).join("\n"),
    previewLineCount: (m, _detail, width) =>
      inboxMessageLines(m, previewInnerWidth(width)).length,
    actions: INBOX_PICKER_ACTIONS,
    initialIndex: highlightNewestUnread ? newestUnreadIndex(view.messages) : 0,
  };
}

export interface InboxPickerRenderer extends Renderer<InboxBrowseEvent> {
  /** The user's choice; cancelled until the picker has closed. */
  selection(): InboxPickerSelection;
  /**
   * Prints the command for older messages when the loaded page was not the
   * last. Called once the picker has closed and its choice is carried out.
   */
  printOlderPageLine(): void;
}

class InkInboxPickerRenderer implements InboxPickerRenderer {
  private _selection: InboxPickerSelection = { kind: "cancelled", ids: [] };
  private nextCursor: string | null = null;

  constructor(private readonly highlightNewestUnread: boolean) {}

  selection(): InboxPickerSelection {
    return this._selection;
  }

  printOlderPageLine(): void {
    // The picker lists read and unread messages, so the next page does too.
    if (this.nextCursor !== null) {
      writeOutput(olderPageLine(this.nextCursor, true));
    }
  }

  handlers(): EventHandlers<InboxBrowseEvent> {
    return {
      loading_credentials: () => {},
      contacting_server: () => {},
      completed: async ({ view }) => {
        const warning = droppedWarning(view.dropped);
        // stderr, and before the picker, so it is on screen once it closes.
        if (warning) console.error(yellow(warning));
        this.nextCursor = view.nextCursor;
        if (view.messages.length === 0) {
          writeOutput("Your inbox is empty.");
          return;
        }
        const config = inboxPickerConfig(view, this.highlightNewestUnread);
        const result = await renderInteractivePicker<InboxMessageView>(
          config.items,
          "",
          config.selector,
          config.renderResultLine,
          config.renderPreview,
          config.renderScrollback,
          "messages",
          {
            commandName: "inbox",
            previewLineCount: config.previewLineCount,
            actions: config.actions,
            initialIndex: config.initialIndex,
          },
        );
        this._selection = toInboxPickerSelection(result, view.messages);
      },
      error: (e) => {
        throw userErrorFromSwampError(e.error);
      },
    };
  }
}

/**
 * The interactive inbox. With `highlightNewestUnread`, as `swamp inbox read`
 * opens it, the newest unread message on the page is highlighted first.
 */
export function createInboxPickerRenderer(
  options: { highlightNewestUnread?: boolean } = {},
): InboxPickerRenderer {
  return new InkInboxPickerRenderer(options.highlightNewestUnread === true);
}
