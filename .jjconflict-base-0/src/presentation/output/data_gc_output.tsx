// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import type { OutputMode } from "./output.tsx";
import type {
  ExpiredDataInfo,
  LifecycleGCResult,
} from "../../domain/data/data_lifecycle_service.ts";

/**
 * Format bytes to human-readable size.
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${units[i]}`;
}

/**
 * Renders the preview of expired data before confirmation.
 */
export function renderDataGCPreview(
  expiredData: ExpiredDataInfo[],
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(
      {
        expiredDataCount: expiredData.length,
        expiredData: expiredData.map((item) => ({
          type: item.type.toDirectoryPath(),
          modelId: item.modelId,
          dataName: item.dataName,
          reason: item.reason,
        })),
      },
      null,
      2,
    ));
  } else {
    const { lastFrame } = render(
      <DataGCPreviewDisplay expiredData={expiredData} />,
    );
    console.log(lastFrame());
  }
}

function DataGCPreviewDisplay(
  { expiredData }: { expiredData: ExpiredDataInfo[] },
): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="yellow">
        Found {expiredData.length} expired data entries:
      </Text>
      <Box marginLeft={2} flexDirection="column">
        {expiredData.slice(0, 10).map((item, i) => (
          <Text key={i} dimColor>
            • {item.type.toDirectoryPath()}/{item.modelId}/{item.dataName}{" "}
            ({item.reason})
          </Text>
        ))}
        {expiredData.length > 10 && (
          <Text dimColor>... and {expiredData.length - 10} more</Text>
        )}
      </Box>
    </Box>
  );
}

/**
 * Renders the result of garbage collection.
 */
export function renderDataGC(data: LifecycleGCResult, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(
      {
        dataEntriesExpired: data.dataEntriesExpired,
        versionsDeleted: data.versionsDeleted,
        bytesReclaimed: data.bytesReclaimed,
        dryRun: data.dryRun,
        expiredEntries: data.expiredEntries,
      },
      null,
      2,
    ));
  } else {
    const { lastFrame } = render(<DataGCDisplay {...data} />);
    console.log(lastFrame());
  }
}

function DataGCDisplay(props: LifecycleGCResult): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="green">
        {props.dryRun
          ? "Dry run - would expire:"
          : "Garbage collection complete:"}
      </Text>
      <Box marginLeft={2} flexDirection="column">
        <Text>
          Data entries expired: {props.dataEntriesExpired}{" "}
          (latest symlink removed)
        </Text>
        <Text>Old versions pruned: {props.versionsDeleted}</Text>
        <Text>Disk space reclaimed: {formatBytes(props.bytesReclaimed)}</Text>
      </Box>
      {props.dataEntriesExpired > 0 && (
        <Box marginTop={1}>
          <Text dimColor>
            Note: Expired data versions remain on disk for audit/recovery
          </Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Renders the cancellation message.
 */
export function renderDataGCCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ cancelled: true }, null, 2));
  } else {
    const { lastFrame } = render(
      <Box>
        <Text color="yellow">Garbage collection cancelled.</Text>
      </Box>,
    );
    console.log(lastFrame());
  }
}
