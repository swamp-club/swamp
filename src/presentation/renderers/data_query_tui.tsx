// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import React, { useCallback, useMemo, useRef, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import type { DataQueryData, DataQueryDeps } from "../../libswamp/mod.ts";
import { suppressInkTtyErrors } from "../output/ink_lifecycle.ts";
import { useTerminalSize } from "../output/hooks/useTerminalSize.ts";
import { BrandLine } from "./components/picker_borders.tsx";
import {
  CelInput,
  deleteBeforeCursor,
  insertAtCursor,
} from "./data_query_tui/cel_input.tsx";
import { AutocompleteDropdown } from "./data_query_tui/autocomplete_dropdown.tsx";
import { useDebouncedQuery } from "./data_query_tui/hooks/use_debounced_query.ts";
import { computeQueryTuiLayout } from "./data_query_tui/layout.ts";
import {
  AutocompleteProvider,
  type CompletionItem,
} from "../../domain/data/autocomplete_provider.ts";
import { determineCursorContext } from "../../domain/data/cel_cursor_context.ts";
import { renderQueryResultsMarkdown } from "./data_query.ts";
import { renderMarkdownToTerminal } from "../markdown_renderer.ts";

/**
 * Dependencies for the interactive query TUI.
 */
export interface InteractiveQueryDeps {
  queryDeps: DataQueryDeps;
  distinctFn: (column: string) => string[];
  tagKeysFn: () => string[];
  tagValuesFn: (key: string) => string[];
}

interface InputState {
  text: string;
  cursorPos: number;
}

/** Width of the input label prefix: "  " + label.padEnd(7) = 9 chars. */
const INPUT_LABEL_WIDTH = 9;

