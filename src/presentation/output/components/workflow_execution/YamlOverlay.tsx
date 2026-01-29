// deno-lint-ignore-file verbatim-module-syntax
import React, { useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import {
  getTokenColor,
  type HighlightedLine,
  highlightYaml,
} from "./yaml_highlighter.ts";

interface YamlOverlayProps {
  yaml: string;
  workflowName: string;
  onClose: () => void;
  isActive?: boolean;
}

/**
 * Fullscreen YAML viewer overlay with syntax highlighting and scrolling.
 */
export function YamlOverlay(
  { yaml, workflowName, onClose, isActive = true }: YamlOverlayProps,
): React.ReactElement {
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows ?? 24;
  const terminalWidth = stdout?.columns ?? 80;

  // Reserve space for header (3 lines) and footer (2 lines)
  const contentHeight = Math.max(terminalHeight - 5, 5);

  const highlightedLines = highlightYaml(yaml);
  const totalLines = highlightedLines.length;
  const maxScroll = Math.max(0, totalLines - contentHeight);

  const [scrollOffset, setScrollOffset] = useState(0);

  useInput((input, key) => {
    if (key.escape || input === "l") {
      onClose();
      return;
    }

    if (key.upArrow) {
      setScrollOffset((s) => Math.max(0, s - 1));
      return;
    }

    if (key.downArrow) {
      setScrollOffset((s) => Math.min(maxScroll, s + 1));
      return;
    }

    // Page up/down
    if (key.pageUp) {
      setScrollOffset((s) => Math.max(0, s - contentHeight));
      return;
    }

    if (key.pageDown) {
      setScrollOffset((s) => Math.min(maxScroll, s + contentHeight));
      return;
    }
  }, { isActive });

  const visibleLines = highlightedLines.slice(
    scrollOffset,
    scrollOffset + contentHeight,
  );

  return (
    <Box
      flexDirection="column"
      width={terminalWidth}
      height={terminalHeight}
      borderStyle="round"
      borderColor="cyan"
    >
      {/* Header */}
      <Box
        paddingX={1}
        borderStyle="single"
        borderBottom
        borderTop={false}
        borderLeft={false}
        borderRight={false}
      >
        <Text bold color="cyan">YAML:</Text>
        <Text>{workflowName}</Text>
        <Box flexGrow={1} />
        <Text dimColor>
          {scrollOffset + 1}-{Math.min(
            scrollOffset + contentHeight,
            totalLines,
          )}/{totalLines}
        </Text>
      </Box>

      {/* Content */}
      <Box flexDirection="column" flexGrow={1} paddingX={1} overflowY="hidden">
        {visibleLines.map((line, i) => (
          <HighlightedLineDisplay key={scrollOffset + i} line={line} />
        ))}
      </Box>

      {/* Footer */}
      <Box
        paddingX={1}
        borderStyle="single"
        borderTop
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
      >
        <Text dimColor>Esc/l: Close | ↑/↓: Scroll | PgUp/PgDn: Page</Text>
      </Box>
    </Box>
  );
}

interface HighlightedLineDisplayProps {
  line: HighlightedLine;
}

function HighlightedLineDisplay(
  { line }: HighlightedLineDisplayProps,
): React.ReactElement {
  return (
    <Text>
      {line.tokens.map((token, i) => (
        <Text key={i} color={getTokenColor(token.type)}>
          {token.text}
        </Text>
      ))}
    </Text>
  );
}
