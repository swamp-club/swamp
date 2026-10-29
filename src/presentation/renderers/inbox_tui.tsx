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
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import { Fzf, type FzfResultItem } from "fzf";
import { bold, cyan, dim, yellow } from "@std/fmt/colors";
import wrapAnsi from "wrap-ansi";
import { maxOf } from "../../domain/array_extrema.ts";
import type {
  InboxBrowseEvent,
  InboxBrowseView,
  InboxMessageView,
} from "../../libswamp/inbox/list.ts";
import type {
  InboxMarkOutcome,
  InboxMarkSession,
} from "../../libswamp/inbox/read.ts";
import { userErrorFromSwampError } from "../../libswamp/errors.ts";
import type { EventHandlers } from "../../libswamp/stream.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { suppressInkTtyErrors } from "../output/ink_lifecycle.ts";
import { renderUntrustedMarkdownToTerminal } from "../markdown_renderer.ts";
import type { Renderer } from "../renderer.ts";
import { HelpBar } from "./components/help_bar.tsx";
import {
  usePreviewScroll,
  useScrollableList,
  useTerminalSize,
} from "./components/hooks/mod.ts";
import {
  BorderedSplitLayout,
  BrandLine,
  StackedLayout,
} from "./components/picker_borders.tsx";
import { computePickerLayout } from "./components/picker_layout.ts";
import { PreviewPane } from "./components/preview_pane.tsx";
import { ResultsList } from "./components/results_list.tsx";
import { droppedWarning, localDate } from "./inbox_list.ts";

const UNREAD_MARKER = "●";
const CURSOR = "▏";
const COMMAND_NAME = "inbox";

/** Rows the message view keeps for itself: the brand line and the help bar. */
const MESSAGE_VIEW_CHROME_LINES = 2;

/** The list's key hints. Esc clears a filter before it quits. */
export function inboxListKeys(
  hasPreview: boolean,
  filtering: boolean,
): string[] {
  return [
    "↑/↓ navigate",
    ...(hasPreview ? ["Ctrl-u/d scroll"] : []),
    "Enter open",
    "Ctrl-r mark read",
    "Ctrl-a mark all read",
    filtering ? "Esc clear filter" : "Esc quit",
  ];
}

/** The message view's key hints. */
export const INBOX_MESSAGE_KEYS: readonly string[] = [
  "↑/↓ scroll",
  "PgUp/PgDn page",
  "Esc back",
];

