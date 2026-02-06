// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import type { OutputMode } from "./output.tsx";
import type { TelemetryStats } from "../../domain/telemetry/telemetry_service.ts";

/**
 * Data for telemetry stats output.
 */
export interface TelemetryStatsData extends TelemetryStats {}

/**
 * Renders telemetry statistics.
 */
export function renderTelemetryStats(
  data: TelemetryStatsData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const { lastFrame } = render(<TelemetryStatsDisplay {...data} />);
    console.log(lastFrame());
  }
}

function TelemetryStatsDisplay(props: TelemetryStatsData): React.ReactElement {
  // Sort commands by frequency (descending)
  const topCommands = Object.entries(props.commandFrequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Sort options by frequency (descending)
  const topOptions = Object.entries(props.optionFrequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Telemetry Statistics (last {props.daysAnalyzed} days)
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Overview</Text>
        <Box marginLeft={2} flexDirection="column">
          <Text>Total invocations: {props.totalInvocations}</Text>
          <Text color="green">
            Success: {props.successCount} ({props.successRate.toFixed(1)}%)
          </Text>
          <Text color="red">
            Errors: {props.errorCount + props.userErrorCount} (
            {props.errorRate.toFixed(1)}%)
          </Text>
          {props.userErrorCount > 0 && (
            <Box marginLeft={2}>
              <Text dimColor>User errors: {props.userErrorCount}</Text>
            </Box>
          )}
        </Box>
      </Box>

      {topCommands.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Top Commands</Text>
          <Box marginLeft={2} flexDirection="column">
            {topCommands.map(([command, count], i) => {
              const avgDuration = props.averageDurationByCommand[command];
              return (
                <Text key={i}>
                  {command}: {count}
                  {avgDuration !== undefined && (
                    <Text dimColor>(avg: {avgDuration}ms)</Text>
                  )}
                </Text>
              );
            })}
          </Box>
        </Box>
      )}

      {topOptions.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Top Options</Text>
          <Box marginLeft={2} flexDirection="column">
            {topOptions.map(([option, count], i) => (
              <Text key={i}>
                {option}: {count}
              </Text>
            ))}
          </Box>
        </Box>
      )}

      {Object.keys(props.platformDistribution).length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Platforms</Text>
          <Box marginLeft={2} flexDirection="column">
            {Object.entries(props.platformDistribution).map(
              ([platform, count], i) => (
                <Text key={i}>
                  {platform}: {count}
                </Text>
              ),
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}

/**
 * Renders empty telemetry message.
 */
export function renderNoTelemetry(mode: OutputMode): void {
  if (mode === "json") {
    console.log(
      JSON.stringify({ message: "No telemetry data found" }, null, 2),
    );
  } else {
    const { lastFrame } = render(
      <Box>
        <Text color="yellow">No telemetry data found.</Text>
      </Box>,
    );
    console.log(lastFrame());
  }
}
