// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, render, Text } from "ink";
import type { OutputMode } from "./output.tsx";

/**
 * Data item in the list.
 */
export interface DataListItem {
  id: string;
  name: string;
  version: number;
  contentType: string;
  type: string; // The type tag value
  streaming: boolean;
  size?: number;
  createdAt: string;
}

/**
 * Data grouped by tag type.
 */
export interface DataGroupedByType {
  type: string;
  items: DataListItem[];
}

/**
 * Data structure for the data list output.
 */
export interface DataListData {
  modelId: string;
  modelName: string;
  modelType: string;
  groups: DataGroupedByType[];
  total: number;
}

/**
 * Renders the data list output in either interactive or JSON mode.
 */
export function renderDataList(data: DataListData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveDataList(data);
  }
}

function renderInteractiveDataList(data: DataListData): void {
  const instance = render(<DataListDisplay data={data} />);
  instance.unmount();
}

interface DataListDisplayProps {
  data: DataListData;
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
 * Interactive display component for data list.
 */
export function DataListDisplay(
  props: DataListDisplayProps,
): React.ReactElement {
  const { data } = props;

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Text color="green" bold>
        # Data for {data.modelName}
      </Text>
      <Box marginLeft={2}>
        <Text dimColor>Model Type: {data.modelType}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>Total: {data.total} data items</Text>
      </Box>

      {/* Groups */}
      {data.groups.map((group) => (
        <Box key={group.type} flexDirection="column" marginTop={1}>
          <Text color="cyan" bold>
            ## {group.type} ({group.items.length})
          </Text>
          <Box marginTop={1} marginLeft={2} flexDirection="column">
            {group.items.map((item) => (
              <Box key={item.id} flexDirection="column" marginBottom={1}>
                <Text>
                  <Text color="yellow">{item.name}</Text>
                  <Text dimColor>v{item.version}</Text>
                  {item.streaming && <Text color="blue">[streaming]</Text>}
                </Text>
                <Box marginLeft={2}>
                  <Text dimColor>
                    {item.contentType}
                    {item.size !== undefined && ` • ${formatBytes(item.size)}`}
                  </Text>
                </Box>
              </Box>
            ))}
          </Box>
        </Box>
      ))}

      {/* Empty state */}
      {data.total === 0 && (
        <Box marginTop={1}>
          <Text dimColor>(no data found)</Text>
        </Box>
      )}
    </Box>
  );
}
