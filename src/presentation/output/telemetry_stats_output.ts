import type { OutputMode } from "./output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { TelemetryStats } from "../../domain/telemetry/telemetry_service.ts";

const logger = getSwampLogger(["telemetry", "stats"]);

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
    console.log(JSON.stringify(data, null, 2));
  }
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
    logger.info("No telemetry data found.");
  }
}
