import type { TelemetryEntry } from "./telemetry_entry.ts";

/**
 * Port for sending telemetry events to a remote endpoint.
 * Implemented by infrastructure adapters (e.g. HttpTelemetrySender).
 */
export interface TelemetrySender {
  /**
   * Sends a batch of telemetry entries to the remote endpoint.
   *
   * @param entries - The entries to send
   * @param distinctId - The repo UUID used as distinct_id
   * @returns true if the batch was accepted, false otherwise
   */
  sendBatch(entries: TelemetryEntry[], distinctId: string): Promise<boolean>;
}
