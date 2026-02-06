// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, render, Text } from "ink";
import type { OutputMode } from "./output.tsx";

/**
 * Version information for data.
 */
export interface DataVersionInfo {
  version: number;
  createdAt: string;
  size?: number;
  checksum?: string;
  isLatest: boolean;
}

/**
 * Data structure for the data versions output.
 */
export interface DataVersionsData {
  dataName: string;
  modelId: string;
  modelName: string;
  modelType: string;
  versions: DataVersionInfo[];
  total: number;
}

/**
 * Renders the data versions output in either interactive or JSON mode.
 */
export function renderDataVersions(
  data: DataVersionsData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveDataVersions(data);
  }
}

function renderInteractiveDataVersions(data: DataVersionsData): void {
  const instance = render(<DataVersionsDisplay data={data} />);
  instance.unmount();
}

interface DataVersionsDisplayProps {
  data: DataVersionsData;
}

/**
 * Formats bytes into human-readable size.
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

/**
 * Interactive display component for data versions.
 */
export function DataVersionsDisplay(
  props: DataVersionsDisplayProps,
): React.ReactElement {
  const { data } = props;

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Text color="green" bold>
        # Versions of {data.dataName}
      </Text>
      <Box marginLeft={2}>
        <Text dimColor>Model: {data.modelName} ({data.modelType})</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>Total versions: {data.total}</Text>
      </Box>

      {/* Versions list */}
      <Box marginTop={1} flexDirection="column">
        <Text color="cyan" bold>
          ## Versions
        </Text>
        <Box marginTop={1} marginLeft={2} flexDirection="column">
          {data.versions.map((version) => (
            <Box key={version.version} marginBottom={1}>
              <Text>
                <Text color="yellow">v{version.version}</Text>
                {version.isLatest && (
                  <Text color="green" bold>
                    {" "}
                    (latest)
                  </Text>
                )}
              </Text>
              <Text dimColor>
                {" "}
                • {version.createdAt}
                {version.size !== undefined &&
                  ` • ${formatBytes(version.size)}`}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>

      {/* Empty state */}
      {data.total === 0 && (
        <Box marginTop={1}>
          <Text dimColor>(no versions found)</Text>
        </Box>
      )}
    </Box>
  );
}
