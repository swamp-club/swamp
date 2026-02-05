// deno-lint-ignore-file verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import type { ActivePanel } from "./execution_reducer.ts";

interface HotkeyBarProps {
  isComplete: boolean;
  showYamlOverlay: boolean;
  showLogOverlay: boolean;
  activePanel: ActivePanel;
}

/**
 * Displays keyboard hints at the bottom of the UI.
 */
export function HotkeyBar(
  { isComplete, showYamlOverlay, showLogOverlay, activePanel }: HotkeyBarProps,
): React.ReactElement {
  if (showYamlOverlay) {
    return (
      <Box paddingX={1} flexShrink={0}>
        <Text dimColor>Esc: Close | ↑/↓: Scroll</Text>
      </Box>
    );
  }

  if (showLogOverlay) {
    return (
      <Box paddingX={1} flexShrink={0}>
        <Text dimColor>↑/↓: Scroll | PgUp/PgDn: Page | q/Esc: Close</Text>
      </Box>
    );
  }

  const navHint = activePanel === "jobs"
    ? "↑/↓: Select Job"
    : "↑/↓: Select Step";

  const actionHint = activePanel === "steps" ? "Enter: View Logs" : "";
  const hints = ["Tab: Switch Panel", navHint, actionHint, "l: View YAML"]
    .filter(Boolean);

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
