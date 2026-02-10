// deno-lint-ignore-file verbatim-module-syntax
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTerminalSize } from "../../hooks/mod.ts";
import type {
  LogEntry,
  LogStreamService,
  LogStreamTarget,
} from "./LogStreamService.ts";

interface LogStreamOverlayProps {
  target: LogStreamTarget;
  logService: LogStreamService;
  onClose: () => void;
  isActive: boolean;
}

/**
 * Full-screen overlay for streaming logs from workflow steps/jobs.
 * Shows real-time log output with scrolling and controls.
 */
export function LogStreamOverlay(
  { target, logService, onClose, isActive }: LogStreamOverlayProps,
): React.ReactElement {
  const { width: terminalWidth, height: terminalHeight } = useTerminalSize();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const logsRef = useRef<LogEntry[]>([]);

  // Update ref when logs change
  useEffect(() => {
    logsRef.current = logs;
  }, [logs]);

  // Auto-scroll to bottom when new logs arrive (if auto-scroll is enabled)
  useEffect(() => {
    if (autoScroll && logs.length > 0) {
      const contentHeight = terminalHeight - 4; // Account for borders and header
      const totalLines = logs.length;
      if (totalLines > contentHeight) {
        setScrollOffset(totalLines - contentHeight);
      }
    }
  }, [logs, autoScroll, terminalHeight]);

  // Load initial logs and start streaming
  useEffect(() => {
    let streamActive = true;

    const loadAndStream = async () => {
      try {
        setIsLoading(true);
        setError(null);
        setIsLoading(false);

        // Always use streamLogs for all steps. It handles:
        // - Running/pending steps: continuous polling until complete
        // - Completed steps: reads all content + a final delayed read
        //   to catch fire-and-forget writes that haven't flushed yet
        const stream = logService.streamLogs(target);
        for await (const logEntry of stream) {
          if (!streamActive) break;
          setLogs((prevLogs) => [...prevLogs, logEntry]);
        }
      } catch (err) {
        if (streamActive) {
          setError(err instanceof Error ? err.message : String(err));
          setIsLoading(false);
        }
      }
    };

    loadAndStream();

    return () => {
      streamActive = false;
    };
  }, [target, logService]);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  // Handle keyboard input
  useInput(
    (input, key) => {
      if (key.escape || input === "q") {
        handleClose();
        return;
      }

      const contentHeight = terminalHeight - 4;
      const maxOffset = Math.max(0, logs.length - contentHeight);

      if (key.upArrow) {
        setAutoScroll(false);
        setScrollOffset((prev) => Math.max(0, prev - 1));
        return;
      }

      if (key.downArrow) {
        setScrollOffset((prev) => {
          const newOffset = Math.min(maxOffset, prev + 1);
          // Re-enable auto-scroll if we're at the bottom
          if (newOffset === maxOffset) {
            setAutoScroll(true);
          }
          return newOffset;
        });
        return;
      }

      if (key.pageUp) {
        setAutoScroll(false);
        setScrollOffset((prev) => Math.max(0, prev - contentHeight));
        return;
      }

      if (key.pageDown) {
        setScrollOffset((prev) => {
          const newOffset = Math.min(maxOffset, prev + contentHeight);
          if (newOffset === maxOffset) {
            setAutoScroll(true);
          }
          return newOffset;
        });
        return;
      }

      // Note: Home and End keys might not be available in all terminals
      // Commenting out for now to fix TypeScript errors
      // if (key.home) {
      //   setAutoScroll(false);
      //   setScrollOffset(0);
      //   return;
      // }

      // if (key.end) {
      //   setAutoScroll(true);
      //   setScrollOffset(maxOffset);
      //   return;
      // }
    },
    { isActive },
  );

  // Calculate visible logs
  const contentHeight = terminalHeight - 4; // Account for borders and header
  const visibleLogs = logs.slice(scrollOffset, scrollOffset + contentHeight);

  // Format target name for display
  const targetName = target.type === "step"
    ? `${target.jobName}/${target.stepName}`
    : target.jobName;

  return (
    <Box
      flexDirection="column"
      width={terminalWidth}
      height={terminalHeight}
      borderStyle="round"
      borderColor="cyan"
    >
      {/* Header */}
      <Box flexShrink={0} paddingX={1}>
        <Text bold color="cyan">Logs: {targetName}</Text>
        <Box flexGrow={1} />
        {logs.length > 0 && (
          <Text dimColor>
            [{Math.min(scrollOffset + 1, logs.length)}-{Math.min(
              scrollOffset + contentHeight,
              logs.length,
            )}/{logs.length}]
          </Text>
        )}
        {autoScroll && <Text color="yellow">[AUTO]</Text>}
      </Box>

      {/* Content */}
      <Box
        flexDirection="column"
        flexGrow={1}
        paddingX={1}
        overflow="hidden"
      >
        {isLoading && (
          <Box justifyContent="center" alignItems="center" height="100%">
            <Text color="yellow">Loading logs...</Text>
          </Box>
        )}

        {error && (
          <Box justifyContent="center" alignItems="center" height="100%">
            <Text color="red">Error: {error}</Text>
          </Box>
        )}

        {!isLoading && !error && logs.length === 0 && (
          <Box justifyContent="center" alignItems="center" height="100%">
            <Text dimColor>No logs available</Text>
          </Box>
        )}

        {!isLoading && !error && logs.length > 0 &&
          visibleLogs.map((entry, index) => (
            <Box key={scrollOffset + index} flexShrink={0}>
              <Text>
                {entry.timestamp
                  ? `[${
                    entry.timestamp.toISOString().slice(11, 23)
                  }] ${entry.message}`
                  : entry.message}
              </Text>
            </Box>
          ))}
      </Box>

      {/* Footer with controls */}
      <Box
        flexShrink={0}
        paddingX={1}
        borderTop
        borderStyle="single"
        borderColor="gray"
      >
        <Text dimColor>
          ↑/↓: Scroll | PgUp/PgDn: Page | q/Esc: Close
        </Text>
      </Box>
    </Box>
  );
}