/** The newest unread message's row, or 0 when the page has none unread. */
export function newestUnreadIndex(messages: InboxMessageView[]): number {
  const index = messages.findIndex((m) => m.readAt === null);
  return index === -1 ? 0 : index;
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

function messages(n: number): string {
  return n === 1 ? "1 message" : `${n} messages`;
}

/**
 * The line printed after the inbox closes, from the counts Swamp Club
 * confirmed; undefined when nothing was read or marked.
 */
export function inboxQuitLine(
  read: number,
  marked: number,
): string | undefined {
  if (read > 0 && marked > 0) {
    return `Read ${messages(read)} and marked ${marked} read.`;
  }
  if (read > 0) return `Read ${messages(read)}.`;
  if (marked > 0) return `Marked ${messages(marked)} read.`;
  return undefined;
}

/** Why opening a message or marking one read is sent. */
export type InboxMarkReason = "read" | "marked";

/** What the inbox asks of the world outside it. */
export interface InboxTuiBackend {
  /** Marks these ids read; resolves to what Swamp Club confirmed. */
  markRead(
    ids: readonly string[],
    reason: InboxMarkReason,
  ): Promise<InboxMarkOutcome>;
  /** Loads the page older than `cursor`. */
  loadOlder(cursor: string): Promise<InboxBrowseView>;
}

export interface InboxTuiProps {
  initial: InboxBrowseView;
  backend: InboxTuiBackend;
  /** Called once, when the user leaves the inbox. */
  onQuit: () => void;
}

function failedLine(count: number, reason: string): string {
  return `Could not mark ${messages(count)} read: ${reason}`;
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The inbox: a list to browse and a view to read one message, open until the
 * user leaves. Marking read happens in the background; the list shows it at
 * once, and puts a message's dot back if Swamp Club does not confirm it.
 */
export function InboxTui(props: InboxTuiProps): React.ReactElement {
  const { initial, backend, onQuit } = props;
  const { exit } = useApp();
  const { width, height } = useTerminalSize();
  const layout = computePickerLayout(width, height);

  const [items, setItems] = useState(initial.messages);
  const [nextCursor, setNextCursor] = useState(initial.nextCursor);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Read here, not yet confirmed or confirmed: what the dots show.
  const [readHere, setReadHere] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const [messageOffset, setMessageOffset] = useState(0);
  const quitting = useRef(false);

  const isUnread = useCallback(
    (m: InboxMessageView) => m.readAt === null && !readHere.has(m.id),
    [readHere],
  );

  const fzf = useMemo(() => {
    const FzfCtor = Fzf as unknown as new (...args: unknown[]) => {
      find(query: string): FzfResultItem<InboxMessageView>[];
    };
    return new FzfCtor(items, {
      selector: (m: InboxMessageView) => `${m.title} ${m.kind}`,
    });
  }, [items]);
  const results = fzf.find(query);

  const listHeight = Math.max(
    1,
    layout.resultsHeight - (loadingOlder ? 1 : 0),
  );
  const { selectedIndex, setSelectedIndex, visibleItems, scrollMetrics } =
    useScrollableList(
      results,
      listHeight,
      [query],
      newestUnreadIndex(initial.messages),
    );
  const highlighted = selectedIndex < results.length
    ? results[selectedIndex].item
    : undefined;

  const contentLines = highlighted
    ? inboxMessageLines(highlighted, previewInnerWidth(layout.previewWidth))
      .length
    : 0;
  const { scrollOffset, scrollUp, scrollDown } = usePreviewScroll(
    Math.max(layout.previewHeight, contentLines),
    layout.previewHeight,
    highlighted,
  );

  const opened = openId === undefined
    ? undefined
    : items.find((m) => m.id === openId);
  const messageWidth = Math.max(10, width - 1);
  const messageViewport = Math.max(1, height - MESSAGE_VIEW_CHROME_LINES);
  const openedLines = opened ? inboxMessageLines(opened, messageWidth) : [];
  const maxMessageOffset = Math.max(0, openedLines.length - messageViewport);

  const mark = useCallback(
    (ids: string[], reason: InboxMarkReason) => {
      if (ids.length === 0) return;
      setReadHere((prev) => new Set([...prev, ...ids]));
      const restore = (failed: string[], why: string) => {
        if (failed.length === 0) return;
        setReadHere((prev) => {
          const next = new Set(prev);
          for (const id of failed) next.delete(id);
          return next;
        });
        setStatus(failedLine(failed.length, why));
      };
      backend.markRead(ids, reason).then(
        (outcome) => {
          if (outcome.kind === "failed") {
            restore(ids, outcome.reason);
            return;
          }
          const confirmed = new Set(outcome.ids.map((c) => c.toUpperCase()));
          restore(
            ids.filter((id) => !confirmed.has(id.toUpperCase())),
            "Swamp Club did not confirm it",
          );
        },
        (error: unknown) => restore(ids, errorReason(error)),
      );
    },
    [backend],
  );

  const quit = useCallback(() => {
    if (quitting.current) return;
    quitting.current = true;
    exit();
    onQuit();
  }, [exit, onQuit]);

  // Reaching the last row loads the next page, once at a time.
  const lastRow = results.length > 0 && selectedIndex === results.length - 1;
  useEffect(() => {
    if (!lastRow || nextCursor === null || loadingOlder || quitting.current) {
      return;
    }
    setLoadingOlder(true);
    backend.loadOlder(nextCursor).then(
      (page) => {
        setItems((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          return [...prev, ...page.messages.filter((m) => !seen.has(m.id))];
        });
        setNextCursor(page.nextCursor);
        setLoadingOlder(false);
      },
      (error: unknown) => {
        // Not retried on its own: the next key past the last row retries.
        setNextCursor(null);
        setLoadingOlder(false);
        if (!quitting.current) {
          setStatus(`Could not load older messages: ${errorReason(error)}`);
        }
      },
    );
  }, [lastRow, nextCursor, loadingOlder, backend]);

  // The state this render draws. Ink re-binds the useInput handler in an
  // effect after the frame is written, so a key can reach the handler of an
  // earlier render; reading from here makes it act on what the frame shows.
  const latest = useRef({
    results,
    selectedIndex,
    items,
    isUnread,
    query,
    opened,
    maxMessageOffset,
  });
  latest.current = {
    results,
    selectedIndex,
    items,
    isUnread,
    query,
    opened,
    maxMessageOffset,
  };

  useInput((input, key) => {
    const now = latest.current;
    setStatus(undefined);

    if (key.ctrl && input === "c") {
      quit();
      return;
    }

    if (now.opened !== undefined) {
      const page = Math.max(1, messageViewport - 1);
      const half = Math.max(1, Math.floor(messageViewport / 2));
      const scrollBy = (delta: number) =>
        setMessageOffset((o) =>
          Math.max(0, Math.min(now.maxMessageOffset, o + delta))
        );
      if (key.escape) {
        setOpenId(undefined);
      } else if (key.upArrow) {
        scrollBy(-1);
      } else if (key.downArrow) {
        scrollBy(1);
      } else if (key.pageUp) {
        scrollBy(-page);
      } else if (key.pageDown) {
        scrollBy(page);
      } else if (key.ctrl && input === "u") {
        scrollBy(-half);
      } else if (key.ctrl && input === "d") {
        scrollBy(half);
      }
      return;
    }

    const current = now.selectedIndex < now.results.length
      ? now.results[now.selectedIndex].item
      : undefined;

    if (key.escape) {
      if (now.query !== "") setQuery("");
      else quit();
      return;
    }
    if (key.return) {
      if (current === undefined) return;
      setMessageOffset(0);
      setOpenId(current.id);
      if (now.isUnread(current)) mark([current.id], "read");
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((i) =>
        Math.min(Math.max(0, latest.current.results.length - 1), i + 1)
      );
      return;
    }
    if (key.ctrl && input === "u") {
      scrollUp();
      return;
    }
    if (key.ctrl && input === "d") {
      scrollDown();
      return;
    }
    // Ctrl-m is Enter, so "mark read" takes Ctrl-r.
    if (key.ctrl && input === "r") {
      if (current !== undefined && now.isUnread(current)) {
        mark([current.id], "marked");
      }
      return;
    }
    // Every unread message loaded, not just the rows the filter shows.
    if (key.ctrl && input === "a") {
      mark(now.items.filter(now.isUnread).map((m) => m.id), "marked");
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setQuery((q) => q + input);
    }
  }, { isActive: !quitting.current });

  const bottomLine = (keys: readonly string[]) =>
    status !== undefined
      ? <Text color="yellow" wrap="truncate-end">{status}</Text>
      : <HelpBar hasPreview={false} keys={[...keys]} />;

  if (opened !== undefined) {
    const offset = Math.min(messageOffset, maxMessageOffset);
    return (
      <Box flexDirection="column" width={width}>
        <BrandLine width={width} commandName={COMMAND_NAME} />
        <Box
          flexDirection="column"
          height={messageViewport}
          marginLeft={1}
          overflow="hidden"
        >
          {openedLines.slice(offset, offset + messageViewport).map((
            line,
            i,
          ) => <Text key={i} wrap="truncate-end">{line}</Text>)}
        </Box>
        {bottomLine(INBOX_MESSAGE_KEYS)}
      </Box>
    );
  }

  const kindWidth = maxOf(items.map((m) => m.kind.length)) ?? 0;
  const renderLine = (m: InboxMessageView) => (
    <Text>
      {isUnread(m) ? cyan(UNREAD_MARKER) : " "}
      {`  ${localDate(m.createdAt)}  ${m.kind.padEnd(kindWidth)}  ${m.title}`}
    </Text>
  );
  const renderPreview = (m: InboxMessageView, _detail: unknown, w: number) => {
    const innerWidth = previewInnerWidth(w);
    return (
      <Box flexDirection="column" marginLeft={1} width={innerWidth}>
        {inboxMessageLines(m, innerWidth).map((line, i) => (
          <Text key={i} wrap="truncate-end">{line}</Text>
        ))}
      </Box>
    );
  };

  const hasPreview = layout.previewHeight > 0;
  const promptContent = (
    <Box justifyContent="space-between" width={width}>
      <Box>
        <Text color="cyan" bold>
          {">"}
          {" "}
        </Text>
        <Text>{query}</Text>
        <Text color="gray">{CURSOR}</Text>
      </Box>
      <Text dimColor>
        {results.length} / {items.length}
      </Text>
    </Box>
  );
  const resultsContent = (
    <Box flexDirection="column">
      {results.length === 0
        ? (
          <Box paddingLeft={1}>
            <Text color="yellow">No matching messages found</Text>
          </Box>
        )
        : (
          <ResultsList
            visibleItems={visibleItems.map((r) => r.item)}
            selectedIndex={selectedIndex}
            scrollMetrics={scrollMetrics}
            renderLine={renderLine}
            width={layout.resultsWidth}
          />
        )}
      {loadingOlder && (
        <Box paddingLeft={2}>
          <Text dimColor>loading older messages…</Text>
        </Box>
      )}
    </Box>
  );
  const previewContent = hasPreview
    ? (
      <PreviewPane
        item={highlighted}
        detail={undefined}
        width={layout.previewWidth}
        height={layout.previewHeight}
        scrollOffset={scrollOffset}
        renderPreview={renderPreview}
      />
    )
    : <Box />;
  const helpContent = bottomLine(inboxListKeys(hasPreview, query !== ""));

  if (layout.tier === "bordered-split") {
    return (
      <BorderedSplitLayout
        width={width}
        resultsWidth={layout.resultsWidth}
        previewWidth={layout.previewWidth}
        contentHeight={layout.resultsHeight}
        commandName={COMMAND_NAME}
        promptContent={promptContent}
        resultsContent={resultsContent}
        previewContent={previewContent}
        helpContent={helpContent}
      />
    );
  }
  if (layout.tier === "stacked") {
    return (
      <StackedLayout
        width={width}
        resultsHeight={layout.resultsHeight}
        previewHeight={layout.previewHeight}
        commandName={COMMAND_NAME}
        promptContent={promptContent}
        resultsContent={resultsContent}
        previewContent={previewContent}
        helpContent={helpContent}
      />
    );
  }
  // A small terminal: the prompt, the rows and the help bar, no borders.
  return (
    <Box flexDirection="column" width={width}>
      {promptContent}
      <Box flexDirection="column" marginTop={1} overflow="hidden">
        {resultsContent}
      </Box>
      <Box marginTop={1}>{helpContent}</Box>
    </Box>
  );
}

/** How the inbox reaches Swamp Club while it is open. */
export interface InboxTuiRendererOptions {
  markSession: InboxMarkSession;
  /** Loads the page older than `cursor`, giving up when `signal` aborts. */
  loadOlder: (cursor: string, signal: AbortSignal) => Promise<InboxBrowseView>;
}

/**
 * Runs the inbox over the first page, then, once it has closed, waits for
 * the marks still in flight and prints what was read and marked.
 */
class InkInboxTuiRenderer implements Renderer<InboxBrowseEvent> {
  constructor(private readonly options: InboxTuiRendererOptions) {}

  handlers(): EventHandlers<InboxBrowseEvent> {
    return {
      loading_credentials: () => {},
      contacting_server: () => {},
      completed: async ({ view }) => {
        const warning = droppedWarning(view.dropped);
        // stderr, and before the inbox, so it is on screen once it closes.
        if (warning) console.error(yellow(warning));
        if (view.messages.length === 0) {
          writeOutput("Your inbox is empty.");
          return;
        }
        await this.run(view);
      },
      error: (e) => {
        throw userErrorFromSwampError(e.error);
      },
    };
  }

  private async run(view: InboxBrowseView): Promise<void> {
    const connection = connectInboxTui(this.options);
    const isTTY = Deno.stdout.isTerminal();
    // The alternate screen keeps the inbox out of the scrollback.
    if (isTTY) Deno.stdout.writeSync(new TextEncoder().encode("\x1b[?1049h"));
    const cleanupTty = suppressInkTtyErrors();
    try {
      const { waitUntilExit } = render(
        <InboxTui
          initial={view}
          backend={connection.backend}
          onQuit={() => {}}
        />,
        { exitOnCtrlC: false },
      );
      await waitUntilExit();
    } finally {
      cleanupTty();
      if (isTTY) {
        Deno.stdout.writeSync(new TextEncoder().encode("\x1b[?1049l"));
      }
    }
    const line = await connection.close();
    if (line !== undefined) writeOutput(line);
  }
}

/** The inbox's backend, and how to settle it once the inbox has closed. */
export interface InboxTuiConnection {
  backend: InboxTuiBackend;
  /**
   * Stops page loads, waits for the marks still in flight (the session
   * bounds the wait and refreshes the cache), and returns the quit line.
   */
  close(): Promise<string | undefined>;
}

/** Connects the inbox to Swamp Club, counting what Swamp Club confirms. */
export function connectInboxTui(
  options: InboxTuiRendererOptions,
): InboxTuiConnection {
  const { markSession, loadOlder } = options;
  const loads = new AbortController();
  // Every request the inbox made, settled, so none outlives the command.
  const pending: Promise<void>[] = [];
  const track = <T,>(promise: Promise<T>): Promise<T> => {
    pending.push(promise.then(() => {}, () => {}));
    return promise;
  };
  const tally = { read: 0, marked: 0 };
  return {
    backend: {
      markRead: (ids, reason) =>
        track(
          markSession.mark(ids).then((outcome) => {
            if (outcome.kind === "confirmed") {
              tally[reason] += outcome.ids.length;
            }
            return outcome;
          }),
        ),
      loadOlder: (cursor) => track(loadOlder(cursor, loads.signal)),
    },
    close: async () => {
      loads.abort();
      await markSession.finish();
      await Promise.all(pending);
      return inboxQuitLine(tally.read, tally.marked);
    },
  };
}

export function createInboxTuiRenderer(
  options: InboxTuiRendererOptions,
): Renderer<InboxBrowseEvent> {
  return new InkInboxTuiRenderer(options);
}
