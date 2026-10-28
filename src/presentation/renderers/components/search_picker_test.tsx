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
import React, { useState } from "react";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "ink-testing-library";
import { Box, Text, useInput } from "ink";
import { waitFor } from "@swamp-club/swamp-testing";
import type { ActionDef } from "./help_bar.tsx";
import { SearchPicker } from "./search_picker.tsx";
import { pressOnFrame } from "./press_on_frame_test_helpers.ts";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

function tick(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Minimal component that mirrors the SearchPicker's action-key logic in
 * isolation, avoiding the full fzf/layout/preview stack so we can directly
 * observe what useInput receives for Ctrl+letter bytes.
 */
function ActionKeyProbe(props: {
  actions: ActionDef[];
  onAction: (action: string, input: string) => void;
  onChar: (ch: string) => void;
}) {
  const [query, setQuery] = useState("");
  useInput((input, key) => {
    if (key.escape || key.return) return;
    if (key.backspace || key.delete) return;

    if (props.actions && input && key.ctrl && !key.meta) {
      const action = props.actions.find((a) => a.key === input);
      if (action) {
        props.onAction(action.action, input);
        return;
      }
    }

    if (input && !key.ctrl && !key.meta) {
      setQuery((q) => q + input);
      props.onChar(input);
    }
  });

  return (
    <Box>
      <Text>query:{query}</Text>
    </Box>
  );
}

Deno.test({
  name:
    "SearchPicker: Ctrl+letter triggers action via useInput (isolated probe)",
  ...inkTestOptions,
  fn: async () => {
    let firedAction: string | undefined;
    let firedInput: string | undefined;
    const chars: string[] = [];

    const { stdin, lastFrame } = render(
      <ActionKeyProbe
        actions={[{ key: "r", label: "Run", action: "run" }]}
        onAction={(action, input) => {
          firedAction = action;
          firedInput = input;
        }}
        onChar={(ch) => chars.push(ch)}
      />,
    );

    await tick();
    // Ctrl+r = byte 0x12
    stdin.write("\x12");
    await tick();

    assertEquals(firedAction, "run");
    assertEquals(firedInput, "r");
    assertEquals(chars.length, 0);

    // Verify the query didn't get the character
    const frame = lastFrame() ?? "";
    assertStringIncludes(frame, "query:");
  },
});

Deno.test({
  name: "SearchPicker: plain letter does NOT trigger action (isolated probe)",
  ...inkTestOptions,
  fn: async () => {
    let firedAction: string | undefined;
    const chars: string[] = [];

    const { stdin, lastFrame } = render(
      <ActionKeyProbe
        actions={[{ key: "r", label: "Run", action: "run" }]}
        onAction={(action) => {
          firedAction = action;
        }}
        onChar={(ch) => chars.push(ch)}
      />,
    );

    await tick();
    stdin.write("r");
    await tick();

    assertEquals(firedAction, undefined);
    assertEquals(chars, ["r"]);
    const frame = lastFrame() ?? "";
    assertStringIncludes(frame, "query:r");
  },
});

function renderPicker(
  initialIndex: number | undefined,
  onSelect: (item: string) => void,
) {
  return render(
    <SearchPicker<string>
      items={["alpha", "bravo", "charlie"]}
      initialQuery=""
      selector={(item) => item}
      renderResultLine={(item) => <Text>{item}</Text>}
      renderPreview={(item) => <Text>{item}</Text>}
      renderScrollback={(item) => item}
      itemLabel="items"
      initialIndex={initialIndex}
      onSelect={(item) => onSelect(item)}
      onCancel={() => {}}
    />,
  );
}

/** Presses Enter once the picker has drawn, and returns what it selected. */
async function enter(
  picker: ReturnType<typeof renderPicker>,
  selected: string[],
): Promise<string> {
  await waitFor(
    () => (picker.lastFrame() ?? "").includes("charlie"),
    "the picker to draw its rows",
  );
  picker.stdin.write("\r");
  await waitFor(() => selected.length > 0, "a selection");
  return selected[0];
}

Deno.test({
  name: "SearchPicker: initialIndex highlights that row first",
  ...inkTestOptions,
  fn: async () => {
    const selected: string[] = [];
    const picker = renderPicker(2, (item) => selected.push(item));

    assertEquals(await enter(picker, selected), "charlie");
  },
});

Deno.test({
  name: "SearchPicker: without initialIndex the first row is highlighted",
  ...inkTestOptions,
  fn: async () => {
    const selected: string[] = [];
    const picker = renderPicker(undefined, (item) => selected.push(item));

    assertEquals(await enter(picker, selected), "alpha");
  },
});

Deno.test({
  name: "SearchPicker: an initialIndex past the end highlights the last row",
  ...inkTestOptions,
  fn: async () => {
    const selected: string[] = [];
    const picker = renderPicker(9, (item) => selected.push(item));

    assertEquals(await enter(picker, selected), "charlie");
  },
});

Deno.test({
  name:
    "SearchPicker: typing a query moves the highlight back to the first match",
  ...inkTestOptions,
  fn: async () => {
    const selected: string[] = [];
    const picker = renderPicker(2, (item) => selected.push(item));

    await waitFor(
      () => (picker.lastFrame() ?? "").includes("charlie"),
      "the picker to draw its rows",
    );
    // "a" matches all three; the highlight must leave charlie for alpha.
    picker.stdin.write("a");
    await waitFor(
      () => (picker.lastFrame() ?? "").includes("a\u258F"),
      "the query to show",
    );
    picker.stdin.write("\r");
    await waitFor(() => selected.length > 0, "a selection");

    assertEquals(selected[0], "alpha");
  },
});

Deno.test({
  name:
    "SearchPicker: Enter pressed as the query frame is drawn selects the first match",
  ...inkTestOptions,
  fn: async () => {
    const selected: string[] = [];
    const picker = renderPicker(2, (item) => selected.push(item));

    await waitFor(
      () => (picker.lastFrame() ?? "").includes("charlie"),
      "the picker to draw its rows",
    );
    pressOnFrame(picker, (frame) => frame.includes("a\u258F"), "\r");
    picker.stdin.write("a");
    await waitFor(() => selected.length > 0, "a selection");

    assertEquals(selected[0], "alpha");
  },
});

Deno.test({
  name:
    "SearchPicker: Enter pressed as the moved highlight is drawn selects that row",
  ...inkTestOptions,
  fn: async () => {
    const selected: string[] = [];
    const picker = renderPicker(undefined, (item) => selected.push(item));

    await waitFor(
      () => (picker.lastFrame() ?? "").includes("charlie"),
      "the picker to draw its rows",
    );
    const frameCount = picker.frames.length;
    pressOnFrame(picker, () => picker.frames.length > frameCount, "\r");
    picker.stdin.write("\x1b[B");
    await waitFor(() => selected.length > 0, "a selection");

    assertEquals(selected[0], "bravo");
  },
});