function buildCliCommand(
  pred: string,
  sel: string,
  limit: string,
): string {
  const esc = (s: string) => s.replace(/'/g, "'\\''");
  const parts = ["swamp data query"];
  if (pred.trim()) parts.push(`'${esc(pred.trim())}'`);
  if (sel.trim()) parts.push(`--select '${esc(sel.trim())}'`);
  const parsedLimit = parseInt(limit, 10);
  if (parsedLimit && parsedLimit !== 100) {
    parts.push(`--limit ${parsedLimit}`);
  }
  return parts.join(" ");
}

function DataQueryTUI(
  props: {
    deps: InteractiveQueryDeps;
    onExit: (scrollback: string | undefined) => void;
  },
): React.ReactElement {
  const { deps, onExit } = props;
  const { exit } = useApp();
  const lastRenderedOutput = useRef<string | undefined>(undefined);
  const { width, height } = useTerminalSize();

  // Input state
  const [predicate, setPredicate] = useState<InputState>({
    text: "",
    cursorPos: 0,
  });
  const [select, setSelect] = useState<InputState>({
    text: "",
    cursorPos: 0,
  });
  const [limitInput, setLimitInput] = useState<InputState>({
    text: "100",
    cursorPos: 3,
  });
  const [focusedInput, setFocusedInput] = useState<
    "predicate" | "select" | "limit"
  >(
    "predicate",
  );

  // UI state
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [resultsScrollOffset, setResultsScrollOffset] = useState(0);
  const [horizontalScrollOffset, setHorizontalScrollOffset] = useState(0);

  // Parse limit — default to 100 if invalid
  const parsedLimit = Math.max(1, parseInt(limitInput.text, 10) || 100);

  // Query execution
  const queryState = useDebouncedQuery(
    predicate.text,
    select.text || undefined,
    deps.queryDeps,
    150,
    parsedLimit,
  );

  // Autocomplete
  const autocompleteProvider = useMemo(
    () =>
      new AutocompleteProvider(
        deps.distinctFn,
        deps.tagKeysFn,
        deps.tagValuesFn,
      ),
    [deps.distinctFn, deps.tagKeysFn, deps.tagValuesFn],
  );

  const activeInput = focusedInput === "predicate"
    ? predicate
    : focusedInput === "select"
    ? select
    : limitInput;
  const cursorContext = useMemo(
    () =>
      focusedInput !== "limit"
        ? determineCursorContext(activeInput.text, activeInput.cursorPos)
        : { kind: "unknown" as const },
    [activeInput.text, activeInput.cursorPos, focusedInput],
  );

  const completions = useMemo(
    () =>
      focusedInput !== "limit"
        ? autocompleteProvider.complete(cursorContext, focusedInput)
        : [],
    [cursorContext, focusedInput],
  );

  const autocompleteOpen = completions.length > 0;
  const visibleCompletions = autocompleteOpen
    ? Math.min(completions.length, 8)
    : 0;

  // Count error lines (full multi-line error)
  const errorText = queryState.error;
  const errorLines = errorText ? errorText.split("\n").length : 0;

  // Layout — accounts for variable autocomplete + error heights
  const layout = computeQueryTuiLayout(
    width,
    height,
    visibleCompletions,
    errorLines,
  );

  // Render results using the same markdown pipeline as the non-interactive CLI
  const queryData: DataQueryData | undefined = queryState.total > 0 ||
      queryState.results.length > 0
    ? {
      predicate: predicate.text,
      select: select.text || undefined,
      results: queryState.results,
      projected: queryState.projected,
      total: queryState.total,
      limited: queryState.limited,
    }
    : undefined;

  const renderedMarkdown = useMemo(
    () => queryData ? renderQueryResultsMarkdown(queryData) : undefined,
    [
      queryData?.total,
      queryData?.projected,
      queryData?.results,
      queryData?.limited,
    ],
  );

  const renderedTerminal = useMemo(
    () =>
      renderedMarkdown ? renderMarkdownToTerminal(renderedMarkdown) : undefined,
    [renderedMarkdown],
  );

  // Keep track of last rendered output for scrollback on exit
  if (renderedTerminal) {
    lastRenderedOutput.current = renderedTerminal;
  }

  // Split rendered output into lines for scrollable display
  const outputLines = useMemo(
    () => renderedTerminal ? renderedTerminal.split("\n") : [],
    [renderedTerminal],
  );

  const totalResultRows = outputLines.length;

  const setActiveInput = useCallback(
    (state: InputState) => {
      if (focusedInput === "predicate") {
        setPredicate(state);
      } else if (focusedInput === "select") {
        setSelect(state);
      } else {
        setLimitInput(state);
      }
    },
    [focusedInput],
  );

  const acceptCompletion = useCallback(
    (item: CompletionItem) => {
      const ctx = cursorContext;
      const input = activeInput;

      let replaceStart = input.cursorPos;
      const replaceEnd = input.cursorPos;
      let insertText = item.text;

      if (ctx.kind === "root") {
        replaceStart = input.cursorPos - ctx.prefix.length;
      } else if (ctx.kind === "member") {
        replaceStart = input.cursorPos - ctx.prefix.length;
      } else if (ctx.kind === "value") {
        replaceStart = input.cursorPos - ctx.prefix.length;
        // If there's an opening quote before the prefix, include it
        if (
          replaceStart > 0 &&
          (input.text[replaceStart - 1] === '"' ||
            input.text[replaceStart - 1] === "'")
        ) {
          replaceStart--;
        }
      } else if (ctx.kind === "operator") {
        // Insert after space
        insertText = item.text;
      }

      const newText = input.text.slice(0, replaceStart) + insertText +
        input.text.slice(replaceEnd);
      const newCursorPos = replaceStart + insertText.length;

      setActiveInput({ text: newText, cursorPos: newCursorPos });
      setAutocompleteIndex(0);
    },
    [cursorContext, activeInput, setActiveInput],
  );

  // Key handling
  useInput((input, key) => {
    // Esc
    if (key.escape) {
      const cmd = buildCliCommand(
        predicate.text,
        select.text,
        limitInput.text,
      );
      const scrollback = lastRenderedOutput.current
        ? `${cmd}\n\n${lastRenderedOutput.current}`
        : undefined;
      onExit(scrollback);
      exit();
      return;
    }

    // Ctrl-C
    if (key.ctrl && input === "c") {
      const cmd = buildCliCommand(
        predicate.text,
        select.text,
        limitInput.text,
      );
      const scrollback = lastRenderedOutput.current
        ? `${cmd}\n\n${lastRenderedOutput.current}`
        : undefined;
      onExit(scrollback);
      exit();
      return;
    }

    // Tab: always switch fields (Enter handles autocomplete acceptance)
    if (key.tab) {
      setFocusedInput((prev) =>
        prev === "predicate"
          ? "select"
          : prev === "select"
          ? "limit"
          : "predicate"
      );
      return;
    }

    // Up/Down: autocomplete navigation only
    if (key.upArrow) {
      if (autocompleteOpen) {
        setAutocompleteIndex((prev) => Math.max(0, prev - 1));
      }
      return;
    }
    if (key.downArrow) {
      if (autocompleteOpen) {
        setAutocompleteIndex((prev) =>
          Math.min(completions.length - 1, prev + 1)
        );
      }
      return;
    }

    // Ctrl-u/Ctrl-d: scroll results vertically half-page (matches SearchPicker)
    if (key.ctrl && input === "u") {
      const halfPage = Math.max(1, Math.floor(layout.resultsHeight / 2));
      setResultsScrollOffset((prev) => Math.max(0, prev - halfPage));
      return;
    }
    if (key.ctrl && input === "d") {
      const halfPage = Math.max(1, Math.floor(layout.resultsHeight / 2));
      const maxScroll = Math.max(0, totalResultRows - layout.resultsHeight);
      setResultsScrollOffset((prev) => Math.min(maxScroll, prev + halfPage));
      return;
    }

    // Ctrl-left/Ctrl-right: pan results horizontally
    if (key.ctrl && key.leftArrow) {
      setHorizontalScrollOffset((prev) => Math.max(0, prev - 20));
      return;
    }
    if (key.ctrl && key.rightArrow) {
      setHorizontalScrollOffset((prev) => prev + 20);
      return;
    }

    // Enter
    if (key.return) {
      if (autocompleteOpen) {
        const item = completions[autocompleteIndex];
        if (item) acceptCompletion(item);
      }
      return;
    }

    // Left/Right
    if (key.leftArrow) {
      const current = activeInput;
      if (current.cursorPos > 0) {
        setActiveInput({ ...current, cursorPos: current.cursorPos - 1 });
      }
      return;
    }
    if (key.rightArrow) {
      const current = activeInput;
      if (current.cursorPos < current.text.length) {
        setActiveInput({ ...current, cursorPos: current.cursorPos + 1 });
      }
      return;
    }

    // Backspace/Delete
    if (key.backspace || key.delete) {
      const current = activeInput;
      const result = deleteBeforeCursor(current.text, current.cursorPos);
      setActiveInput(result);
      setAutocompleteIndex(0);
      setResultsScrollOffset(0);
      setHorizontalScrollOffset(0);
      return;
    }

    // Printable characters
    if (input && !key.ctrl && !key.meta) {
      // Limit field only accepts digits
      if (focusedInput === "limit" && !/^\d+$/.test(input)) return;
      const current = activeInput;
      const result = insertAtCursor(current.text, current.cursorPos, input);
      setActiveInput(result);
      setAutocompleteIndex(0);
      setResultsScrollOffset(0);
      setHorizontalScrollOffset(0);
    }
  });

  // Status text for the predicate input
  const statusText = queryState.isLoading
    ? "..."
    : queryState.total > 0
    ? `(${queryState.total} result${queryState.total !== 1 ? "s" : ""}, ${
      Math.round(queryState.elapsedMs)
    }ms)`
    : queryState.error
    ? ""
    : predicate.text.trim()
    ? "(0 results)"
    : "";

  // Compute autocomplete offset (label width + cursor position)
  const autocompleteOffsetLeft = INPUT_LABEL_WIDTH + predicate.cursorPos;

  return (
    <Box flexDirection="column" width={width} height={height}>
      <BrandLine width={width} commandName="data query" />

      <CelInput
        label="QUERY"
        text={predicate.text}
        cursorPos={predicate.cursorPos}
        focused={focusedInput === "predicate"}
        status={statusText}
      />

      {autocompleteOpen && focusedInput === "predicate" && (
        <AutocompleteDropdown
          items={completions}
          selectedIndex={autocompleteIndex}
          offsetLeft={autocompleteOffsetLeft}
        />
      )}

      <CelInput
        label="SELECT"
        text={select.text}
        cursorPos={select.cursorPos}
        focused={focusedInput === "select"}
      />

      {autocompleteOpen && focusedInput === "select" && (
        <AutocompleteDropdown
          items={completions}
          selectedIndex={autocompleteIndex}
          offsetLeft={INPUT_LABEL_WIDTH + select.cursorPos}
        />
      )}

      <CelInput
        label="LIMIT"
        text={limitInput.text}
        cursorPos={limitInput.cursorPos}
        focused={focusedInput === "limit"}
      />

      {errorText && (
        <Box paddingLeft={2}>
          <Text color="red">{errorText}</Text>
        </Box>
      )}

      <Text color="cyan">
        {"\u2500".repeat(width)}
      </Text>

      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {outputLines.length > 0
          ? (
            <Box
              flexDirection="column"
              paddingLeft={1}
              width={width}
              overflow="hidden"
            >
              {outputLines
                .slice(
                  resultsScrollOffset,
                  resultsScrollOffset + layout.resultsHeight,
                )
                .map((line, i) => (
                  <Box
                    key={resultsScrollOffset + i}
                    marginLeft={-horizontalScrollOffset}
                  >
                    <Text wrap="truncate-end">{line}</Text>
                  </Box>
                ))}
            </Box>
          )
          : (
            <Box paddingLeft={2}>
              <Text dimColor>
                {predicate.text.trim()
                  ? "No matching data found."
                  : "Type a CEL expression to query data."}
              </Text>
            </Box>
          )}
      </Box>

      <Text color="cyan">
        {"\u2500".repeat(width)}
      </Text>

      <Text dimColor>
        {`  Tab next field  \u2191\u2193 complete  Enter accept  Ctrl-u/d scroll  Ctrl-\u2190/\u2192 pan  Esc quit${
          queryState.limited ? "  [limit reached]" : ""
        }`}
      </Text>
    </Box>
  );
}

/**
 * Launches the interactive data query TUI.
 * Manages alt-screen buffer lifecycle following the same pattern as
 * renderInteractivePicker.
 */
export async function renderInteractiveQuery(
  deps: InteractiveQueryDeps,
): Promise<void> {
  const isTTY = Deno.stdout.isTerminal();
  let pendingScrollback: string | undefined;

  if (isTTY) {
    Deno.stdout.writeSync(new TextEncoder().encode("\x1b[?1049h"));
  }

  await new Promise<void>((resolve) => {
    const cleanupTty = suppressInkTtyErrors();
    const { waitUntilExit } = render(
      <DataQueryTUI
        deps={deps}
        onExit={(scrollback) => {
          pendingScrollback = scrollback;
        }}
      />,
    );
    waitUntilExit().then(() => {
      cleanupTty();
      resolve();
    }).catch(() => {
      cleanupTty();
      resolve();
    });
  });

  if (isTTY) {
    Deno.stdout.writeSync(new TextEncoder().encode("\x1b[?1049l"));
  }

  // Print the final rendered output to the terminal scrollback
  if (pendingScrollback) {
    console.log(pendingScrollback);
  }
}
