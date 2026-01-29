// deno-lint-ignore-file verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import type { ActivePanel } from "./execution_reducer.ts";

interface HotkeyBarProps {
  isComplete: boolean;
  showYamlOverlay: boolean;
  activePanel: ActivePanel;
}

/**
 * Displays keyboard hints at the bottom of the UI.
 */
export function HotkeyBar(
  { isComplete, showYamlOverlay, activePanel }: HotkeyBarProps,
): React.ReactElement {
  if (showYamlOverlay) {
    return (
      <Box paddingX={1} flexShrink={0}>
        <Text dimColor>Esc: Close | ↑/↓: Scroll</Text>
      </Box>
    );
  }

  const navHint = activePanel === "jobs"
    ? "↑/↓: Select Job"
    : "↑/↓: Select Step";

  const hints = ["Tab: Switch Panel", navHint, "l: View YAML"];

  if (isComplete) {
    return (
      <Box paddingX={1} flexShrink={0}>
        <Text dimColor>{hints.join(" | ")} |</Text>
        <Text color="green" bold>q: Quit</Text>
      </Box>
    );
  }

  return (
    <Box paddingX={1} flexShrink={0}>
      <Text dimColor>{hints.join(" | ")}</Text>
    </Box>
  );
}
